import type { ReplyCategory } from '../shared/types'

export type Classification = {
  category: ReplyCategory
  positive: boolean
  confidence: number
  reason: string
}

const has = (text: string, phrases: string[]): string | null =>
  phrases.find((phrase) => text.includes(phrase)) ?? null

/**
 * Rule-based reply triage. Deterministic on purpose: the same message always
 * gets the same label, and the reason names the phrase that decided it. It
 * never invents sentiment the text does not contain.
 */
export function classifyReply(input: {
  subject?: string
  body: string
  from?: string
}): Classification {
  const text = `${input.subject || ''}\n${input.body || ''}`.toLowerCase()
  const from = (input.from || '').toLowerCase()

  const bounce = has(text, [
    'undeliverable',
    'delivery status notification',
    'message not delivered',
    'address not found',
    'mailbox unavailable',
    'delivery has failed',
  ])
  if (
    bounce ||
    from.includes('mailer-daemon') ||
    from.includes('postmaster')
  )
    return {
      category: 'bounce',
      positive: false,
      confidence: 0.95,
      reason: 'A delivery failure notice, not a person replying.',
    }

  const optOut = has(text, [
    'unsubscribe',
    'remove me',
    'take me off',
    'stop emailing',
    'stop contacting',
    'do not contact',
    "don't contact",
    'opt out',
    'opt-out',
    'no more emails',
  ])
  if (optOut)
    return {
      category: 'opt-out',
      positive: false,
      confidence: 0.92,
      reason: `Asked to stop: “${optOut}”.`,
    }

  const away = has(text, [
    'out of office',
    'out of the office',
    'annual leave',
    'on leave',
    'maternity leave',
    'paternity leave',
    'automatic reply',
    'auto-reply',
    'autoreply',
    'currently away',
    'will be back',
  ])
  if (away)
    return {
      category: 'out-of-office',
      positive: false,
      confidence: 0.9,
      reason: `Automatic away message: “${away}”.`,
    }

  const negative = has(text, [
    'not interested',
    'no thanks',
    'no thank you',
    'not a fit',
    'already have',
    'no budget',
    "we're good",
    'we are good',
    'not looking',
    'please stop',
  ])
  if (negative)
    return {
      category: 'negative',
      positive: false,
      confidence: 0.86,
      reason: `Declined: “${negative}”.`,
    }

  const referral = has(text, [
    'speak to',
    'talk to',
    'the right person',
    'contact my colleague',
    "cc'ing",
    'cc’ing',
    'forwarded your',
    'introduce you',
  ])
  if (referral)
    return {
      category: 'referral',
      positive: false,
      confidence: 0.7,
      reason: `Points to someone else: “${referral}”.`,
    }

  const positive = has(text, [
    'interested',
    'tell me more',
    'send me',
    'send over',
    'book a call',
    'schedule a call',
    'set up a call',
    'happy to chat',
    "let's talk",
    'lets talk',
    'sounds good',
    'yes please',
    'how much',
    'pricing',
    'proposal',
    'available for a call',
    'can we meet',
    'keen to',
  ])
  if (positive)
    return {
      category: 'positive',
      positive: true,
      confidence: 0.82,
      reason: `Sounds open to talking: “${positive}”.`,
    }

  if (text.includes('?'))
    return {
      category: 'question',
      positive: false,
      confidence: 0.4,
      reason: 'Asks a question but gives no clear signal either way.',
    }

  return {
    category: 'unknown',
    positive: false,
    confidence: 0.2,
    reason: 'No clear signal either way — read it yourself.',
  }
}
