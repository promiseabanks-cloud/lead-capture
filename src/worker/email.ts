import type { Verdict, Verification } from '../shared/types'

/**
 * Deterministic address checks only. No mailbox probe and no network lookup is
 * performed, so a "safe" verdict means the address passed syntax and policy
 * rules, not that the mailbox exists or that the recipient consented.
 */
const DISPOSABLE = new Set([
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
  'trashmail.com',
  'sharklasers.com',
  'getnada.com',
  'dispostable.com',
  'throwawaymail.com',
  'maildrop.cc',
])

const ROLE = new Set([
  'info',
  'sales',
  'support',
  'admin',
  'hello',
  'contact',
  'help',
  'billing',
  'accounts',
  'office',
  'enquiries',
  'inquiries',
  'marketing',
  'noreply',
  'no-reply',
  'webmaster',
  'postmaster',
  'team',
])

const FORMAT = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')
}

export function verifyEmail(input: string): Verification {
  const email = normalizeEmail(input)
  if (!email)
    return {
      verdict: 'unknown',
      label: 'No address',
      detail: 'No email address is on file for this contact.',
      sendable: false,
    }
  if (!FORMAT.test(email) || email.length > 254)
    return {
      verdict: 'invalid',
      label: 'Invalid',
      detail: 'The address does not have a valid mailbox@domain shape.',
      sendable: false,
    }
  const domain = email.split('@')[1]!
  if (DISPOSABLE.has(domain))
    return {
      verdict: 'disposable',
      label: 'Disposable',
      detail: 'The domain is a known throwaway inbox. Never send.',
      sendable: false,
    }
  const mailbox = email.split('@')[0]!
  if (ROLE.has(mailbox))
    return {
      verdict: 'risky',
      label: 'Role address',
      detail:
        'A shared or role mailbox (for example info@). Held for review; a named contact is preferred.',
      sendable: false,
    }
  return {
    verdict: 'safe',
    label: 'Checked',
    detail:
      'Syntax and policy checks passed. Mailbox existence was not probed, so delivery is not guaranteed.',
    sendable: true,
  }
}

export function verdictFrom(value: string): Verdict {
  return ['safe', 'risky', 'invalid', 'disposable', 'unknown'].includes(value)
    ? (value as Verdict)
    : 'unknown'
}

export function isSuppressed(
  email: string,
  entries: { value: string }[],
): boolean {
  const address = normalizeEmail(email)
  if (!address) return false
  const domain = address.split('@')[1] || ''
  return entries.some((entry) => {
    const blocked = entry.value.trim().toLowerCase()
    return blocked === address || blocked === domain
  })
}
