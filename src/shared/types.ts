export type Session = {
  user: { sub: string; name?: string; email?: string } | null
  mode: 'local' | 'freebuff' | 'setup'
  database: boolean
}

export type Offer = {
  name: string
  service: string
  outcomes: string
  proof: string
  exclusions: string
  voice: string
  updatedAt: number | null
}

export type IcpFilters = {
  titles: string[]
  industries: string[]
  countries: string[]
  sizes: string[]
  keywords: string[]
  exclusions: string[]
}

export type Icp = {
  id: string
  name: string
  brief: string
  filters: IcpFilters
  createdAt: number
}

export type FitResult = {
  score: number
  decision: 'keep' | 'reject'
  matched: string[]
  failed: string[]
  reason: string
  confidence: number
}

export type LeadStatus =
  | 'new'
  | 'qualified'
  | 'held'
  | 'approved'
  | 'contacted'
  | 'replied'
  | 'won'
  | 'lost'

export type Verdict =
  | 'safe'
  | 'risky'
  | 'invalid'
  | 'disposable'
  | 'unknown'

export type Verification = {
  verdict: Verdict
  label: string
  detail: string
  sendable: boolean
}

export type Claim = {
  text: string
  kind: 'fact' | 'offer'
  evidenceIds: string[]
}

export type Draft = {
  id: string
  subject: string
  body: string
  claims: Claim[]
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
  decidedAt: number | null
}

export type Evidence = {
  id: string
  url: string
  sourceType: string
  excerpt: string
  observedAt: number
}

export type LeadSummary = {
  id: string
  company: {
    id: string
    name: string
    domain: string
    industry: string
    size: string
    country: string
  }
  contact: {
    id: string
    name: string
    title: string
    email: string
  }
  status: LeadStatus
  score: number | null
  fit: FitResult | null
  source: string
  evidenceCount: number
  pendingDrafts: number
  verification: Verification
  suppressed: boolean
  createdAt: number
  updatedAt: number
}

export type LeadDetail = LeadSummary & {
  evidence: Evidence[]
  drafts: Draft[]
  messages: Message[]
}

export type ReviewItem = {
  draft: Draft
  lead: LeadSummary
  blocked: string[]
  evidence: Evidence[]
}

export type Overview = {
  totals: {
    leads: number
    qualified: number
    approved: number
    contacted: number
    replied: number
    pendingDrafts: number
    evidence: number
    needsYou: number
  }
  offerSaved: boolean
  icpCount: number
  byStatus: { status: LeadStatus; count: number }[]
  needsAttention: {
    unscored: number
    withoutEvidence: number
    held: number
    suppressed: number
  }
  usage: { eventType: string; units: number }[]
  recent: Activity[]
}

export type Activity = {
  id: string
  action: string
  objectType: string
  objectId: string
  detail: string
  createdAt: number
}

export type ReplyCategory =
  | 'positive'
  | 'question'
  | 'negative'
  | 'opt-out'
  | 'out-of-office'
  | 'referral'
  | 'bounce'
  | 'unknown'

export type Message = {
  id: string
  leadId: string
  direction: 'out' | 'in'
  subject: string
  body: string
  fromEmail: string
  toEmail: string
  status: 'sent' | 'failed' | 'received'
  category: ReplyCategory | null
  positive: boolean
  confidence: number
  reason: string
  handled: boolean
  createdAt: number
}

export type ReplyItem = {
  message: Message
  lead: LeadSummary
}

/** What a send attempt would do, so the UI can block before calling. */
export type SendReadiness = {
  mailReady: boolean
  sentToday: number
  dailyCap: number
}

export type PlaceCandidate = {
  placeId: string
  name: string
  address: string
  website: string
  category: string
  phone: string
  closed: boolean
  alreadyAdded?: boolean
}

export type Suppression = {
  id: string
  value: string
  reason: string
  createdAt: number
}

export type ImportResult = {
  created: number
  duplicates: number
  invalid: number
  errors: string[]
}

export const LEAD_STATUSES: LeadStatus[] = [
  'new',
  'qualified',
  'held',
  'approved',
  'contacted',
  'replied',
  'won',
  'lost',
]

export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '500+']
