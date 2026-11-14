import type { FitResult, IcpFilters } from '../shared/types'

export const emptyFilters = (): IcpFilters => ({
  titles: [],
  industries: [],
  countries: [],
  sizes: [],
  keywords: [],
  exclusions: [],
})

type Scorable = {
  title: string
  industry: string
  country: string
  size: string
  companyName: string
  email: string
}

const WEIGHTS = {
  titles: 30,
  industries: 25,
  countries: 15,
  sizes: 10,
  keywords: 15,
} as const

const clean = (values: unknown): string[] =>
  Array.isArray(values)
    ? values
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 12)
    : []

export function normalizeFilters(raw: unknown): IcpFilters {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >
  return {
    titles: clean(source.titles),
    industries: clean(source.industries),
    countries: clean(source.countries),
    sizes: clean(source.sizes),
    keywords: clean(source.keywords),
    exclusions: clean(source.exclusions),
  }
}

const contains = (value: string, needle: string): boolean => {
  const haystack = value.trim().toLowerCase()
  const test = needle.trim().toLowerCase()
  return Boolean(haystack && test) && haystack.includes(test)
}

const matchesAny = (value: string, needles: string[]): string | null =>
  needles.find((needle) => contains(value, needle)) ?? null

/**
 * Deterministic, explainable fit scoring against one ICP. Every criterion that
 * the ICP defines contributes a fixed weight, and each result names the matched
 * or failed criteria so the score is never a black box.
 */
export function scoreLead(lead: Scorable, filters: IcpFilters): FitResult {
  const domain = lead.email.split('@')[1] || ''
  const haystack = [lead.companyName, lead.industry, lead.title, domain]
  const exclusion = filters.exclusions.find((term) =>
    haystack.some((field) => contains(field, term)),
  )
  if (exclusion)
    return {
      score: 0,
      decision: 'reject',
      matched: [],
      failed: ['exclusions'],
      reason: `Excluded by the ICP rule “${exclusion}”.`,
      confidence: 0.95,
    }

  const criteria: { key: keyof typeof WEIGHTS; label: string; field: string }[] =
    [
      { key: 'titles', label: 'buyer role', field: lead.title },
      { key: 'industries', label: 'industry', field: lead.industry },
      { key: 'countries', label: 'location', field: lead.country },
      { key: 'sizes', label: 'company size', field: lead.size },
      {
        key: 'keywords',
        label: 'keyword signal',
        field: `${lead.companyName} ${lead.title} ${lead.industry}`,
      },
    ]

  const active = criteria.filter((c) => filters[c.key].length > 0)
  if (!active.length)
    return {
      score: 0,
      decision: 'reject',
      matched: [],
      failed: ['icp'],
      reason:
        'This ICP has no criteria yet, so nothing can be scored. Add roles, industries, locations or keywords.',
      confidence: 0.2,
    }

  const total = active.reduce((sum, c) => sum + WEIGHTS[c.key], 0)
  let earned = 0
  const matched: string[] = []
  const failed: string[] = []
  const parts: string[] = []

  for (const criterion of active) {
    const hit = matchesAny(criterion.field, filters[criterion.key])
    if (hit) {
      earned += WEIGHTS[criterion.key]
      matched.push(criterion.label)
      parts.push(`${criterion.label} matches “${hit}”`)
    } else {
      failed.push(criterion.label)
      const wanted = filters[criterion.key].slice(0, 3).join(', ')
      parts.push(
        `${criterion.label} ${criterion.field ? `“${criterion.field}”` : 'is empty'} does not match ${wanted}`,
      )
    }
  }

  const score = Math.round((earned / total) * 100)
  const coverage = active.length / 5
  return {
    score,
    decision: score >= 60 ? 'keep' : 'reject',
    matched,
    failed,
    reason: parts.join('; ') + '.',
    confidence: Math.min(0.9, 0.45 + coverage * 0.4),
  }
}

const INDUSTRIES = [
  'real estate',
  'property',
  'logistics',
  'freight',
  'fintech',
  'finance',
  'banking',
  'insurance',
  'ecommerce',
  'e-commerce',
  'retail',
  'healthcare',
  'health',
  'clinic',
  'hospital',
  'legal',
  'law',
  'accounting',
  'manufacturing',
  'construction',
  'education',
  'school',
  'hospitality',
  'hotel',
  'restaurant',
  'technology',
  'software',
  'marketing',
  'agency',
  'consulting',
  'travel',
  'nonprofit',
  'agriculture',
]

const COUNTRIES = [
  'nigeria',
  'lagos',
  'abuja',
  'ghana',
  'kenya',
  'south africa',
  'united kingdom',
  'uk',
  'united states',
  'usa',
  'us',
  'canada',
  'australia',
  'uae',
  'dubai',
  'india',
  'germany',
  'france',
]

const TITLES = [
  'founder',
  'co-founder',
  'ceo',
  'managing director',
  'owner',
  'director',
  'head of operations',
  'operations manager',
  'marketing manager',
  'head of marketing',
  'cto',
  'coo',
  'cfo',
  'partner',
  'manager',
  'lead',
]

const SIZES = ['1-10', '11-50', '51-200', '201-500', '500+']

const STOPWORDS = new Set([
  'the',
  'and',
  'with',
  'that',
  'their',
  'they',
  'who',
  'for',
  'from',
  'into',
  'have',
  'has',
  'are',
  'will',
  'need',
  'needs',
  'want',
  'wants',
  'business',
  'businesses',
  'company',
  'companies',
  'small',
  'medium',
  'large',
  'looking',
  'like',
  'help',
  'helps',
  'our',
  'your',
  'you',
  'them',
  'more',
  'most',
  'about',
  'over',
  'under',
  'than',
  'then',
  'when',
  'where',
  'which',
  'this',
  'there',
  'these',
  'those',
  'team',
  'teams',
  'also',
  'well',
  'just',
  'very',
  'can',
  'could',
  'should',
  'would',
  'make',
  'makes',
  'using',
  'use',
  'used',
  'get',
  'gets',
  'out',
  'not',
  'but',
  'all',
  'any',
  'each',
])

/**
 * Rule-based ICP interpreter: it extracts a starting filter set from a plain
 * English brief. It is deliberately deterministic and editable in the UI rather
 * than a model call, so nothing here is presented as AI inference.
 */
export function parseBrief(brief: string): IcpFilters {
  const text = brief.toLowerCase()
  const and = (vocab: string[], limit: number) =>
    vocab
      .filter((word) =>
        new RegExp(`(^|[^a-z0-9])${word.replace(/[+]/g, '\\+')}([^a-z0-9]|$)`).test(
          text,
        ),
      )
      .slice(0, limit)

  const words = text
    .split(/[^a-z0-9-]+/)
    .filter((word) => word.length > 3 && !STOPWORDS.has(word))

  const filters: IcpFilters = {
    titles: and(TITLES, 5),
    industries: and(INDUSTRIES, 5),
    countries: and(COUNTRIES, 5),
    sizes: SIZES.filter((size) => text.includes(size)),
    keywords: [...new Set(words)].slice(0, 6),
    exclusions: [],
  }

  const exclusionMatch = text.match(
    /(?:exclude|excluding|avoid|no) ([a-z0-9 ,-]{3,60})/,
  )
  if (exclusionMatch)
    filters.exclusions = exclusionMatch[1]!
      .split(/,| and /)
      .map((part) => part.trim())
      .filter((part) => part.length > 2)
      .slice(0, 3)

  return filters
}
