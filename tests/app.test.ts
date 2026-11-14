import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import { createApp } from '../src/worker/app'
import { currentUser, type Env } from '../src/worker/auth'
import { ensureSchema } from '../src/worker/db'

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'test-db',
        compatibilityDate: '2026-11-11',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents:
                'export default { fetch() { return new Response("test") } }',
            },
          },
        },
        env: { DB: { type: 'd1', name: 'growth-test' } },
      },
    },
  ],
  port: 0,
})
let env: Env
let db: D1Database
beforeAll(async () => {
  db = (await runtime.getD1Database('DB')) as unknown as D1Database
  env = {
    DB: db,
    APP_ORIGIN: 'https://app.example.test',
    ASSETS: {
      fetch: async () => new Response('public page'),
    } as unknown as Fetcher,
  }
}, 20_000)
afterAll(() => runtime.dispose())

// This identity seam exists only in the app factory. The Worker entrypoint
// never reads these test headers and always calls the real auth SDK.
const app = createApp(async (request) => {
  const sub = request.headers.get('test-user')
  return sub ? { sub } : null
})
const call = (
  path: string,
  user?: string,
  method = 'GET',
  body?: unknown,
  origin = env.APP_ORIGIN!,
) =>
  app.request(
    `https://app.example.test${path}`,
    {
      method,
      headers: {
        ...(user ? { 'test-user': user } : {}),
        Origin: origin,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )

const json = async <T,>(response: Response): Promise<T> =>
  (await response.json()) as T

beforeEach(async () => {
  await ensureSchema(db)
  await db.batch([
    db.prepare('DELETE FROM leads'),
    db.prepare('DELETE FROM contacts'),
    db.prepare('DELETE FROM companies'),
    db.prepare('DELETE FROM evidence'),
    db.prepare('DELETE FROM drafts'),
    db.prepare('DELETE FROM icps'),
    db.prepare('DELETE FROM offers'),
    db.prepare('DELETE FROM suppressions'),
    db.prepare('DELETE FROM audit_logs'),
    db.prepare('DELETE FROM usage_ledger'),
  ])
})

type Lead = {
  id: string
  status: string
  score: number | null
  fit: { score: number; decision: string; reason: string } | null
  company: { name: string; domain: string }
  contact: { name: string }
  verification: { verdict: string; sendable: boolean }
  suppressed: boolean
  evidenceCount: number
}

const offer = {
  name: 'Banks Solutions',
  service: 'Custom WordPress systems and enquiry automation',
  outcomes: 'fewer missed enquiries; faster follow-up',
  proof: 'We rebuilt enquiry routing for a Lagos property firm.',
  exclusions: 'no guaranteed revenue claims',
  voice: 'plain and specific',
}

const seedIcp = async (user: string) =>
  call('/api/icps', user, 'POST', {
    name: 'Lagos ecommerce ops',
    brief:
      'Ecommerce businesses in Lagos with 11-50 staff, head of operations',
  })

const createLead = async (
  user: string,
  contact = { name: 'Ada Obi', title: 'Head of Operations', email: 'ada@shop.example' },
  company = {
    name: 'Shop Example',
    domain: 'shop.example',
    industry: 'ecommerce',
    size: '11-50',
    country: 'Lagos',
  },
) =>
  json<{ lead: Lead }>(
    await call('/api/leads', user, 'POST', { company, contact, source: 'manual' }),
  )

test('unauthenticated data routes refuse access while public assets stay public', async () => {
  for (const [path, method] of [
    ['/api/leads', 'GET'],
    ['/api/leads', 'POST'],
    ['/api/overview', 'GET'],
    ['/api/review', 'GET'],
    ['/api/export', 'GET'],
  ]) {
    const response = await call(path!, undefined, method)
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  }
  expect(await (await call('/')).text()).toBe('public page')
  expect((await call('/api/health')).status).toBe(200)
})

test('offer, ICP and leads are scoped to the signed-in owner', async () => {
  const saved = await call('/api/offer', 'alice', 'PUT', offer)
  expect(saved.status).toBe(200)
  expect((await call('/api/offer', 'bob')).status).toBe(200)
  expect(
    (await json<{ offer: { name: string } }>(await call('/api/offer', 'bob'))).offer
      .name,
  ).toBe('')

  const icp = await seedIcp('alice')
  expect(icp.status).toBe(201)
  const parsed = (
    await json<{ icp: { filters: { industries: string[]; titles: string[] } } }>(icp)
  ).icp.filters
  expect(parsed.industries).toContain('ecommerce')
  expect(parsed.titles).toContain('head of operations')

  const { lead } = await createLead('alice')
  expect(lead.id).toBeTruthy()

  const alice = await json<{ leads: Lead[] }>(await call('/api/leads', 'alice'))
  expect(alice.leads).toHaveLength(1)
  const bob = await json<{ leads: Lead[] }>(await call('/api/leads', 'bob'))
  expect(bob.leads).toHaveLength(0)
  expect((await call(`/api/leads/${lead.id}`, 'bob')).status).toBe(404)
  expect(
    (await call(`/api/leads/${lead.id}`, 'bob', 'DELETE')).status,
  ).toBe(404)
  expect(
    (
      await call(`/api/leads/${lead.id}`, 'bob', 'PATCH', {
        status: 'won',
      })
    ).status,
  ).toBe(404)
  expect((await call(`/api/leads/${lead.id}`, 'alice')).status).toBe(200)
})

test('duplicate prospects are rejected by normalised email and by name', async () => {
  await createLead('alice')
  const sameEmail = await call('/api/leads', 'alice', 'POST', {
    company: { name: 'Another Co' },
    contact: { name: 'A. Obi', email: '  ADA@Shop.Example ' },
  })
  expect(sameEmail.status).toBe(409)

  const withoutEmail = await call('/api/leads', 'alice', 'POST', {
    company: { name: 'No Mail Ltd' },
    contact: { name: 'Chidi Eze' },
  })
  expect(withoutEmail.status).toBe(201)
  const repeat = await call('/api/leads', 'alice', 'POST', {
    company: { name: 'no mail ltd' },
    contact: { name: 'Chidi Eze' },
  })
  expect(repeat.status).toBe(409)
})

test('scoring explains matches and rejects prospects outside the ICP', async () => {
  await seedIcp('alice')
  const { lead } = await createLead('alice')
  const scored = await call(`/api/leads/${lead.id}/score`, 'alice', 'POST', {})
  expect(scored.status).toBe(200)
  const result = await json<{
    fit: { score: number; decision: string; reason: string; matched: string[] }
    status: string
  }>(scored)
  expect(result.fit.score).toBeGreaterThanOrEqual(60)
  expect(result.fit.decision).toBe('keep')
  expect(result.fit.matched).toContain('buyer role')
  expect(result.fit.reason).toContain('matches')
  expect(result.status).toBe('qualified')

  const outsider = await createLead(
    'alice',
    { name: 'Tunde Bello', title: 'Chef', email: 'tunde@bistro.example' },
    {
      name: 'Bistro',
      domain: 'bistro.example',
      industry: 'hospitality',
      size: '1-10',
      country: 'Abuja',
    },
  )
  const rejected = await json<{ fit: { decision: string; score: number } }>(
    await call(`/api/leads/${outsider.lead.id}/score`, 'alice', 'POST', {}),
  )
  expect(rejected.fit.decision).toBe('reject')
  expect(rejected.fit.score).toBeLessThan(60)
})

test('drafts require a saved offer and stored evidence, and approve only when every gate passes', async () => {
  const { lead } = await createLead('alice')
  const noOffer = await call(`/api/leads/${lead.id}/draft`, 'alice', 'POST', {})
  expect(noOffer.status).toBe(400)

  await call('/api/offer', 'alice', 'PUT', offer)
  const noEvidence = await call(`/api/leads/${lead.id}/draft`, 'alice', 'POST', {})
  expect(noEvidence.status).toBe(400)

  const note = await call(`/api/leads/${lead.id}/evidence`, 'alice', 'POST', {
    url: 'https://shop.example/contact',
    excerpt:
      'The contact page lists only a phone number and no enquiry form or booking flow.',
    sourceType: 'website',
  })
  expect(note.status).toBe(201)

  const draft = await json<{
    draft: { id: string; body: string; claims: { kind: string; evidenceIds: string[] }[] }
  }>(await call(`/api/leads/${lead.id}/draft`, 'alice', 'POST', {}))
  expect(draft.draft.body).toContain('Shop Example')
  expect(draft.draft.body).toContain('no enquiry form')
  expect(draft.draft.claims[0]!.kind).toBe('fact')
  expect(draft.draft.claims[0]!.evidenceIds).toHaveLength(1)

  const approved = await call(
    `/api/drafts/${draft.draft.id}/decide`,
    'alice',
    'POST',
    { decision: 'approve' },
  )
  expect(approved.status).toBe(200)
  expect(
    (await json<{ lead: Lead }>(await call(`/api/leads/${lead.id}`, 'alice'))).lead
      .status,
  ).toBe('approved')
  expect(
    (
      await call(`/api/drafts/${draft.draft.id}/decide`, 'alice', 'POST', {
        decision: 'reject',
      })
    ).status,
  ).toBe(409)
})

test('approval is blocked by suppression and by an ineligible address', async () => {
  await call('/api/offer', 'alice', 'PUT', offer)
  const { lead } = await createLead('alice')
  await call(`/api/leads/${lead.id}/evidence`, 'alice', 'POST', {
    url: 'https://shop.example/blog',
    excerpt: 'The blog has no order-tracking page for customers.',
  })
  const draft = await json<{ draft: { id: string } }>(
    await call(`/api/leads/${lead.id}/draft`, 'alice', 'POST', {}),
  )

  await call('/api/suppressions', 'alice', 'POST', {
    value: 'ada@shop.example',
    reason: 'Asked not to be contacted',
  })
  const blocked = await call(
    `/api/drafts/${draft.draft.id}/decide`,
    'alice',
    'POST',
    { decision: 'approve' },
  )
  expect(blocked.status).toBe(409)
  const body = await json<{ blocked: string[] }>(blocked)
  expect(body.blocked.join(' ')).toContain('do-not-contact list')

  const queue = await json<{ items: { blocked: string[] }[] }>(
    await call('/api/review', 'alice'),
  )
  expect(queue.items[0]!.blocked.length).toBeGreaterThan(0)

  await call('/api/leads', 'alice', 'POST', {
    company: { name: 'Role Mail Ltd', industry: 'ecommerce', country: 'Lagos' },
    contact: { name: 'Team', title: 'Operations', email: 'info@rolemail.example' },
  })
  const roleList = await json<{ leads: Lead[] }>(await call('/api/leads', 'alice'))
  const roleLead = roleList.leads.find((item) => item.verification.verdict === 'risky')!
  expect(roleLead.status).toBe('held')
  expect(roleLead.verification.sendable).toBe(false)
})

test('deleting cited evidence blocks the draft that relied on it', async () => {
  await call('/api/offer', 'alice', 'PUT', offer)
  const { lead } = await createLead('alice')
  const note = await json<{ evidence: { id: string } }>(
    await call(`/api/leads/${lead.id}/evidence`, 'alice', 'POST', {
      url: 'https://shop.example/about',
      excerpt: 'Their about page shows three locations but one contact number.',
    }),
  )
  const draft = await json<{ draft: { id: string } }>(
    await call(`/api/leads/${lead.id}/draft`, 'alice', 'POST', {}),
  )
  expect((await call(`/api/evidence/${note.evidence.id}`, 'alice', 'DELETE')).status).toBe(
    200,
  )
  const decision = await call(
    `/api/drafts/${draft.draft.id}/decide`,
    'alice',
    'POST',
    { decision: 'approve' },
  )
  expect(decision.status).toBe(409)
  expect((await json<{ blocked: string[] }>(decision)).blocked.join(' ')).toContain(
    'no longer exists',
  )
})

test('CSV import deduplicates and export returns the workspace rows', async () => {
  const csv = [
    'company,domain,industry,size,country,contact,title,email,source',
    'Alpha Foods,alpha.example,food,11-50,Lagos,Ngozi Achebe,Owner,ngozi@alpha.example,conference',
    'Alpha Foods,alpha.example,food,11-50,Lagos,Ngozi Achebe,Owner,ngozi@alpha.example,conference',
    'Beta Logistics,beta.example,logistics,51-200,Abuja,Sam Bello,Director,sam@beta.example,referral',
    'Broken Co,,food,11-50,Lagos,Bad Email,Owner,not-an-email',
  ].join('\n')
  const imported = await json<{ result: ImportResult }>(
    await call('/api/import', 'alice', 'POST', { csv }),
  )
  expect(imported.result.created).toBe(2)
  expect(imported.result.duplicates).toBe(1)
  expect(imported.result.invalid).toBe(1)

  const exported = await call('/api/export', 'alice')
  expect(exported.headers.get('Content-Type')).toContain('text/csv')
  const text = await exported.text()
  expect(text).toContain('Alpha Foods')
  expect(text.split('\n')).toHaveLength(3)
  const bobExport = await call('/api/export', 'bob')
  expect((await bobExport.text()).split('\n')).toHaveLength(1)
})

test('rejects foreign origins, malformed payloads, oversized bodies and unknown fields', async () => {
  expect(
    (
      await call('/api/leads', 'alice', 'POST', { company: {}, contact: {} }, 'https://foreign.example')
    ).status,
  ).toBe(403)
  expect(
    (
      await app.request(
        'https://app.example.test/api/suppressions',
        {
          method: 'POST',
          headers: { 'test-user': 'alice', 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: 'x@y.example', reason: 'no' }),
        },
        env,
      )
    ).status,
  ).toBe(403)
  for (const body of [
    {},
    { company: { name: 'Only company' } },
    { company: { name: 'A' }, contact: { name: 'B' }, owner_sub: 'bob' },
    { company: { name: 'A' }, contact: { name: 'B', email: 'not-an-email' } },
    [],
    null,
  ]) {
    expect((await call('/api/leads', 'alice', 'POST', body)).status).toBe(400)
  }
  const oversized = await call('/api/leads', 'alice', 'POST', {
    company: { name: 'A' },
    contact: { name: 'B' },
    source: 'x'.repeat(40_000),
  })
  expect(oversized.status).toBe(413)
  const malformed = await app.request(
    'https://app.example.test/api/suppressions',
    {
      method: 'POST',
      headers: {
        'test-user': 'alice',
        Origin: env.APP_ORIGIN!,
        'Content-Type': 'application/json',
      },
      body: 'not JSON',
    },
    env,
  )
  expect(malformed.status).toBe(400)
  expect(
    (await call('/api/leads/absent', 'alice', 'PATCH', { status: 'nonsense' })).status,
  ).toBe(404)
})

test('business search is off without a key, then finds and saves companies', async () => {
  expect(await json<{ configured: boolean }>(await call('/api/find', 'alice'))).toEqual({
    configured: false,
  })
  expect(
    (await call('/api/find', 'alice', 'POST', { query: 'shops in Lagos' })).status,
  ).toBe(503)

  const withKey = { ...env, GOOGLE_PLACES_API_KEY: 'test-key' }
  const seen: { url: string; init?: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    return new Response(
      JSON.stringify({
        places: [
          {
            id: 'p1',
            displayName: { text: 'Ada Fabrics' },
            formattedAddress: '12 Marina Road, Lagos, Nigeria',
            websiteUri: 'https://adafabrics.example',
            primaryTypeDisplayName: { text: 'Fabric store' },
            nationalPhoneNumber: '+234 1 234 5678',
            businessStatus: 'OPERATIONAL',
          },
          {
            id: 'p2',
            displayName: { text: 'Bola Foods' },
            formattedAddress: '5 Broad Street, Lagos, Nigeria',
            websiteUri: 'https://bolafoods.example',
            primaryTypeDisplayName: { text: 'Food store' },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  const request = (path: string, body: unknown) =>
    app.request(
      `https://app.example.test${path}`,
      {
        method: 'POST',
        headers: {
          'test-user': 'alice',
          Origin: env.APP_ORIGIN!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      withKey,
    )

  try {
    const found = await request('/api/find', { query: 'shops in Lagos', limit: 5 })
    expect(found.status).toBe(200)
    const body = await json<{ candidates: { name: string; alreadyAdded: boolean }[] }>(
      found,
    )
    expect(body.candidates).toHaveLength(2)
    expect(body.candidates[0]).toMatchObject({ name: 'Ada Fabrics', alreadyAdded: false })

    expect(seen[0]!.url).toContain('places.googleapis.com/v1/places:searchText')
    const headers = seen[0]!.init!.headers as Record<string, string>
    expect(headers['X-Goog-Api-Key']).toBe('test-key')
    expect(headers['X-Goog-FieldMask']).toContain('places.websiteUri')
    expect(String(seen[0]!.init!.body)).toContain('shops in Lagos')
    expect(String(seen[0]!.init!.body)).toContain('"pageSize":5')

    const saved = await request('/api/find/save', {
      place: {
        placeId: 'p1',
        name: 'Ada Fabrics',
        address: '12 Marina Road, Lagos, Nigeria',
        website: 'https://adafabrics.example',
        category: 'Fabric store',
        phone: '+234 1 234 5678',
      },
    })
    expect(saved.status).toBe(201)
    const savedLead = await json<{ lead: Lead }>(saved)
    expect(savedLead.lead.company.name).toBe('Ada Fabrics')
    expect(savedLead.lead.status).toBe('new')
    expect(savedLead.lead.verification.sendable).toBe(false)

    const list = await json<{ leads: Lead[] }>(await call('/api/leads', 'alice'))
    expect(list.leads).toHaveLength(1)
    expect(list.leads[0]!.company.domain).toBe('adafabrics.example')

    const twice = await request('/api/find/save', {
      place: { name: 'Ada Fabrics', website: 'https://adafabrics.example' },
    })
    expect(twice.status).toBe(409)
  } finally {
    globalThis.fetch = original
  }
})

test('a refused search key is reported without exposing the key', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'API key not valid' } }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch
  try {
    const response = await app.request(
      'https://app.example.test/api/find',
      {
        method: 'POST',
        headers: {
          'test-user': 'alice',
          Origin: env.APP_ORIGIN!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: 'dentists in Abuja' }),
      },
      { ...env, GOOGLE_PLACES_API_KEY: 'secret-key-value' },
    )
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(text).toContain('refused')
    expect(text).not.toContain('secret-key-value')
  } finally {
    globalThis.fetch = original
  }
})

const mailEnv = (): Env => ({
  ...env,
  MAILGUN_API_KEY: 'key-test',
  MAILGUN_DOMAIN: 'mg.example.test',
  MAIL_FROM: 'Banks Solutions <hello@mg.example.test>',
  MAILGUN_WEBHOOK_KEY: 'whsec-test',
  CRON_SECRET: 'cron-test',
  OWNER_NOTIFY_EMAIL: 'owner@example.test',
})

const readyToSend = async (
  user: string,
  contact?: { name: string; title: string; email: string },
  company?: {
    name: string
    domain: string
    industry: string
    size: string
    country: string
  },
) => {
  await call('/api/offer', user, 'PUT', offer)
  const { lead } = await createLead(user, contact, company)
  await call(`/api/leads/${lead.id}/evidence`, user, 'POST', {
    url: 'https://shop.example/contact',
    excerpt: 'The contact page has no enquiry form or booking flow.',
  })
  const draft = await json<{ draft: { id: string } }>(
    await call(`/api/leads/${lead.id}/draft`, user, 'POST', {}),
  )
  const approved = await call(
    `/api/drafts/${draft.draft.id}/decide`,
    user,
    'POST',
    { decision: 'approve' },
  )
  expect(approved.status).toBe(200)
  return { leadId: lead.id, draftId: draft.draft.id }
}

const sendRequest = (leadId: string, draftId: string, target: Env = mailEnv()) =>
  app.request(
    `https://app.example.test/api/leads/${leadId}/send`,
    {
      method: 'POST',
      headers: {
        'test-user': 'alice',
        Origin: env.APP_ORIGIN!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ draftId }),
    },
    target,
  )

const stubMailer = () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ id: `<msg-${calls.length}@mg>` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { calls, restore: () => (globalThis.fetch = original) }
}

const signatureFor = async (timestamp: string, token: string) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('whsec-test'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}${token}`),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const deliverReply = async (input: {
  to: string
  from: string
  subject: string
  body: string
  token?: string
  badSignature?: boolean
}) => {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const token = input.token || crypto.randomUUID().replace(/-/g, '')
  const signature = await signatureFor(timestamp, token)
  const body = new URLSearchParams({
    timestamp,
    token,
    signature: input.badSignature ? signature.replace(/^./, 'f') : signature,
    sender: input.from,
    recipient: input.to,
    subject: input.subject,
    'body-plain': input.body,
  })
  return app.request(
    'https://app.example.test/api/webhooks/mailgun',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    mailEnv(),
  )
}

test('sending stays off until a mailbox is configured, then records what went out', async () => {
  const { leadId, draftId } = await readyToSend('alice')
  expect((await sendRequest(leadId, draftId, env)).status).toBe(503)

  const mailer = stubMailer()
  try {
    const sent = await sendRequest(leadId, draftId)
    expect(sent.status).toBe(200)
    const form = mailer.calls[0]!.init!.body as FormData
    expect(form.get('to')).toBe('ada@shop.example')
    expect(String(form.get('h:Reply-To'))).toContain(`reply+${leadId}@`)
    expect(mailer.calls[0]!.url).toContain('/v3/mg.example.test/messages')

    const detail = await json<{
      lead: { status: string; messages: { direction: string; status: string }[] }
    }>(await call(`/api/leads/${leadId}`, 'alice'))
    expect(detail.lead.status).toBe('contacted')
    expect(detail.lead.messages[0]).toMatchObject({ direction: 'out', status: 'sent' })

    expect((await sendRequest(leadId, draftId)).status).toBe(409)
  } finally {
    mailer.restore()
  }
})

test('a signed reply is stored, labelled and counted as needing attention', async () => {
  const { leadId } = await readyToSend('alice')
  const reply = await deliverReply({
    to: `reply+${leadId}@mg.example.test`,
    from: 'Ada Obi <ada@shop.example>',
    subject: 'Re: quick observation',
    body: 'Thanks for this. Tell me more — can we book a call next week?',
  })
  expect(reply.status).toBe(200)
  expect(await json<{ category: string }>(reply)).toMatchObject({
    category: 'positive',
  })

  const replies = await json<{
    items: { message: { positive: boolean; handled: boolean; category: string } }[]
    needsYou: number
    mailReady: boolean
  }>(
    await app.request(
      'https://app.example.test/api/replies',
      { headers: { 'test-user': 'alice' } },
      mailEnv(),
    ),
  )
  expect(replies.mailReady).toBe(true)
  expect(replies.items).toHaveLength(1)
  expect(replies.items[0]!.message).toMatchObject({
    positive: true,
    handled: false,
    category: 'positive',
  })
  expect(replies.needsYou).toBe(1)

  const detail = await json<{
    lead: { status: string; messages: { direction: string }[] }
  }>(await call(`/api/leads/${leadId}`, 'alice'))
  expect(detail.lead.status).toBe('replied')
  expect(detail.lead.messages).toHaveLength(1)

  const overview = await json<{ totals: { needsYou: number } }>(
    await app.request(
      'https://app.example.test/api/overview',
      { headers: { 'test-user': 'alice' } },
      mailEnv(),
    ),
  )
  expect(overview.totals.needsYou).toBe(1)
})

const signatureFailure = async () => {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const token = 'abc123'
  const body = new URLSearchParams({
    timestamp,
    token,
    signature: await signatureFor(String(Math.floor(Date.now() / 1000) + 5), token),
    sender: 'ada@shop.example',
    recipient: 'reply+00000000-0000-0000-0000-000000000000@mg.example.test',
    subject: 'hi',
    'body-plain': 'hello',
  })
  return app.request(
    'https://app.example.test/api/webhooks/mailgun',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    mailEnv(),
  )
}

test('webhooks reject forgeries and reused tokens', async () => {
  const { leadId } = await readyToSend('alice')
  expect((await signatureFailure()).status).toBe(401)

  const forged = await deliverReply({
    to: `reply+${leadId}@mg.example.test`,
    from: 'ada@shop.example',
    subject: 'Re: hi',
    body: 'interested',
    badSignature: true,
  })
  expect(forged.status).toBe(401)

  const token = 'f'.repeat(40)
  const first = await deliverReply({
    to: `reply+${leadId}@mg.example.test`,
    from: 'ada@shop.example',
    subject: 'Re: hi',
    body: 'Not interested, thanks.',
    token,
  })
  expect(first.status).toBe(200)
  expect(await json<{ category: string }>(first)).toMatchObject({ category: 'negative' })

  const replay = await deliverReply({
    to: `reply+${leadId}@mg.example.test`,
    from: 'ada@shop.example',
    subject: 'Re: hi',
    body: 'Not interested, thanks.',
    token,
  })
  expect(replay.status).toBe(200)
  expect(await json<{ duplicate: boolean }>(replay)).toMatchObject({ duplicate: true })

  const items = await json<{ items: unknown[] }>(
    await app.request(
      'https://app.example.test/api/replies',
      { headers: { 'test-user': 'alice' } },
      mailEnv(),
    ),
  )
  expect(items.items).toHaveLength(1)
})

test('an opt-out reply suppresses the address and blocks the next send', async () => {
  const { leadId, draftId } = await readyToSend('alice')
  const mailer = stubMailer()
  try {
    expect((await sendRequest(leadId, draftId)).status).toBe(200)
    await deliverReply({
      to: `reply+${leadId}@mg.example.test`,
      from: 'Ada Obi <ada@shop.example>',
      subject: 'Re: observation',
      body: 'Please unsubscribe me and stop emailing.',
    })
  } finally {
    mailer.restore()
  }

  const suppressions = await json<{ suppressions: { value: string }[] }>(
    await call('/api/suppressions', 'alice'),
  )
  expect(suppressions.suppressions.map((item) => item.value)).toContain(
    'ada@shop.example',
  )

  const list = await json<{ leads: Lead[] }>(await call('/api/leads', 'alice'))
  expect(list.leads[0]!.suppressed).toBe(true)
})

test('bulk send needs the cron key and respects refusal', async () => {
  await readyToSend('alice')
  const unauthorised = await app.request(
    'https://app.example.test/api/cron/send',
    { method: 'POST', headers: { 'x-cron-key': 'wrong' } },
          mailEnv(),
  )
  expect(unauthorised.status).toBe(401)

  const mailer = stubMailer()
  try {
    const allowed = await app.request(
      'https://app.example.test/api/cron/send',
      { method: 'POST', headers: { 'x-cron-key': 'cron-test' } },
      mailEnv(),
    )
    expect(allowed.status).toBe(200)
    expect(await json<{ sent: number }>(allowed)).toMatchObject({ sent: 1 })
  } finally {
    mailer.restore()
  }
})

test('overview reports the pipeline and missing setup, and no database reports setup', async () => {
  const empty = await json<Overview>(await call('/api/overview', 'alice'))
  expect(empty.offerSaved).toBe(false)
  expect(empty.totals.leads).toBe(0)

  await call('/api/offer', 'alice', 'PUT', offer)
  await seedIcp('alice')
  const { lead } = await createLead('alice')
  await call(`/api/leads/${lead.id}/evidence`, 'alice', 'POST', {
    url: 'https://shop.example/cart',
    excerpt: 'The cart abandons to a plain thank-you page with no order number.',
  })
  const filled = await json<Overview>(await call('/api/overview', 'alice'))
  expect(filled.offerSaved).toBe(true)
  expect(filled.icpCount).toBe(1)
  expect(filled.totals.leads).toBe(1)
  expect(filled.totals.evidence).toBe(1)
  // The ICP existed first, so the prospect was scored on creation.
  expect(filled.needsAttention.unscored).toBe(0)
  const listed = await json<{ leads: Lead[] }>(await call('/api/leads', 'alice'))
  expect(listed.leads[0]!.score).not.toBeNull()
  expect(filled.usage.some((row) => row.eventType === 'research')).toBe(true)
  expect(filled.recent.length).toBeGreaterThan(0)

  const noDb = await app.request(
    'https://app.example.test/api/leads',
    { headers: { 'test-user': 'alice' } },
    { ...env, DB: undefined },
  )
  expect(noDb.status).toBe(503)
  expect(
    await currentUser(new Request('https://app.example.test/'), {} as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {
      APP_ORIGIN: 'https://app.example.test',
    } as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {} as Env),
  ).toMatchObject({ sub: 'local-preview' })
})

type Overview = {
  offerSaved: boolean
  icpCount: number
  totals: { leads: number; evidence: number }
  needsAttention: { unscored: number }
  usage: { eventType: string; units: number }[]
  recent: unknown[]
}
type ImportResult = { created: number; duplicates: number; invalid: number }
