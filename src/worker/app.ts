import { isSameOriginRequest } from '@freebuff/auth'
import type { FreebuffUser } from '@freebuff/auth'
import { Hono, type Handler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type {
  Activity,
  Claim,
  Draft,
  Evidence,
  FitResult,
  Icp,
  IcpFilters,
  ImportResult,
  LeadDetail,
  LeadStatus,
  LeadSummary,
  Message,
  Offer,
  Overview,
  ReplyItem,
  ReviewItem,
  Suppression,
} from '../shared/types'
import { LEAD_STATUSES } from '../shared/types'
import { appOrigin, currentUser, isLocalPreview, type Env } from './auth'
import { ensureSchema, recordAudit, recordUsage } from './db'
import { auditClaims, buildDraft, parseClaims } from './draft'
import {
  isSuppressed,
  normalizeDomain,
  normalizeEmail,
  verdictFrom,
  verifyEmail,
} from './email'
import { emptyFilters, normalizeFilters, parseBrief, scoreLead } from './score'
import { countryFromAddress, searchBusinesses } from './places'
import {
  leadIdFromAddress,
  mailReady,
  replyAddress,
  sendMail,
  verifyMailgunSignature,
} from './mail'
import { classifyReply } from './replies'

type AppContext = {
  Bindings: Env
  Variables: { user: FreebuffUser; db: D1Database }
}
type Authenticate = (request: Request, env: Env) => Promise<FreebuffUser | null>

type LeadRow = {
  id: string
  owner_sub: string
  status: string
  score: number | null
  score_json: string
  source: string
  created_at: number
  updated_at: number
  company_id: string
  company_name: string
  domain: string
  industry: string
  size: string
  country: string
  contact_id: string
  contact_name: string
  title: string
  email: string
  verdict: string
  checked_at: number | null
  evidence_count: number
  pending_drafts: number
}

const LEAD_SELECT = `
  SELECT l.id, l.owner_sub, l.status, l.score, l.score_json, l.source, l.created_at, l.updated_at,
    c.id AS company_id, c.name AS company_name, c.domain, c.industry, c.size, c.country,
    p.id AS contact_id, p.name AS contact_name, p.title, p.email, p.verdict, p.checked_at,
    (SELECT COUNT(*) FROM evidence e WHERE e.lead_id = l.id AND e.owner_sub = l.owner_sub) AS evidence_count,
    (SELECT COUNT(*) FROM drafts d WHERE d.lead_id = l.id AND d.owner_sub = l.owner_sub AND d.status = 'pending') AS pending_drafts
  FROM leads l
  JOIN companies c ON c.id = l.company_id AND c.owner_sub = l.owner_sub
  JOIN contacts p ON p.id = l.contact_id AND p.owner_sub = l.owner_sub`

const parseFit = (raw: string): FitResult | null => {
  try {
    const value = JSON.parse(raw) as FitResult
    return typeof value?.score === 'number' && typeof value.reason === 'string'
      ? value
      : null
  } catch {
    return null
  }
}

const mapLead = (row: LeadRow, suppressions: { value: string }[]): LeadSummary => {
  const email = row.email || ''
  const verification = email
    ? verifyEmail(email)
    : {
        verdict: 'unknown' as const,
        label: 'No address',
        detail: 'No email address is on file for this contact.',
        sendable: false,
      }
  return {
    id: row.id,
    company: {
      id: row.company_id,
      name: row.company_name,
      domain: row.domain,
      industry: row.industry,
      size: row.size,
      country: row.country,
    },
    contact: {
      id: row.contact_id,
      name: row.contact_name,
      title: row.title,
      email,
    },
    status: row.status as LeadStatus,
    score: row.score,
    fit: parseFit(row.score_json),
    source: row.source,
    evidenceCount: row.evidence_count,
    pendingDrafts: row.pending_drafts,
    verification,
    suppressed: isSuppressed(email, suppressions),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

type MessageRow = {
  id: string
  lead_id: string
  direction: string
  subject: string
  body: string
  from_email: string
  to_email: string
  status: string
  category: string | null
  positive: number
  confidence: number
  reason: string
  handled_at: number | null
  created_at: number
}

const mapMessage = (row: MessageRow): Message => ({
  id: row.id,
  leadId: row.lead_id,
  direction: row.direction === 'in' ? 'in' : 'out',
  subject: row.subject,
  body: row.body,
  fromEmail: row.from_email,
  toEmail: row.to_email,
  status:
    row.status === 'sent' || row.status === 'failed' ? row.status : 'received',
  category: row.category as Message['category'],
  positive: Boolean(row.positive),
  confidence: Number(row.confidence ?? 0),
  reason: row.reason,
  handled: Boolean(row.handled_at),
  createdAt: row.created_at,
})

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const extraKeys = (body: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(body).some((key) => !allowed.includes(key))

const text = (
  value: unknown,
  max: number,
  min = 1,
): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null
}

const optional = (value: unknown, max: number): string | null | undefined => {
  if (value === undefined || value === null || value === '') return ''
  return text(value, max, 0)
}

const id = (): string => crypto.randomUUID()

const STATUS_SET = new Set<string>(LEAD_STATUSES)

export function createApp(authenticate: Authenticate = currentUser) {
  const app = new Hono<AppContext>()
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    await next()
  })
  app.use('/api/*', async (c, next) => {
    if (
      c.req.path === '/api/import' ||
      c.req.path === '/api/webhooks/mailgun'
    )
      return next()
    return bodyLimit({
      maxSize: 32 * 1024,
      onError: (ctx) => ctx.json({ error: 'Request is too large.' }, 413),
    })(c, next)
  })

  app.get('/api/session', async (c) =>
    c.json({
      user: await authenticate(c.req.raw, c.env),
      mode: isLocalPreview(c.req.raw, c.env)
        ? 'local'
        : c.env.FREEBUFF_CLIENT_ID && c.env.APP_ORIGIN
          ? 'freebuff'
          : 'setup',
      database: Boolean(c.env.DB),
    }),
  )

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/session' || c.req.path === '/api/health')
      return next()
    if (!c.env.DB)
      return c.json(
        { error: 'This app is still being set up. Please try again later.' },
        503,
      )
    await ensureSchema(c.env.DB)
    c.set('db', c.env.DB)
    // Machine-to-machine routes prove themselves with a signature or a key
    // inside the handler; everything else needs a signed-in person.
    if (
      c.req.path === '/api/webhooks/mailgun' ||
      c.req.path === '/api/cron/send'
    )
      return next()
    const user = await authenticate(c.req.raw, c.env)
    if (!user) return c.json({ error: 'Sign in required.' }, 401)
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const origin = appOrigin(c.req.raw, c.env)
      if (!origin || !isSameOriginRequest(c.req.raw, origin))
        return c.json({ error: 'Cross-origin request refused.' }, 403)
    }
    c.set('user', user)
    await next()
  })

  const owner = (c: { get: (key: 'user') => FreebuffUser }) => c.get('user').sub

  const suppressedFor = async (db: D1Database, who: string) =>
    (
      await db
        .prepare('SELECT value FROM suppressions WHERE owner_sub = ?')
        .bind(who)
        .all<{ value: string }>()
    ).results

  const loadLead = async (
    db: D1Database,
    who: string,
    leadId: string,
  ): Promise<LeadRow | null> =>
    db
      .prepare(`${LEAD_SELECT} WHERE l.id = ? AND l.owner_sub = ?`)
      .bind(leadId, who)
      .first<LeadRow>()

  /* --------------------------------------------------------------- sending */

  const dailyCap = (env: Env): number => {
    const value = Number(env.DAILY_SEND_CAP)
    return Number.isFinite(value) && value > 0
      ? Math.min(200, Math.floor(value))
      : 20
  }

  const sentToday = async (db: D1Database, who: string): Promise<number> => {
    const midnight = new Date()
    midnight.setUTCHours(0, 0, 0, 0)
    const row = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE owner_sub = ? AND direction = 'out' AND status = 'sent' AND created_at >= ?",
      )
      .bind(who, midnight.getTime())
      .first<{ n: number }>()
    return Number(row?.n ?? 0)
  }

  type SendOutcome = {
    leadId?: string
    status: 'sent' | 'blocked' | 'failed' | 'unconfigured' | 'missing'
    detail: string
  }

  const sendDraft = async (
    db: D1Database,
    env: Env,
    who: string,
    draftId: string,
  ): Promise<SendOutcome> => {
    const draft = await db
      .prepare(
        'SELECT id, subject, body, claims_json, lead_id, status FROM drafts WHERE id = ? AND owner_sub = ?',
      )
      .bind(draftId, who)
      .first<{
        id: string
        subject: string
        body: string
        claims_json: string
        lead_id: string
        status: string
      }>()
    if (!draft) return { status: 'missing', detail: 'Message not found.' }
    const alreadySent = await db
      .prepare(
        'SELECT id FROM messages WHERE owner_sub = ? AND draft_id = ? LIMIT 1',
      )
      .bind(who, draftId)
      .first<{ id: string }>()
    if (alreadySent)
      return {
        status: 'blocked',
        leadId: draft.lead_id,
        detail: 'This message has already been sent.',
      }
    if (draft.status !== 'approved')
      return {
        status: 'blocked',
        leadId: draft.lead_id,
        detail: 'Only approved messages can be sent.',
      }

    const row = await loadLead(db, who, draft.lead_id)
    if (!row) return { status: 'missing', detail: 'Business not found.' }
    const lead = mapLead(row, await suppressedFor(db, who))
    const blocked: string[] = []
    if (lead.suppressed)
      blocked.push('This person is on your do-not-contact list.')
    if (!lead.verification.sendable)
      blocked.push(
        `This email cannot be messaged yet (${lead.verification.label.toLowerCase()}).`,
      )
    const evidence = (
      await db
        .prepare(
          'SELECT id, url, source_type, excerpt, observed_at FROM evidence WHERE owner_sub = ? AND lead_id = ?',
        )
        .bind(who, row.id)
        .all<{
          id: string
          url: string
          source_type: string
          excerpt: string
          observed_at: number
        }>()
    ).results.map((item) => ({
      id: item.id,
      url: item.url,
      sourceType: item.source_type,
      excerpt: item.excerpt,
      observedAt: item.observed_at,
    }))
    const gate = auditClaims(parseClaims(draft.claims_json), evidence)
    blocked.push(...gate.blocked)
    if (blocked.length)
      return {
        status: 'blocked',
        leadId: row.id,
        detail: blocked.join(' '),
      }
    if (!mailReady(env))
      return {
        status: 'unconfigured',
        leadId: row.id,
        detail:
          'Email sending is not switched on yet. Add your Mailgun key, domain and sender address.',
      }

    const now = Date.now()
    const result = await sendMail(env, {
      to: lead.contact.email,
      subject: draft.subject,
      text: draft.body,
      replyTo: replyAddress(env, row.id),
    })
    if (!result.ok) {
      await db
        .prepare(
          "INSERT INTO messages (id, owner_sub, lead_id, draft_id, direction, subject, body, from_email, to_email, status, reason, created_at) VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, 'failed', ?, ?)",
        )
        .bind(
          id(),
          who,
          row.id,
          draft.id,
          draft.subject,
          draft.body,
          env.MAIL_FROM || '',
          lead.contact.email,
          result.error,
          now,
        )
        .run()
      await recordAudit(
        db,
        who,
        'message.failed',
        'lead',
        row.id,
        `Sending to ${lead.contact.email} failed.`,
        now,
      )
      return { status: 'failed', leadId: row.id, detail: result.error }
    }

    await db
      .prepare(
        "INSERT INTO messages (id, owner_sub, lead_id, draft_id, direction, subject, body, from_email, to_email, status, provider_id, created_at) VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, 'sent', ?, ?)",
      )
      .bind(
        id(),
        who,
        row.id,
        draft.id,
        draft.subject,
        draft.body,
        env.MAIL_FROM || '',
        lead.contact.email,
        result.id,
        now,
      )
      .run()
    await db
      .prepare(
        "UPDATE leads SET status = 'contacted', updated_at = ? WHERE id = ? AND owner_sub = ?",
      )
      .bind(now, row.id, who)
      .run()
    await recordAudit(
      db,
      who,
      'message.sent',
      'lead',
      row.id,
      `Message sent to ${lead.contact.email}.`,
      now,
    )
    await recordUsage(db, who, 'email.sent', 1, row.id, now)
    return { status: 'sent', leadId: row.id, detail: 'Sent.' }
  }

  const sendApprovedFor = async (
    db: D1Database,
    env: Env,
    who: string,
    limit: number,
  ) => {
    const cap = dailyCap(env)
    const remaining = Math.max(0, cap - (await sentToday(db, who)))
    const take = Math.min(remaining, Math.max(0, limit))
    const rows = await db
      .prepare(
        `SELECT d.id AS id FROM drafts d
         WHERE d.owner_sub = ? AND d.status = 'approved'
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.owner_sub = d.owner_sub AND m.draft_id = d.id)
         ORDER BY d.decided_at ASC LIMIT ?`,
      )
      .bind(who, take)
      .all<{ id: string }>()
    const results: SendOutcome[] = []
    for (const row of rows.results)
      results.push(await sendDraft(db, env, who, row.id))
    const sent = results.filter((item) => item.status === 'sent').length
    return {
      sent,
      blocked: results.filter((item) => item.status === 'blocked').length,
      failed: results.filter((item) => item.status === 'failed').length,
      blockedReasons: results
        .filter((item) => item.status !== 'sent')
        .map((item) => item.detail)
        .slice(0, 5),
      remaining: Math.max(0, remaining - sent),
      dailyCap: cap,
    }
  }

  /* ---------------------------------------------------------------- overview */

  app.get('/api/overview', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const [
      statuses,
      drafts,
      evidence,
      icps,
      offer,
      unscored,
      noEvidence,
      usage,
      recent,
      needsYou,
    ] = await db.batch([
        db
          .prepare(
            'SELECT status, COUNT(*) AS count FROM leads WHERE owner_sub = ? GROUP BY status',
          )
          .bind(who),
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM drafts WHERE owner_sub = ? AND status = 'pending'",
          )
          .bind(who),
        db
          .prepare('SELECT COUNT(*) AS n FROM evidence WHERE owner_sub = ?')
          .bind(who),
        db.prepare('SELECT COUNT(*) AS n FROM icps WHERE owner_sub = ?').bind(who),
        db
          .prepare('SELECT name FROM offers WHERE owner_sub = ?')
          .bind(who),
        db
          .prepare('SELECT COUNT(*) AS n FROM leads WHERE owner_sub = ? AND score IS NULL')
          .bind(who),
        db
          .prepare(
            'SELECT COUNT(*) AS n FROM leads l WHERE l.owner_sub = ? AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.lead_id = l.id AND e.owner_sub = l.owner_sub)',
          )
          .bind(who),
        db
          .prepare(
            'SELECT event_type, SUM(units) AS units FROM usage_ledger WHERE owner_sub = ? GROUP BY event_type ORDER BY units DESC',
          )
          .bind(who),
        db
          .prepare(
            'SELECT id, action, object_type, object_id, detail, created_at FROM audit_logs WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 8',
          )
          .bind(who),
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM messages WHERE owner_sub = ? AND direction = 'in' AND positive = 1 AND handled_at IS NULL",
          )
          .bind(who),
      ])

    const byStatus = (statuses!.results as { status: string; count: number }[]).map(
      (row) => ({ status: row.status as LeadStatus, count: row.count }),
    )
    const count = (status: LeadStatus) =>
      byStatus.find((row) => row.status === status)?.count ?? 0
    const leads = byStatus.reduce((sum, row) => sum + row.count, 0)
    const offerRow = (offer!.results as { name: string }[])[0]

    const payload: Overview = {
      totals: {
        leads,
        qualified: count('qualified') + count('approved') + count('contacted') + count('replied') + count('won'),
        approved: count('approved'),
        contacted: count('contacted'),
        replied: count('replied'),
        pendingDrafts: Number((drafts!.results as { n: number }[])[0]?.n ?? 0),
        evidence: Number((evidence!.results as { n: number }[])[0]?.n ?? 0),
        needsYou: Number((needsYou!.results as { n: number }[])[0]?.n ?? 0),
      },
      offerSaved: Boolean(offerRow),
      icpCount: Number((icps!.results as { n: number }[])[0]?.n ?? 0),
      byStatus,
      needsAttention: {
        unscored: Number((unscored!.results as { n: number }[])[0]?.n ?? 0),
        withoutEvidence: Number((noEvidence!.results as { n: number }[])[0]?.n ?? 0),
        held: count('held'),
        suppressed: 0,
      },
      usage: (usage!.results as { event_type: string; units: number }[]).map(
        (row) => ({ eventType: row.event_type, units: row.units }),
      ),
      recent: (recent!.results as {
        id: string
        action: string
        object_type: string
        object_id: string
        detail: string
        created_at: number
      }[]).map((row) => ({
        id: row.id,
        action: row.action,
        objectType: row.object_type,
        objectId: row.object_id,
        detail: row.detail,
        createdAt: row.created_at,
      })),
    }
    return c.json(payload)
  })

  /* ------------------------------------------------------------------- offer */

  app.get('/api/offer', async (c) => {
    const row = await c
      .get('db')
      .prepare(
        'SELECT name, service, outcomes, proof, exclusions, voice, updated_at FROM offers WHERE owner_sub = ?',
      )
      .bind(owner(c))
      .first<{
        name: string
        service: string
        outcomes: string
        proof: string
        exclusions: string
        voice: string
        updated_at: number
      }>()
    const offer: Offer = row
      ? {
          name: row.name,
          service: row.service,
          outcomes: row.outcomes,
          proof: row.proof,
          exclusions: row.exclusions,
          voice: row.voice,
          updatedAt: row.updated_at,
        }
      : {
          name: '',
          service: '',
          outcomes: '',
          proof: '',
          exclusions: '',
          voice: '',
          updatedAt: null,
        }
    return c.json({ offer })
  })

  app.put('/api/offer', async (c) => {
    const body = object(await c.req.json().catch(() => null))
    const allowed = ['name', 'service', 'outcomes', 'proof', 'exclusions', 'voice']
    if (!body || extraKeys(body, allowed))
      return c.json({ error: 'Check the offer details and try again.' }, 400)
    const name = text(body.name, 120)
    const service = text(body.service, 2000)
    const outcomes = text(body.outcomes, 2000)
    const proof = optional(body.proof, 2000)
    const exclusions = optional(body.exclusions, 2000)
    const voice = optional(body.voice, 1000)
    if (!name || !service || !outcomes || proof === null || exclusions === null || voice === null)
      return c.json(
        { error: 'Add a name, the service you sell and the outcome you deliver.' },
        400,
      )
    const now = Date.now()
    await c
      .get('db')
      .prepare(
        `INSERT INTO offers (owner_sub, name, service, outcomes, proof, exclusions, voice, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_sub) DO UPDATE SET name = excluded.name, service = excluded.service,
           outcomes = excluded.outcomes, proof = excluded.proof, exclusions = excluded.exclusions,
           voice = excluded.voice, updated_at = excluded.updated_at`,
      )
      .bind(owner(c), name, service, outcomes, proof, exclusions, voice, now)
      .run()
    await recordAudit(
      c.get('db'),
      owner(c),
      'offer.updated',
      'offer',
      owner(c),
      `Offer “${name}” saved.`,
      now,
    )
    return c.json({ offer: { name, service, outcomes, proof, exclusions, voice, updatedAt: now } })
  })

  /* -------------------------------------------------------------------- ICPs */

  const mapIcp = (row: {
    id: string
    name: string
    brief: string
    filters_json: string
    created_at: number
  }): Icp => ({
    id: row.id,
    name: row.name,
    brief: row.brief,
    filters: normalizeFilters(JSON.parse(row.filters_json || '{}')),
    createdAt: row.created_at,
  })

  app.get('/api/icps', async (c) => {
    const rows = await c
      .get('db')
      .prepare(
        'SELECT id, name, brief, filters_json, created_at FROM icps WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 50',
      )
      .bind(owner(c))
      .all<{
        id: string
        name: string
        brief: string
        filters_json: string
        created_at: number
      }>()
    return c.json({ icps: rows.results.map(mapIcp) })
  })

  app.post('/api/icps/preview', async (c) => {
    const body = object(await c.req.json().catch(() => null))
    if (!body || extraKeys(body, ['brief']))
      return c.json({ error: 'Check the brief and try again.' }, 400)
    const brief = text(body.brief, 2000)
    if (!brief) return c.json({ error: 'Describe the ideal customer first.' }, 400)
    return c.json({ filters: parseBrief(brief) })
  })

  app.post('/api/icps', async (c) => {
    const body = object(await c.req.json().catch(() => null))
    if (!body || extraKeys(body, ['name', 'brief', 'filters']))
      return c.json({ error: 'Check the ICP details and try again.' }, 400)
    const name = text(body.name, 120)
    const brief = text(body.brief, 2000)
    if (!name || !brief)
      return c.json({ error: 'Give the ICP a name and a short brief.' }, 400)
    const filters: IcpFilters =
      body.filters === undefined ? parseBrief(brief) : normalizeFilters(body.filters)
    const row = {
      id: id(),
      name,
      brief,
      filters,
      createdAt: Date.now(),
    }
    await c
      .get('db')
      .prepare(
        'INSERT INTO icps (id, owner_sub, name, brief, filters_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(row.id, owner(c), name, brief, JSON.stringify(filters), row.createdAt)
      .run()
    await recordAudit(
      c.get('db'),
      owner(c),
      'icp.created',
      'icp',
      row.id,
      `Customer type “${name}” saved with ${filters.titles.length + filters.industries.length + filters.countries.length + filters.sizes.length + filters.keywords.length} filters.`,
    )
    return c.json({ icp: row }, 201)
  })

  app.delete('/api/icps/:id', async (c) => {
    const removed = await c
      .get('db')
      .prepare('DELETE FROM icps WHERE id = ? AND owner_sub = ? RETURNING name')
      .bind(c.req.param('id'), owner(c))
      .first<{ name: string }>()
    if (!removed) return c.json({ error: 'ICP not found.' }, 404)
    await recordAudit(
      c.get('db'),
      owner(c),
      'icp.deleted',
      'icp',
      c.req.param('id'),
      `Customer type “${removed.name}” deleted.`,
    )
    return c.json({ ok: true })
  })

  /* ------------------------------------------------------------------- leads */

  app.get('/api/leads', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const status = c.req.query('status')
    const search = (c.req.query('q') || '').trim().slice(0, 80)
    const conditions = ['l.owner_sub = ?']
    const bindings: unknown[] = [who]
    if (status && STATUS_SET.has(status)) {
      conditions.push('l.status = ?')
      bindings.push(status)
    }
    if (search) {
      conditions.push(
        '(c.name LIKE ? OR p.name LIKE ? OR p.email LIKE ? OR c.domain LIKE ? OR c.industry LIKE ?)',
      )
      const like = `%${search}%`
      bindings.push(like, like, like, like, like)
    }
    const rows = await db
      .prepare(
        `${LEAD_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY l.updated_at DESC LIMIT 200`,
      )
      .bind(...bindings)
      .all<LeadRow>()
    const suppressions = await suppressedFor(db, who)
    return c.json({ leads: rows.results.map((row) => mapLead(row, suppressions)) })
  })

  const loadIcp = async (db: D1Database, who: string, icpId?: string | null) => {
    if (icpId) {
      const row = await db
        .prepare(
          'SELECT id, name, brief, filters_json, created_at FROM icps WHERE id = ? AND owner_sub = ?',
        )
        .bind(icpId, who)
        .first<{
          id: string
          name: string
          brief: string
          filters_json: string
          created_at: number
        }>()
      return row ? mapIcp(row) : null
    }
    const row = await db
      .prepare(
        'SELECT id, name, brief, filters_json, created_at FROM icps WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 1',
      )
      .bind(who)
      .first<{
        id: string
        name: string
        brief: string
        filters_json: string
        created_at: number
      }>()
    return row ? mapIcp(row) : null
  }

  app.post('/api/leads', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const body = object(await c.req.json().catch(() => null))
    if (!body || extraKeys(body, ['company', 'contact', 'source', 'icpId']))
      return c.json({ error: 'Check the details and try again.' }, 400)
    const company = object(body.company)
    const contact = object(body.contact)
    if (!company || !contact)
      return c.json({ error: 'A business and a person are both required.' }, 400)
    if (
      extraKeys(company, ['name', 'domain', 'industry', 'size', 'country']) ||
      extraKeys(contact, ['name', 'title', 'email'])
    )
      return c.json({ error: 'Check the details and try again.' }, 400)

    const companyName = text(company.name, 160)
    const contactName = text(contact.name, 120)
    const domain = optional(company.domain, 200)
    const industry = optional(company.industry, 80)
    const size = optional(company.size, 20)
    const country = optional(company.country, 80)
    const title = optional(contact.title, 120)
    const rawEmail = optional(contact.email, 254)
    const source = optional(body.source, 200) || 'manual'
    if (
      !companyName ||
      !contactName ||
      domain === null ||
      industry === null ||
      size === null ||
      country === null ||
      title === null ||
      rawEmail === null
    )
      return c.json({ error: 'Check the details and try again.' }, 400)

    const email = rawEmail ? normalizeEmail(rawEmail) : ''
    if (email && verifyEmail(email).verdict === 'invalid')
      return c.json({ error: 'That email address is not valid.' }, 400)

    if (email) {
      const existing = await db
        .prepare(
          'SELECT l.id FROM leads l JOIN contacts p ON p.id = l.contact_id WHERE l.owner_sub = ? AND p.email = ? LIMIT 1',
        )
        .bind(who, email)
        .first<{ id: string }>()
      if (existing)
        return c.json(
          { error: 'That email is already on your list.', leads: [] },
          409,
        )
    } else {
      const existing = await db
        .prepare(
          'SELECT l.id FROM leads l JOIN companies c ON c.id = l.company_id JOIN contacts p ON p.id = l.contact_id WHERE l.owner_sub = ? AND lower(c.name) = lower(?) AND lower(p.name) = lower(?) LIMIT 1',
        )
        .bind(who, companyName, contactName)
        .first<{ id: string }>()
      if (existing)
        return c.json(
          { error: 'That business and person are already on your list.' },
          409,
        )
    }

    const now = Date.now()
    const companyId = id()
    const contactId = id()
    const leadId = id()
    const verification = verifyEmail(email)
    const icp = await loadIcp(db, who, typeof body.icpId === 'string' ? body.icpId : null)
    const fit =
      icp && email
        ? scoreLead(
            {
              title: title || '',
              industry: industry || '',
              country: country || '',
              size: size || '',
              companyName,
              email,
            },
            icp.filters,
          )
        : null
    const status: LeadStatus =
      verification.sendable === false && email ? 'held' : 'new'

    await db.batch([
      db
        .prepare(
          'INSERT INTO companies (id, owner_sub, name, domain, industry, size, country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(companyId, who, companyName, normalizeDomain(domain || ''), industry || '', size || '', country || '', now),
      db
        .prepare(
          'INSERT INTO contacts (id, owner_sub, company_id, name, title, email, verdict, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(contactId, who, companyId, contactName, title || '', email, verification.verdict, now, now),
      db
        .prepare(
          'INSERT INTO leads (id, owner_sub, company_id, contact_id, status, score, score_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          leadId,
          who,
          companyId,
          contactId,
          status,
          fit ? fit.score : null,
          fit ? JSON.stringify(fit) : '{}',
          source || 'manual',
          now,
          now,
        ),
    ])
    await recordAudit(db, who, 'lead.created', 'lead', leadId, `${contactName} at ${companyName} added to the list.`, now)
    await recordUsage(db, who, 'lead.added', 1, leadId, now)

    const row = await loadLead(db, who, leadId)
    return c.json(
      { lead: mapLead(row!, await suppressedFor(db, who)) },
      201,
    )
  })

  app.get('/api/leads/:id', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const row = await loadLead(db, who, c.req.param('id'))
    if (!row) return c.json({ error: 'Business not found.' }, 404)
    const [evidenceRows, draftRows, messageRows] = await db.batch([
      db
        .prepare(
          'SELECT id, url, source_type, excerpt, observed_at FROM evidence WHERE owner_sub = ? AND lead_id = ? ORDER BY observed_at DESC LIMIT 40',
        )
        .bind(who, row.id),
      db
        .prepare(
          'SELECT id, subject, body, claims_json, status, created_at, decided_at FROM drafts WHERE owner_sub = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 20',
        )
        .bind(who, row.id),
      db
        .prepare(
          "SELECT id, lead_id, direction, subject, body, from_email, to_email, status, category, positive, confidence, reason, handled_at, created_at FROM messages WHERE owner_sub = ? AND lead_id = ? ORDER BY created_at ASC LIMIT 100",
        )
        .bind(who, row.id),
    ])
    const detail: LeadDetail = {
      ...mapLead(row, await suppressedFor(db, who)),
      evidence: (
        evidenceRows!.results as {
          id: string
          url: string
          source_type: string
          excerpt: string
          observed_at: number
        }[]
      ).map((item) => ({
        id: item.id,
        url: item.url,
        sourceType: item.source_type,
        excerpt: item.excerpt,
        observedAt: item.observed_at,
      })),
      drafts: (
        draftRows!.results as {
          id: string
          subject: string
          body: string
          claims_json: string
          status: string
          created_at: number
          decided_at: number | null
        }[]
      ).map((item) => ({
        id: item.id,
        subject: item.subject,
        body: item.body,
        claims: parseClaims(item.claims_json),
        status: item.status as Draft['status'],
        createdAt: item.created_at,
        decidedAt: item.decided_at,
      })),
      messages: (messageRows!.results as MessageRow[]).map(mapMessage),
    }
    return c.json({ lead: detail })
  })

  app.patch('/api/leads/:id', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const leadId = c.req.param('id')
    const body = object(await c.req.json().catch(() => null))
    if (!body || extraKeys(body, ['status', 'email', 'title', 'name']))
      return c.json({ error: 'Check the update and try again.' }, 400)
    const row = await loadLead(db, who, leadId)
    if (!row) return c.json({ error: 'Business not found.' }, 404)

    const changes: string[] = []
    const now = Date.now()
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !STATUS_SET.has(body.status))
        return c.json({ error: 'That status is not recognised.' }, 400)
      await db
        .prepare('UPDATE leads SET status = ?, updated_at = ? WHERE id = ? AND owner_sub = ?')
        .bind(body.status, now, leadId, who)
        .run()
      changes.push(`status → ${body.status}`)
    }
    const patchContact =
      body.email !== undefined ||
      body.title !== undefined ||
      body.name !== undefined
    if (patchContact) {
      const email =
        body.email === undefined
          ? undefined
          : typeof body.email === 'string' || body.email === ''
            ? normalizeEmail(String(body.email))
            : null
      if (email === null) return c.json({ error: 'That email address is not valid.' }, 400)
      if (email && verifyEmail(email).verdict === 'invalid')
        return c.json({ error: 'That email address is not valid.' }, 400)
      if (email) {
        const duplicate = await db
          .prepare(
            'SELECT l.id FROM leads l JOIN contacts p ON p.id = l.contact_id WHERE l.owner_sub = ? AND p.email = ? AND l.id != ? LIMIT 1',
          )
          .bind(who, email, leadId)
          .first<{ id: string }>()
        if (duplicate)
          return c.json({ error: 'Another business already uses that email.' }, 409)
      }
      const title =
        body.title === undefined ? undefined : text(body.title, 120, 0)
      if (title === null)
        return c.json({ error: 'Check the job title and try again.' }, 400)
      const personName =
        body.name === undefined ? undefined : text(body.name, 120)
      if (personName === null)
        return c.json({ error: "Add the person's name." }, 400)
      const verification = email ? verifyEmail(email) : null
      await db
        .prepare(
          `UPDATE contacts SET name = COALESCE(?, name), email = COALESCE(?, email), title = COALESCE(?, title),
            verdict = COALESCE(?, verdict), checked_at = COALESCE(?, checked_at) WHERE id = ? AND owner_sub = ?`,
        )
        .bind(
          personName === undefined ? null : personName,
          email || null,
          title === undefined ? null : title,
          verification ? verification.verdict : null,
          verification ? now : null,
          row.contact_id,
          who,
        )
        .run()
      changes.push('contact details updated')
    }
    if (!changes.length) return c.json({ error: 'Nothing to update.' }, 400)
    await recordAudit(db, who, 'lead.updated', 'lead', leadId, changes.join('; '))
    const updated = await loadLead(db, who, leadId)
    return c.json({ lead: mapLead(updated!, await suppressedFor(db, who)) })
  })

  app.delete('/api/leads/:id', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const row = await loadLead(db, who, c.req.param('id'))
    if (!row) return c.json({ error: 'Business not found.' }, 404)
    await db.batch([
      db.prepare('DELETE FROM evidence WHERE owner_sub = ? AND lead_id = ?').bind(who, row.id),
      db.prepare('DELETE FROM drafts WHERE owner_sub = ? AND lead_id = ?').bind(who, row.id),
      db.prepare('DELETE FROM leads WHERE id = ? AND owner_sub = ?').bind(row.id, who),
      db.prepare('DELETE FROM contacts WHERE id = ? AND owner_sub = ?').bind(row.contact_id, who),
      db.prepare('DELETE FROM companies WHERE id = ? AND owner_sub = ?').bind(row.company_id, who),
    ])
    await recordAudit(
      db,
      who,
      'lead.deleted',
      'lead',
      row.id,
      `${row.contact_name} at ${row.company_name} deleted, along with their notes and messages.`,
    )
    return c.json({ ok: true })
  })

  /* ---------------------------------------------------------------- evidence */

  app.post('/api/leads/:id/evidence', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const row = await loadLead(db, who, c.req.param('id'))
    if (!row) return c.json({ error: 'Business not found.' }, 404)
    const body = object(await c.req.json().catch(() => null))
    if (!body || extraKeys(body, ['url', 'excerpt', 'sourceType']))
      return c.json({ error: 'Check the research note and try again.' }, 400)
    const url = text(body.url, 500)
    const excerpt = text(body.excerpt, 1200)
    const sourceType = optional(body.sourceType, 40) || 'website'
    if (!url || !excerpt || sourceType === null || !/^https?:\/\//i.test(url))
      return c.json(
        { error: 'Add the page address (starting with http:// or https://) and what you saw.' },
        400,
      )
    const evidence: Evidence = {
      id: id(),
      url,
      sourceType,
      excerpt,
      observedAt: Date.now(),
    }
    await db
      .prepare(
        'INSERT INTO evidence (id, owner_sub, lead_id, url, source_type, excerpt, observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        evidence.id,
        who,
        row.id,
        evidence.url,
        evidence.sourceType,
        evidence.excerpt,
        evidence.observedAt,
        evidence.observedAt,
      )
      .run()
    await db
      .prepare('UPDATE leads SET updated_at = ? WHERE id = ? AND owner_sub = ?')
      .bind(evidence.observedAt, row.id, who)
      .run()
    await recordAudit(
      db,
      who,
      'evidence.added',
      'lead',
      row.id,
      `Note saved from ${new URL(url).hostname}.`,
    )
    await recordUsage(db, who, 'research', 1, evidence.id)
    return c.json({ evidence }, 201)
  })

  app.delete('/api/evidence/:id', async (c) => {
    const removed = await c
      .get('db')
      .prepare(
        'DELETE FROM evidence WHERE id = ? AND owner_sub = ? RETURNING lead_id',
      )
      .bind(c.req.param('id'), owner(c))
      .first<{ lead_id: string }>()
    if (!removed) return c.json({ error: 'Research note not found.' }, 404)
    await recordAudit(
      c.get('db'),
      owner(c),
      'evidence.deleted',
      'lead',
      removed.lead_id,
      'A note was removed. Any message that used it is blocked until it has a source again.',
    )
    return c.json({ ok: true })
  })

  /* ------------------------------------------------------------ score/draft */

  app.post('/api/leads/:id/score', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const row = await loadLead(db, who, c.req.param('id'))
    if (!row) return c.json({ error: 'Business not found.' }, 404)
    const body = object(await c.req.json().catch(() => ({}))) ?? {}
    if (extraKeys(body, ['icpId']))
      return c.json({ error: 'Check the request and try again.' }, 400)
    const icp = await loadIcp(
      db,
      who,
      typeof body.icpId === 'string' ? body.icpId : null,
    )
    if (!icp)
      return c.json(
        { error: 'Describe your perfect customer on the “What we sell” page first, then check the match.' },
        400,
      )
    const fit = scoreLead(
      {
        title: row.title,
        industry: row.industry,
        country: row.country,
        size: row.size,
        companyName: row.company_name,
        email: row.email,
      },
      icp.filters,
    )
    const status: LeadStatus =
      fit.decision === 'reject'
        ? 'held'
        : row.status === 'new' || row.status === 'held'
          ? 'qualified'
          : (row.status as LeadStatus)
    await db
      .prepare(
        'UPDATE leads SET score = ?, score_json = ?, status = ?, updated_at = ? WHERE id = ? AND owner_sub = ?',
      )
      .bind(fit.score, JSON.stringify(fit), status, Date.now(), row.id, who)
      .run()
    await recordAudit(
      db,
      who,
      'lead.scored',
      'lead',
      row.id,
      `Match checked: ${fit.score} out of 100 against “${icp.name}” (${fit.decision === 'keep' ? 'worth writing to' : 'not worth writing to'}).`,
    )
    return c.json({ fit, status })
  })

  app.post('/api/leads/:id/draft', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const row = await loadLead(db, who, c.req.param('id'))
    if (!row) return c.json({ error: 'Business not found.' }, 404)
    const offerRow = await db
      .prepare(
        'SELECT name, service, outcomes, proof, exclusions, voice, updated_at FROM offers WHERE owner_sub = ?',
      )
      .bind(who)
      .first<Offer & { updated_at: number }>()
    if (!offerRow)
      return c.json(
        { error: 'Fill in “What we sell” first.' },
        400,
      )
    const evidence = (
      await db
        .prepare(
          'SELECT id, url, source_type, excerpt, observed_at FROM evidence WHERE owner_sub = ? AND lead_id = ? ORDER BY observed_at DESC LIMIT 10',
        )
        .bind(who, row.id)
        .all<{
          id: string
          url: string
          source_type: string
          excerpt: string
          observed_at: number
        }>()
    ).results.map((item) => ({
      id: item.id,
      url: item.url,
      sourceType: item.source_type,
      excerpt: item.excerpt,
      observedAt: item.observed_at,
    }))
    let built
    try {
      built = buildDraft({
        offer: {
          name: offerRow.name,
          service: offerRow.service,
          outcomes: offerRow.outcomes,
          proof: offerRow.proof,
          exclusions: offerRow.exclusions,
          voice: offerRow.voice,
          updatedAt: offerRow.updated_at,
        },
        companyName: row.company_name,
        contactName: row.contact_name,
        contactTitle: row.title,
        evidence,
        fit: parseFit(row.score_json),
      })
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Add research before drafting.',
        },
        400,
      )
    }
    const gate = auditClaims(built.claims, evidence)
    if (!gate.ok)
      return c.json(
        { error: 'Something in this message is not backed by a source.', blocked: gate.blocked },
        422,
      )
    const draft: Draft = {
      id: id(),
      subject: built.subject,
      body: built.body,
      claims: built.claims,
      status: 'pending',
      createdAt: Date.now(),
      decidedAt: null,
    }
    await db
      .prepare(
        'INSERT INTO drafts (id, owner_sub, lead_id, subject, body, claims_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        draft.id,
        who,
        row.id,
        draft.subject,
        draft.body,
        JSON.stringify(draft.claims),
        draft.status,
        draft.createdAt,
      )
      .run()
    await db
      .prepare('UPDATE leads SET updated_at = ? WHERE id = ? AND owner_sub = ?')
      .bind(draft.createdAt, row.id, who)
      .run()
    await recordAudit(
      db,
      who,
      'draft.created',
      'draft',
      draft.id,
      `Message written for ${row.contact_name}, with ${draft.claims.length} source(s) attached.`,
    )
    await recordUsage(db, who, 'draft', 5, draft.id)
    return c.json({ draft }, 201)
  })

  /* ------------------------------------------------------------ review queue */

  app.get('/api/review', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const rows = await db
      .prepare(
        `SELECT d.id AS draft_id, d.subject, d.body, d.claims_json, d.created_at,
           l.id AS lead_id
         FROM drafts d JOIN leads l ON l.id = d.lead_id AND l.owner_sub = d.owner_sub
         WHERE d.owner_sub = ? AND d.status = 'pending'
         ORDER BY d.created_at ASC LIMIT 50`,
      )
      .bind(who)
      .all<{
        draft_id: string
        subject: string
        body: string
        claims_json: string
        created_at: number
        lead_id: string
      }>()
    const suppressions = await suppressedFor(db, who)
    const items: ReviewItem[] = []
    for (const row of rows.results) {
      const leadRow = await loadLead(db, who, row.lead_id)
      if (!leadRow) continue
      const evidence = (
        await db
          .prepare(
            'SELECT id, url, source_type, excerpt, observed_at FROM evidence WHERE owner_sub = ? AND lead_id = ?',
          )
          .bind(who, row.lead_id)
          .all<{
            id: string
            url: string
            source_type: string
            excerpt: string
            observed_at: number
          }>()
      ).results.map((item) => ({
        id: item.id,
        url: item.url,
        sourceType: item.source_type,
        excerpt: item.excerpt,
        observedAt: item.observed_at,
      }))
      const lead = mapLead(leadRow, suppressions)
      const claims = parseClaims(row.claims_json)
      const gate = auditClaims(claims, evidence)
      const blocked = [...gate.blocked]
      if (lead.suppressed)
        blocked.push('This person is on your do-not-contact list.')
      if (!lead.verification.sendable)
        blocked.push(
          `This email cannot be messaged yet (${lead.verification.label.toLowerCase()}).`,
        )
      items.push({
        draft: {
          id: row.draft_id,
          subject: row.subject,
          body: row.body,
          claims,
          status: 'pending',
          createdAt: row.created_at,
          decidedAt: null,
        },
        lead,
        blocked,
        evidence,
      })
    }
    return c.json({ items })
  })

  app.post('/api/drafts/:id/decide', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const body = object(await c.req.json().catch(() => null))
    if (!body || extraKeys(body, ['decision']))
      return c.json({ error: 'Check the decision and try again.' }, 400)
    if (body.decision !== 'approve' && body.decision !== 'reject')
      return c.json({ error: 'Decision must be approve or reject.' }, 400)
    const draftRow = await db
      .prepare(
        'SELECT id, lead_id, claims_json, status FROM drafts WHERE id = ? AND owner_sub = ?',
      )
      .bind(c.req.param('id'), who)
      .first<{ id: string; lead_id: string; claims_json: string; status: string }>()
    if (!draftRow) return c.json({ error: 'Draft not found.' }, 404)
    if (draftRow.status !== 'pending')
      return c.json({ error: 'This draft has already been decided.' }, 409)
    const leadRow = await loadLead(db, who, draftRow.lead_id)
    if (!leadRow) return c.json({ error: 'Business not found.' }, 404)

    const now = Date.now()
    if (body.decision === 'reject') {
      await db.batch([
        db
          .prepare(
            "UPDATE drafts SET status = 'rejected', decided_at = ? WHERE id = ? AND owner_sub = ?",
          )
          .bind(now, draftRow.id, who),
        db
          .prepare('UPDATE leads SET updated_at = ? WHERE id = ? AND owner_sub = ?')
          .bind(now, draftRow.lead_id, who),
      ])
      await recordAudit(db, who, 'draft.rejected', 'draft', draftRow.id, 'Draft rejected in review.')
      return c.json({ ok: true, status: 'rejected' })
    }

    const evidence = (
      await db
        .prepare(
          'SELECT id, url, source_type, excerpt, observed_at FROM evidence WHERE owner_sub = ? AND lead_id = ?',
        )
        .bind(who, draftRow.lead_id)
        .all<{
          id: string
          url: string
          source_type: string
          excerpt: string
          observed_at: number
        }>()
    ).results.map((item) => ({
      id: item.id,
      url: item.url,
      sourceType: item.source_type,
      excerpt: item.excerpt,
      observedAt: item.observed_at,
    }))
    const lead = mapLead(leadRow, await suppressedFor(db, who))
    const gate = auditClaims(parseClaims(draftRow.claims_json), evidence)
    const blocked = [...gate.blocked]
    if (lead.suppressed)
      blocked.push('This person is on your do-not-contact list.')
    if (!lead.verification.sendable)
      blocked.push(
        `This email cannot be messaged yet (${lead.verification.label.toLowerCase()}).`,
      )
    if (blocked.length)
      return c.json(
        { error: 'This message cannot be approved yet.', blocked },
        409,
      )

    await db.batch([
      db
        .prepare(
          "UPDATE drafts SET status = 'approved', decided_at = ? WHERE id = ? AND owner_sub = ?",
        )
        .bind(now, draftRow.id, who),
      db
        .prepare("UPDATE leads SET status = 'approved', updated_at = ? WHERE id = ? AND owner_sub = ?")
        .bind(now, draftRow.lead_id, who),
    ])
    await recordAudit(
      db,
      who,
      'draft.approved',
      'draft',
      draftRow.id,
      `Message approved for ${lead.contact.name} at ${lead.company.name}. You send it yourself.`,
      now,
    )
    return c.json({ ok: true, status: 'approved' })
  })

  /* -------------------------------------------------------------- guardrails */

  app.get('/api/suppressions', async (c) => {
    const rows = await c
      .get('db')
      .prepare(
        'SELECT id, value, reason, created_at FROM suppressions WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 200',
      )
      .bind(owner(c))
      .all<{ id: string; value: string; reason: string; created_at: number }>()
    const suppressions: Suppression[] = rows.results.map((row) => ({
      id: row.id,
      value: row.value,
      reason: row.reason,
      createdAt: row.created_at,
    }))
    return c.json({ suppressions })
  })

  app.post('/api/suppressions', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const body = object(await c.req.json().catch(() => null))
    if (!body || extraKeys(body, ['value', 'reason']))
      return c.json({ error: 'Check the entry and try again.' }, 400)
    const raw = text(body.value, 254)
    const reason = text(body.reason, 200)
    if (!raw || !reason)
      return c.json({ error: 'Add the email or website and a reason.' }, 400)
    const value = raw.includes('@') ? normalizeEmail(raw) : normalizeDomain(raw)
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(value) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value))
      return c.json({ error: 'Enter a valid email address or domain.' }, 400)
    const existing = await db
      .prepare('SELECT id FROM suppressions WHERE owner_sub = ? AND value = ?')
      .bind(who, value)
      .first<{ id: string }>()
    if (existing)
      return c.json({ error: 'That address is already on your do-not-contact list.' }, 409)
    const row: Suppression = {
      id: id(),
      value,
      reason,
      createdAt: Date.now(),
    }
    await db
      .prepare(
        'INSERT INTO suppressions (id, owner_sub, value, reason, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(row.id, who, row.value, row.reason, row.createdAt)
      .run()
    await recordAudit(
      db,
      who,
      'suppression.added',
      'suppression',
      row.id,
      `${row.value} added to the do-not-contact list: ${row.reason}.`,
    )
    return c.json({ suppression: row }, 201)
  })

  app.delete('/api/suppressions/:id', async (c) => {
    const removed = await c
      .get('db')
      .prepare(
        'DELETE FROM suppressions WHERE id = ? AND owner_sub = ? RETURNING value, reason',
      )
      .bind(c.req.param('id'), owner(c))
      .first<{ value: string; reason: string }>()
    if (!removed) return c.json({ error: 'Entry not found.' }, 404)
    await recordAudit(
      c.get('db'),
      owner(c),
      'suppression.removed',
      'suppression',
      c.req.param('id'),
      `${removed.value} removed from the do-not-contact list. Reason was: ${removed.reason}.`,
    )
    return c.json({ ok: true })
  })

  app.post('/api/verify', async (c) => {
    const body = object(await c.req.json().catch(() => null))
    if (!body || extraKeys(body, ['email']))
      return c.json({ error: 'Check the address and try again.' }, 400)
    const address = text(body.email, 254)
    if (!address) return c.json({ error: 'Enter an email address to check.' }, 400)
    return c.json({ verification: verifyEmail(address) })
  })

  /* ------------------------------------------------------------------- find */

  app.get('/api/find', (c) =>
    c.json({ configured: Boolean(c.env.GOOGLE_PLACES_API_KEY) }),
  )

  app.post('/api/find', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    if (!c.env.GOOGLE_PLACES_API_KEY)
      return c.json(
        {
          configured: false,
          error:
            'Business search is not switched on yet. Add a Google Places API key to use it.',
        },
        503,
      )
    const body = object(await c.req.json().catch(() => null))
    if (!body || extraKeys(body, ['query', 'limit']))
      return c.json({ error: 'Check the search and try again.' }, 400)
    const query = text(body.query, 300, 3)
    if (!query)
      return c.json(
        {
          error:
            'Type what you are looking for and where, for example “online shops in Lagos”.',
        },
        400,
      )
    const limit = body.limit === undefined ? 10 : Number(body.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      return c.json({ error: 'Ask for between 1 and 20 businesses.' }, 400)

    const result = await searchBusinesses(
      c.env.GOOGLE_PLACES_API_KEY,
      query,
      limit,
    )
    if (!result.ok)
      return c.json(
        { configured: true, error: result.message },
        result.reason === 'rejected' ? 502 : 503,
      )

    const known = await db
      .prepare('SELECT name, domain FROM companies WHERE owner_sub = ? LIMIT 1000')
      .bind(who)
      .all<{ name: string; domain: string }>()
    const names = new Set(
      known.results.map((row) => row.name.trim().toLowerCase()),
    )
    const domains = new Set(
      known.results
        .map((row) => row.domain)
        .filter((domain): domain is string => Boolean(domain)),
    )
    const candidates = result.candidates.map((candidate) => ({
      ...candidate,
      alreadyAdded:
        names.has(candidate.name.trim().toLowerCase()) ||
        (candidate.website
          ? domains.has(normalizeDomain(candidate.website))
          : false),
    }))

    await recordUsage(db, who, 'business.search', 1, 'places')
    await recordAudit(
      db,
      who,
      'find.searched',
      'search',
      who,
      `Searched “${query}” — ${candidates.length} businesses found.`,
    )
    return c.json({ configured: true, candidates })
  })

  app.post('/api/find/save', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const body = object(await c.req.json().catch(() => null))
    if (!body || extraKeys(body, ['place']))
      return c.json({ error: 'Check the business and try again.' }, 400)
    const place = object(body.place)
    if (
      !place ||
      extraKeys(place, [
        'placeId',
        'name',
        'address',
        'website',
        'category',
        'phone',
      ])
    )
      return c.json({ error: 'Check the business and try again.' }, 400)
    const name = text(place.name, 160)
    const website = optional(place.website, 300)
    const address = optional(place.address, 300)
    const category = optional(place.category, 80)
    if (
      !name ||
      website === null ||
      website === undefined ||
      address === null ||
      address === undefined ||
      category === null ||
      category === undefined
    )
      return c.json({ error: 'Check the business and try again.' }, 400)
    if (website && !/^https?:\/\//i.test(website))
      return c.json({ error: 'That website address is not valid.' }, 400)

    const domain = normalizeDomain(website)
    if (domain) {
      const existing = await db
        .prepare(
          'SELECT id FROM companies WHERE owner_sub = ? AND domain = ? LIMIT 1',
        )
        .bind(who, domain)
        .first<{ id: string }>()
      if (existing)
        return c.json({ error: 'That business is already on your list.' }, 409)
    }
    const duplicateName = await db
      .prepare(
        'SELECT id FROM companies WHERE owner_sub = ? AND lower(name) = lower(?) LIMIT 1',
      )
      .bind(who, name)
      .first<{ id: string }>()
    if (duplicateName)
      return c.json({ error: 'That business is already on your list.' }, 409)

    const now = Date.now()
    const companyId = id()
    const contactId = id()
    const leadId = id()
    await db.batch([
      db
        .prepare(
          'INSERT INTO companies (id, owner_sub, name, domain, industry, size, country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          companyId,
          who,
          name,
          domain,
          category || '',
          '',
          countryFromAddress(address || ''),
          now,
        ),
      db
        .prepare(
          'INSERT INTO contacts (id, owner_sub, company_id, name, title, email, verdict, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          contactId,
          who,
          companyId,
          'Person to find',
          '',
          '',
          'unknown',
          now,
          now,
        ),
      db
        .prepare(
          'INSERT INTO leads (id, owner_sub, company_id, contact_id, status, score, score_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(leadId, who, companyId, contactId, 'new', null, '{}', 'Google Places', now, now),
    ])
    await recordAudit(
      db,
      who,
      'business.found',
      'lead',
      leadId,
      `${name} added from business search. A person still needs to be found.`,
      now,
    )
    await recordUsage(db, who, 'lead.added', 1, leadId, now)
    const row = await loadLead(db, who, leadId)
    return c.json({ lead: mapLead(row!, await suppressedFor(db, who)) }, 201)
  })

  /* ----------------------------------------------------------- send + replies */

  app.post('/api/leads/:id/send', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const body = object(await c.req.json().catch(() => null))
    if (!body || extraKeys(body, ['draftId']))
      return c.json({ error: 'Check the request and try again.' }, 400)
    const draftId = text(body.draftId, 64)
    if (!draftId) return c.json({ error: 'Pick which message to send.' }, 400)
    const draft = await db
      .prepare('SELECT lead_id FROM drafts WHERE id = ? AND owner_sub = ?')
      .bind(draftId, who)
      .first<{ lead_id: string }>()
    if (!draft || draft.lead_id !== c.req.param('id'))
      return c.json({ error: 'Message not found.' }, 404)
    if (!mailReady(c.env))
      return c.json(
        {
          error:
            'Email sending is not switched on yet. Add your Mailgun key, domain and sender address.',
          mailReady: false,
        },
        503,
      )
    const outcome = await sendDraft(db, c.env, who, draftId)
    if (outcome.status === 'sent') return c.json({ ok: true })
    if (outcome.status === 'blocked')
      return c.json(
        { error: 'This message cannot be sent yet.', blocked: [outcome.detail] },
        409,
      )
    if (outcome.status === 'unconfigured')
      return c.json({ error: outcome.detail, mailReady: false }, 503)
    return c.json({ error: outcome.detail }, 502)
  })

  app.post('/api/send-approved', async (c) => {
    if (!mailReady(c.env))
      return c.json(
        {
          error:
            'Email sending is not switched on yet. Add your Mailgun key, domain and sender address.',
          mailReady: false,
        },
        503,
      )
    const db = c.get('db')
    const who = owner(c)
    const cap = dailyCap(c.env)
    const remaining = Math.max(0, cap - (await sentToday(db, who)))
    if (!remaining)
      return c.json(
        {
          error: `You have reached today's limit of ${cap} messages. It resets tomorrow.`,
        },
        429,
      )
    const summary = await sendApprovedFor(db, c.env, who, 10)
    await recordAudit(
      db,
      who,
      'send.batch',
      'workspace',
      who,
      `Sent ${summary.sent}, blocked ${summary.blocked}, failed ${summary.failed}.`,
    )
    return c.json(summary)
  })

  app.post('/api/cron/send', async (c) => {
    const secret = c.env.CRON_SECRET
    if (!secret)
      return c.json(
        { error: 'Scheduled sending is not set up. Add a CRON_SECRET.' },
        503,
      )
    const given = c.req.header('x-cron-key') || ''
    let match = given.length === secret.length
    for (let index = 0; index < Math.max(given.length, secret.length); index += 1)
      match = match && given.charCodeAt(index) === secret.charCodeAt(index)
    if (!match) return c.json({ error: 'Not allowed.' }, 401)
    if (!mailReady(c.env))
      return c.json({ error: 'Email sending is not switched on yet.' }, 503)

    const db = c.get('db')
    const owners = await db
      .prepare("SELECT DISTINCT owner_sub FROM drafts WHERE status = 'approved'")
      .all<{ owner_sub: string }>()
    let sent = 0
    for (const row of owners.results) {
      const summary = await sendApprovedFor(db, c.env, row.owner_sub, 25)
      sent += summary.sent
    }
    return c.json({ sent })
  })

  app.get('/api/replies', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const rows = await db
      .prepare(
        "SELECT id, lead_id, direction, subject, body, from_email, to_email, status, category, positive, confidence, reason, handled_at, created_at FROM messages WHERE owner_sub = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 100",
      )
      .bind(who)
      .all<MessageRow>()
    const suppressions = await suppressedFor(db, who)
    const items: ReplyItem[] = []
    for (const row of rows.results) {
      const leadRow = await loadLead(db, who, row.lead_id)
      if (!leadRow) continue
      items.push({ message: mapMessage(row), lead: mapLead(leadRow, suppressions) })
    }
    return c.json({
      items,
      needsYou: items.filter((item) => item.message.positive && !item.message.handled)
        .length,
      mailReady: mailReady(c.env),
      dailyCap: dailyCap(c.env),
      sentToday: await sentToday(db, who),
    })
  })

  app.post('/api/messages/:id/handled', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const updated = await db
      .prepare(
        'UPDATE messages SET handled_at = ? WHERE id = ? AND owner_sub = ? RETURNING id',
      )
      .bind(Date.now(), c.req.param('id'), who)
      .first<{ id: string }>()
    if (!updated) return c.json({ error: 'Reply not found.' }, 404)
    await recordAudit(db, who, 'reply.handled', 'message', updated.id, 'Reply marked as handled.')
    return c.json({ ok: true })
  })

  /* --------------------------------------------------------------- webhook */

  app.post(
    '/api/webhooks/mailgun',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => c.json({ error: 'Payload too large.' }, 413),
    }),
    async (c) => {
      const form = (await c.req.parseBody().catch(() => null)) as Record<
        string,
        string | File
      > | null
      if (!form) return c.json({ error: 'Bad payload.' }, 400)
      const field = (name: string): string => {
        const value = form[name]
        return typeof value === 'string' ? value : ''
      }

      const check = await verifyMailgunSignature(c.env, {
        timestamp: field('timestamp'),
        token: field('token'),
        signature: field('signature'),
      })
      if (!check.ok || !check.token)
        return c.json({ error: 'Signature check failed.' }, 401)

      const db = c.get('db')
      const claimed = await db
        .prepare('INSERT OR IGNORE INTO webhook_tokens (token, created_at) VALUES (?, ?)')
        .bind(check.token, Date.now())
        .run()
      if (!claimed.meta.changes)
        return c.json({ ok: true, duplicate: true })

      const recipient = field('recipient')
      const sender = field('sender') || field('from')
      const subject = field('subject')
      const bodyText = field('body-plain') || field('stripped-text')

      const leadToken = leadIdFromAddress(recipient)
      let row = leadToken
        ? await db
            .prepare(`${LEAD_SELECT} WHERE l.id = ?`)
            .bind(leadToken)
            .first<LeadRow>()
        : null
      if (!row) {
        const address = normalizeEmail(
          sender.replace(/.*<([^>]+)>.*/, '$1'),
        )
        if (address)
          row = await db
            .prepare(`${LEAD_SELECT} WHERE p.email = ? ORDER BY l.updated_at DESC LIMIT 1`)
            .bind(address)
            .first<LeadRow>()
      }
      if (!row) return c.json({ ok: true, ignored: 'No matching business.' })

      const who = row.owner_sub
      const classification = classifyReply({
        subject,
        body: bodyText,
        from: sender,
      })
      const now = Date.now()
      await db
        .prepare(
          "INSERT INTO messages (id, owner_sub, lead_id, direction, subject, body, from_email, to_email, status, category, positive, confidence, reason, created_at) VALUES (?, ?, ?, 'in', ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?)",
        )
        .bind(
          id(),
          who,
          row.id,
          subject.slice(0, 300),
          bodyText.slice(0, 20000),
          normalizeEmail(sender).slice(0, 254),
          recipient.slice(0, 254),
          classification.category,
          classification.positive ? 1 : 0,
          classification.confidence,
          classification.reason,
          now,
        )
        .run()

      if (classification.category === 'opt-out' && row.email) {
        await db
          .prepare(
            'INSERT OR IGNORE INTO suppressions (id, owner_sub, value, reason, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(
            id(),
            who,
            normalizeEmail(row.email),
            'Asked to stop contact in a reply',
            now,
          )
          .run()
        await recordAudit(
          db,
          who,
          'suppression.added',
          'lead',
          row.id,
          `${row.email} was added to the do-not-contact list after replying to stop.`,
          now,
        )
      }

      if (classification.category === 'bounce') {
        await db.batch([
          db
            .prepare(
              "UPDATE contacts SET verdict = 'invalid', checked_at = ? WHERE id = ? AND owner_sub = ?",
            )
            .bind(now, row.contact_id, who),
          db
            .prepare(
              "UPDATE leads SET status = 'held', updated_at = ? WHERE id = ? AND owner_sub = ?",
            )
            .bind(now, row.id, who),
        ])
      } else if (classification.category !== 'out-of-office') {
        await db
          .prepare(
            "UPDATE leads SET status = 'replied', updated_at = ? WHERE id = ? AND owner_sub = ?",
          )
          .bind(now, row.id, who)
          .run()
      }

      await recordAudit(
        db,
        who,
        'reply.received',
        'lead',
        row.id,
        `${classification.category} reply from ${row.contact_name} at ${row.company_name}.`,
        now,
      )
      await recordUsage(db, who, 'reply.received', 1, row.id, now)

      if (
        classification.positive &&
        c.env.OWNER_NOTIFY_EMAIL &&
        mailReady(c.env)
      ) {
        await sendMail(c.env, {
          to: c.env.OWNER_NOTIFY_EMAIL,
          subject: `Good news: ${row.contact_name} at ${row.company_name} replied`,
          text: [
            `${row.contact_name} (${row.email}) at ${row.company_name} replied.`,
            '',
            classification.reason,
            '',
            `“${bodyText.slice(0, 600)}”`,
            '',
            `Open the app: ${c.env.APP_ORIGIN || ''}/`,
          ].join('\n'),
        })
      }

      return c.json({ ok: true, category: classification.category })
    },
  )

  /* ------------------------------------------------------------- import/export */

  app.post(
    '/api/import',
    bodyLimit({
      maxSize: 512 * 1024,
      onError: (c) => c.json({ error: 'That file is too large (512 KB limit).' }, 413),
    }),
    async (c) => {
      const db = c.get('db')
      const who = owner(c)
      const body = object(await c.req.json().catch(() => null))
      if (!body || extraKeys(body, ['csv']))
        return c.json({ error: 'Paste a list to import.' }, 400)
      const csv = typeof body.csv === 'string' ? body.csv : ''
      if (!csv.trim()) return c.json({ error: 'Paste a list to import.' }, 400)
      const rows = parseCsv(csv).slice(0, 501)
      if (rows.length < 2)
        return c.json(
          { error: 'Add a first line naming the columns, then at least one business.' },
          400,
        )
      const header = rows[0]!.map((cell) => cell.trim().toLowerCase())
      const column = (...names: string[]) =>
        names.map((name) => header.indexOf(name)).find((index) => index >= 0) ?? -1
      const cols = {
        company: column('company', 'company name', 'business'),
        domain: column('domain', 'website'),
        industry: column('industry', 'sector'),
        size: column('size', 'company size', 'employees'),
        country: column('country', 'location'),
        contact: column('contact', 'name', 'contact name', 'full name'),
        title: column('title', 'role', 'job title'),
        email: column('email', 'email address'),
        source: column('source'),
      }
      if (cols.company < 0 || cols.contact < 0)
        return c.json(
          {
            error:
              'The first line needs the words "company" and "contact" so we know which column is which.',
          },
          400,
        )

      const icp = await loadIcp(db, who, null)
      const result: ImportResult = { created: 0, duplicates: 0, invalid: 0, errors: [] }
      const cell = (row: string[], index: number) =>
        index >= 0 ? (row[index] || '').trim() : ''

      for (const [index, row] of rows.slice(1).entries()) {
        const line = index + 2
        if (row.every((value) => !value.trim())) continue
        const companyName = cell(row, cols.company).slice(0, 160)
        const contactName = cell(row, cols.contact).slice(0, 120) || 'Team'
        const rawEmail = normalizeEmail(cell(row, cols.email))
        if (!companyName) {
          result.invalid += 1
          if (result.errors.length < 8) result.errors.push(`Row ${line}: no company name.`)
          continue
        }
        if (rawEmail && verifyEmail(rawEmail).verdict === 'invalid') {
          result.invalid += 1
          if (result.errors.length < 8)
            result.errors.push(`Row ${line}: "${rawEmail}" is not a valid email.`)
          continue
        }
        const duplicate = rawEmail
          ? await db
              .prepare(
                'SELECT l.id FROM leads l JOIN contacts p ON p.id = l.contact_id WHERE l.owner_sub = ? AND p.email = ? LIMIT 1',
              )
              .bind(who, rawEmail)
              .first<{ id: string }>()
          : await db
              .prepare(
                'SELECT l.id FROM leads l JOIN companies c ON c.id = l.company_id JOIN contacts p ON p.id = l.contact_id WHERE l.owner_sub = ? AND lower(c.name) = lower(?) AND lower(p.name) = lower(?) LIMIT 1',
              )
              .bind(who, companyName, contactName)
              .first<{ id: string }>()
        if (duplicate) {
          result.duplicates += 1
          continue
        }

        const now = Date.now()
        const companyId = id()
        const contactId = id()
        const leadId = id()
        const industry = cell(row, cols.industry).slice(0, 80)
        const size = cell(row, cols.size).slice(0, 20)
        const country = cell(row, cols.country).slice(0, 80)
        const title = cell(row, cols.title).slice(0, 120)
        const domain = normalizeDomain(cell(row, cols.domain)).slice(0, 200)
        const verification = verifyEmail(rawEmail)
        const fit =
          icp && rawEmail
            ? scoreLead(
                {
                  title,
                  industry,
                  country,
                  size,
                  companyName,
                  email: rawEmail,
                },
                icp.filters,
              )
            : null
        const status: LeadStatus =
          rawEmail && !verification.sendable ? 'held' : 'new'
        await db.batch([
          db
            .prepare(
              'INSERT INTO companies (id, owner_sub, name, domain, industry, size, country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(companyId, who, companyName, domain, industry, size, country, now),
          db
            .prepare(
              'INSERT INTO contacts (id, owner_sub, company_id, name, title, email, verdict, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(contactId, who, companyId, contactName, title, rawEmail, verification.verdict, now, now),
          db
            .prepare(
              'INSERT INTO leads (id, owner_sub, company_id, contact_id, status, score, score_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              leadId,
              who,
              companyId,
              contactId,
              status,
              fit ? fit.score : null,
              fit ? JSON.stringify(fit) : '{}',
              cell(row, cols.source).slice(0, 200) || 'csv-import',
              now,
              now,
            ),
        ])
        result.created += 1
      }

      await recordAudit(
        db,
        who,
        'leads.imported',
        'lead',
        who,
        `List pasted: ${result.created} added, ${result.duplicates} already on the list, ${result.invalid} could not be used.`,
      )
      if (result.created)
        await recordUsage(db, who, 'lead.added', result.created, 'csv-import')
      return c.json({ result })
    },
  )

  app.get('/api/export', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const rows = await db
      .prepare(`${LEAD_SELECT} WHERE l.owner_sub = ? ORDER BY l.created_at DESC`)
      .bind(who)
      .all<LeadRow>()
    const escape = (value: string | number) => {
      const text = String(value ?? '')
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }
    const header = [
      'company',
      'domain',
      'industry',
      'size',
      'country',
      'contact',
      'title',
      'email',
      'status',
      'score',
      'verification',
      'source',
    ]
    const lines = [header.join(',')]
    for (const row of rows.results) {
      lines.push(
        [
          row.company_name,
          row.domain,
          row.industry,
          row.size,
          row.country,
          row.contact_name,
          row.title,
          row.email,
          row.status,
          row.score ?? '',
          row.email ? verifyEmail(row.email).verdict : 'unknown',
          row.source,
        ]
          .map(escape)
          .join(','),
      )
    }
    await recordAudit(db, who, 'leads.exported', 'lead', who, `${rows.results.length} businesses downloaded.`)
    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="prospects.csv"',
        'Cache-Control': 'private, no-store',
      },
    })
  })

  /* ----------------------------------------------------------------- activity */

  app.get('/api/activity', async (c) => {
    const db = c.get('db')
    const who = owner(c)
    const [logs, usage] = await db.batch([
      db
        .prepare(
          'SELECT id, action, object_type, object_id, detail, created_at FROM audit_logs WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 100',
        )
        .bind(who),
      db
        .prepare(
          'SELECT event_type, SUM(units) AS units FROM usage_ledger WHERE owner_sub = ? GROUP BY event_type ORDER BY units DESC',
        )
        .bind(who),
    ])
    const activity: Activity[] = (
      logs!.results as {
        id: string
        action: string
        object_type: string
        object_id: string
        detail: string
        created_at: number
      }[]
    ).map((row) => ({
      id: row.id,
      action: row.action,
      objectType: row.object_type,
      objectId: row.object_id,
      detail: row.detail,
      createdAt: row.created_at,
    }))
    return c.json({
      activity,
      usage: (usage!.results as { event_type: string; units: number }[]).map(
        (row) => ({ eventType: row.event_type, units: row.units }),
      ),
    })
  })

  /* ------------------------------------------------------------------- misc */

  app.notFound((c) =>
    c.req.path === '/api' || c.req.path.startsWith('/api/')
      ? c.json({ error: 'Endpoint not found.' }, 404)
      : c.env.ASSETS.fetch(c.req.raw),
  )
  app.onError((_error, c) =>
    c.json({ error: 'Something went wrong. Please try again.' }, 500),
  )
  return app
}

/** Minimal RFC 4180 parser: quoted fields, escaped quotes and CRLF input. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index += 1
        } else quoted = false
      } else field += char
    } else if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') field += char
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((line) => line.some((value) => value.trim() !== ''))
}
