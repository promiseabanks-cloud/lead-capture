import type { Env } from './auth'

/**
 * Mailgun: POST /v3/{domain}/messages sends; an inbound Route forwards each
 * reply to our webhook, signed with HMAC-SHA256(timestamp + token) using the
 * account's webhook signing key (not the API key).
 */
const DEFAULT_BASE = 'https://api.mailgun.net'

export function mailReady(env: Env): boolean {
  return Boolean(env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN && env.MAIL_FROM)
}

export function replyDomain(env: Env): string {
  return (env.MAIL_REPLY_DOMAIN || env.MAILGUN_DOMAIN || '').trim()
}

export function replyAddress(env: Env, leadId: string): string {
  const domain = replyDomain(env)
  return domain ? `reply+${leadId}@${domain}` : ''
}

/** Pulls the lead id back out of reply+<leadId>@domain. */
export function leadIdFromAddress(address: string): string | null {
  const match = address.trim().match(/reply\+([A-Za-z0-9-]{8,64})@/i)
  return match ? match[1]!.toLowerCase() : null
}

const base = (env: Env): string =>
  (env.MAILGUN_BASE_URL || DEFAULT_BASE).replace(/\/$/, '')

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: string; status?: number }

export async function sendMail(
  env: Env,
  input: { to: string; subject: string; text: string; replyTo?: string },
): Promise<SendResult> {
  if (!mailReady(env))
    return {
      ok: false,
      error:
        'Email sending is not switched on yet. Add your Mailgun key, domain and sender address.',
    }
  const form = new FormData()
  form.set('from', env.MAIL_FROM!)
  form.set('to', input.to)
  form.set('subject', input.subject)
  form.set('text', input.text)
  if (input.replyTo) form.set('h:Reply-To', input.replyTo)

  let response: Response
  try {
    response = await fetch(`${base(env)}/v3/${env.MAILGUN_DOMAIN}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}`,
      },
      body: form,
    })
  } catch {
    return { ok: false, error: 'Could not reach the email service.' }
  }
  const body = (await response.json().catch(() => null)) as
    | { id?: string; message?: string }
    | null
  if (!response.ok || !body?.id)
    return {
      ok: false,
      status: response.status,
      error:
        response.status === 401 || response.status === 403
          ? 'The email service refused these credentials. Check the API key and that the domain is set up for sending.'
          : 'The email service could not send that message.',
    }
  return { ok: true, id: body.id }
}

const encoder = new TextEncoder()

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const same = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1)
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

export async function verifyMailgunSignature(
  env: Env,
  fields: { timestamp?: unknown; token?: unknown; signature?: unknown },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ ok: boolean; token?: string; reason?: string }> {
  const secret = env.MAILGUN_WEBHOOK_KEY
  if (!secret) return { ok: false, reason: 'No webhook signing key configured.' }
  const timestamp = String(fields.timestamp ?? '')
  const token = String(fields.token ?? '')
  const signature = String(fields.signature ?? '')
  if (!timestamp || !token || !signature)
    return { ok: false, reason: 'Missing signature fields.' }
  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || Math.abs(nowSeconds - seconds) > 3600)
    return { ok: false, reason: 'Signature timestamp is outside the allowed window.' }

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}${token}`),
  )
  return same(hex(digest), signature.trim().toLowerCase())
    ? { ok: true, token }
    : { ok: false, reason: 'Signature does not match.' }
}
