import type { Claim, Evidence, FitResult, Offer } from '../shared/types'

type DraftInput = {
  offer: Offer
  companyName: string
  contactName: string
  contactTitle: string
  evidence: Evidence[]
  fit: FitResult | null
}

const firstName = (name: string): string =>
  name.trim().split(/\s+/)[0] || 'there'

const shorten = (text: string, max: number): string => {
  const value = text.trim().replace(/\s+/g, ' ')
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value
}

const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

const firstSentence = (text: string, max = 180): string => {
  const value = text.trim().replace(/\s+/g, ' ')
  const end = value.search(/[.!?](\s|$)/)
  return shorten(end > 0 ? value.slice(0, end + 1) : value, max)
}

/**
 * Builds a short, specific first message whose only factual claim about the
 * prospect is drawn from a stored evidence excerpt. Sentences about our own
 * offer are marked as offer claims and never require prospect evidence.
 */
export function buildDraft(input: DraftInput): {
  subject: string
  body: string
  claims: Claim[]
} {
  if (!input.evidence.length)
    throw new Error(
      'Write down one thing you found about this business, with the page you saw it on, before writing a message.',
    )

  const primary = input.evidence[0]!
  const observation = firstSentence(primary.excerpt)
  const sourceHost = domainOf(primary.url)
  const outcome =
    input.offer.outcomes
      .split(/\n|;/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(', ') || 'a clearer path from enquiry to booked work'
  const proof = input.offer.proof.trim()
  const signature = input.offer.name.trim() || 'Banks Solutions'
  const role = input.contactTitle.trim()

  const subject = shorten(
    input.fit?.score != null && input.fit.score >= 70
      ? `${input.companyName}: ${shorten(outcome, 48)}`
      : `${input.companyName} — a quick observation`,
    78,
  )

  const lines = [
    `Hi ${firstName(input.contactName)},`,
    '',
    `I was looking at ${input.companyName}${role ? ` and your work as ${role}` : ''} and noticed: ${observation} (source: ${sourceHost}).`,
    '',
    `That is the kind of gap ${signature} works on — we help with ${shorten(outcome, 160)}.`,
  ]
  if (proof) lines.push('', shorten(proof, 220))
  lines.push(
    '',
    `If it is useful I can send a short outline of what we would change first. If not, reply “no” and I will close the file.`,
    '',
    signature,
  )

  const claims: Claim[] = [
    {
      text: observation,
      kind: 'fact',
      evidenceIds: [primary.id],
    },
  ]

  return {
    subject,
    body: lines.join('\n'),
    claims,
  }
}

/** Deterministic claim gate: a fact claim must resolve to evidence on this lead. */
export function auditClaims(
  claims: Claim[],
  evidence: Evidence[],
): { ok: boolean; blocked: string[] } {
  const known = new Map(evidence.map((item) => [item.id, item]))
  const blocked: string[] = []
  for (const claim of claims) {
    if (claim.kind !== 'fact') continue
    if (!claim.evidenceIds.length) {
      blocked.push(`“${shorten(claim.text, 60)}” has nothing behind it.`)
      continue
    }
    for (const id of claim.evidenceIds) {
      const source = known.get(id)
      if (!source) {
        blocked.push(`“${shorten(claim.text, 60)}” points at a note that no longer exists.`)
      } else if (!source.excerpt.trim() || !/^https?:\/\//.test(source.url)) {
        blocked.push(
          `“${shorten(claim.text, 60)}” has a link but no usable quote.`,
        )
      }
    }
  }
  return { ok: blocked.length === 0, blocked }
}

export function parseClaims(raw: string): Claim[] {
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.flatMap((item): Claim[] => {
      if (!item || typeof item !== 'object') return []
      const claim = item as Record<string, unknown>
      if (
        typeof claim.text !== 'string' ||
        (claim.kind !== 'fact' && claim.kind !== 'offer')
      )
        return []
      return [
        {
          text: claim.text,
          kind: claim.kind,
          evidenceIds: Array.isArray(claim.evidenceIds)
            ? claim.evidenceIds.filter(
                (id): id is string => typeof id === 'string',
              )
            : [],
        },
      ]
    })
  } catch {
    return []
  }
}
