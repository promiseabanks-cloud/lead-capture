import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
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
  PlaceCandidate,
  ReplyItem,
  ReviewItem,
  Session,
  Suppression,
  Verification,
} from '../shared/types'
import { COMPANY_SIZES, LEAD_STATUSES } from '../shared/types'
import './style.css'

type BlockedError = Error & { blocked?: string[] }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string; blocked?: string[] })
    | null
  if (!response.ok) {
    const error = new Error(
      body?.error || 'The request failed. Please try again.',
    ) as BlockedError
    error.blocked = body?.blocked
    throw error
  }
  return body as T
}

const fail = (error: unknown, fallback: string): string => {
  if (!(error instanceof Error)) return fallback
  const blocked = (error as BlockedError).blocked
  return blocked?.length ? `${error.message}\n${blocked.join('\n')}` : error.message
}

const post = (url: string, body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const date = (value: number): string =>
  new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })

const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'Not checked',
  qualified: 'Good match',
  held: 'Needs a person',
  approved: 'Message approved',
  contacted: 'Messaged',
  replied: 'Replied',
  won: 'Client',
  lost: 'Not a fit',
}

type Tab =
  | 'overview'
  | 'find'
  | 'prospects'
  | 'replies'
  | 'review'
  | 'playbook'
  | 'guardrails'
  | 'activity'

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'overview', label: 'Home', hint: 'Where everything stands today' },
  { id: 'find', label: 'Find businesses', hint: 'Search for companies that need what you sell' },
  { id: 'prospects', label: 'Businesses', hint: 'The people and companies you want to work with' },
  { id: 'replies', label: 'Replies', hint: 'Who answered, and whether it is good news' },
  { id: 'review', label: 'Check messages', hint: 'Read each message before anything goes out' },
  { id: 'playbook', label: 'What we sell', hint: 'Your service, and the customers you want' },
  { id: 'guardrails', label: 'Do not contact', hint: 'People who must never be messaged' },
  { id: 'activity', label: 'History', hint: 'Everything that has happened, in order' },
]

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [fatal, setFatal] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [openLead, setOpenLead] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light'
    const saved = window.localStorage.getItem('bge-theme')
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      window.localStorage.setItem('bge-theme', theme)
    } catch {
      // Storage can be blocked; the theme still applies for this visit.
    }
  }, [theme])

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const current = await api<Session>('/api/session')
        if (live) setSession(current)
      } catch (error) {
        if (live) setFatal(fail(error, 'Could not reach your workspace.'))
      } finally {
        if (live) setReady(true)
      }
    })()
    return () => {
      live = false
    }
  }, [])

  const refresh = () => setVersion((value) => value + 1)
  const go = (next: Tab) => {
    setTab(next)
    setOpenLead(null)
  }

  if (!ready)
    return (
      <div className="center">
        <p className="muted">Loading your workspace…</p>
      </div>
    )

  if (fatal)
    return (
      <div className="center">
        <div className="card narrow">
          <h1>Workspace unavailable</h1>
          <p className="muted">{fatal}</p>
        </div>
      </div>
    )

  if (!session?.user || !session.database)
    return (
      <div className="center">
        <div className="card narrow">
          <span className="eyebrow">Banks Growth Engine</span>
          <h1>
            {session?.mode === 'freebuff'
              ? 'Sign in to open your workspace'
              : 'Sign in is not configured for this origin'}
          </h1>
          <p className="muted">
            {session?.mode === 'freebuff'
              ? 'Your businesses, notes and messages are private to your account.'
              : session?.database
                ? 'Private workspace data stays locked until Sign in with Freebuff is provisioned for this origin.'
                : 'Nothing can be saved yet because no database is connected.'}
          </p>
          {session?.mode === 'freebuff' ? (
            <a className="button" href="/auth/freebuff/signin?returnTo=%2F">
              Sign in with Freebuff
            </a>
          ) : (
            <p className="muted small">
              Run the app on your own machine (`bun run dev` on localhost) to work
              with the local preview identity, or provision sign-in and publish.
            </p>
          )}
        </div>
      </div>
    )

  const active = TABS.find((item) => item.id === tab)!
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">BG</span>
          <div>
            <strong>Banks Growth Engine</strong>
            <small>Finding new clients</small>
          </div>
        </div>
        <nav aria-label="Workspace">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={tab === item.id && !openLead ? 'nav active' : 'nav'}
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => go(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>{session.user.name || session.user.email || 'Signed in'}</span>
          {session.mode === 'freebuff' ? (
            <form method="post" action="/auth/freebuff/signout">
              <button className="quiet small">Sign out</button>
            </form>
          ) : (
            <span className="badge">Local preview</span>
          )}
        </div>
      </aside>
      <main className="main">
        <header className="page-head">
          <div>
            <span className="eyebrow">
              {openLead ? 'Business details' : active.label}
            </span>
            <h1>{openLead ? 'One business' : active.label}</h1>
            <p className="muted small">{active.hint}</p>
          </div>
          <button
            className="quiet small theme-toggle"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-pressed={theme === 'dark'}
          >
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
        </header>
        {openLead ? (
          <LeadPanel
            id={openLead}
            version={version}
            onBack={() => setOpenLead(null)}
            onRefresh={refresh}
          />
        ) : tab === 'overview' ? (
          <Overview version={version} onGo={go} onOpenLead={setOpenLead} />
        ) : tab === 'find' ? (
          <FindBusinesses
            version={version}
            onOpen={setOpenLead}
            onRefresh={refresh}
          />
        ) : tab === 'prospects' ? (
          <Prospects
            version={version}
            onOpen={setOpenLead}
            onRefresh={refresh}
          />
        ) : tab === 'replies' ? (
          <Replies version={version} onRefresh={refresh} onOpen={setOpenLead} />
        ) : tab === 'review' ? (
          <ReviewQueue version={version} onRefresh={refresh} onOpen={setOpenLead} />
        ) : tab === 'playbook' ? (
          <Playbook version={version} onRefresh={refresh} />
        ) : tab === 'guardrails' ? (
          <Guardrails version={version} onRefresh={refresh} />
        ) : (
          <ActivityLog version={version} />
        )}
      </main>
    </div>
  )
}

/* ------------------------------------------------------------------ overview */

function Overview({
  version,
  onGo,
  onOpenLead,
}: {
  version: number
  onGo: (tab: Tab) => void
  onOpenLead: (id: string) => void
}) {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const next = await api<Overview>('/api/overview')
        if (live) {
          setData(next)
          setError('')
        }
      } catch (problem) {
        if (live) setError(fail(problem, 'Could not load the overview.'))
      }
    })()
    return () => {
      live = false
    }
  }, [version])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading your dashboard…</p>

  const steps = [
    {
      done: data.offerSaved,
      label: 'Say what you sell',
      detail: 'A few lines about your service and the result the customer gets.',
      action: () => onGo('playbook'),
      cta: 'Write it',
    },
    {
      done: data.icpCount > 0,
      label: 'Describe your perfect customer',
      detail: 'Write it in your own words. We turn it into simple tick-boxes you can change.',
      action: () => onGo('playbook'),
      cta: 'Describe them',
    },
    {
      done: data.totals.leads > 0,
      label: 'Add businesses',
      detail: 'Paste a list, or add one business and one person at a time.',
      action: () => onGo('prospects'),
      cta: 'Add businesses',
    },
    {
      done: data.totals.evidence > 0,
      label: 'Write down what you found',
      detail: 'One note per business, with the page where you saw it.',
      action: () => onGo('prospects'),
      cta: 'Open a business',
    },
  ]

  return (
    <div className="stack">
      <div className="stats">
        {[
          ['Businesses', data.totals.leads],
          ['Good matches', data.totals.qualified],
          ['Messages to read', data.totals.pendingDrafts],
          ['Need your reply', data.totals.needsYou],
        ].map(([label, value]) => (
          <div className="card stat" key={label}>
            <span className="muted small">{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <div className="split">
        <section className="card">
          <h2>What to do next</h2>
          <ul className="checklist">
            {steps.map((step) => (
              <li key={step.label} className={step.done ? 'done' : ''}>
                <span className="tick" aria-hidden="true">
                  {step.done ? '✓' : '•'}
                </span>
                <div>
                  <strong>{step.label}</strong>
                  <p className="muted small">{step.detail}</p>
                </div>
                {!step.done && (
                  <button className="quiet small" onClick={step.action}>
                    {step.cta}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2>Worth a look</h2>
          <dl className="facts">
            <div>
              <dt>Not checked yet</dt>
              <dd>{data.needsAttention.unscored}</dd>
            </div>
            <div>
              <dt>No notes written</dt>
              <dd>{data.needsAttention.withoutEvidence}</dd>
            </div>
            <div>
              <dt>Waiting for you</dt>
              <dd>{data.needsAttention.held}</dd>
            </div>
            <div>
              <dt>Messages to read</dt>
              <dd>{data.totals.pendingDrafts}</dd>
            </div>
          </dl>
          {data.totals.pendingDrafts > 0 && (
            <button onClick={() => onGo('review')}>Read the messages</button>
          )}
          <h3 className="section-title">Where things stand</h3>
          <ul className="status-list">
            {data.byStatus.length ? (
              data.byStatus.map((row) => (
                <li key={row.status}>
                  <span className={`chip ${row.status}`}>
                    {STATUS_LABEL[row.status]}
                  </span>
                  <span className="muted small">{row.count}</span>
                </li>
              ))
            ) : (
              <li className="muted small">No businesses added yet.</li>
            )}
          </ul>
        </section>
      </div>

      <section className="card">
        <div className="row-between">
          <h2>Latest activity</h2>
          <button className="quiet small" onClick={() => onGo('activity')}>
            See all history
          </button>
        </div>
        <ActivityList items={data.recent} onOpenLead={onOpenLead} />
      </section>
    </div>
  )
}

function ActivityList({
  items,
  onOpenLead,
}: {
  items: Activity[]
  onOpenLead?: (id: string) => void
}) {
  if (!items.length)
    return <p className="muted small">Nothing here yet.</p>
  return (
    <ul className="feed">
      {items.map((item) => (
        <li key={item.id}>
          <div>
            <span className="action">{item.action}</span>
            <p className="small">{item.detail}</p>
          </div>
          <div className="feed-meta">
            <time dateTime={new Date(item.createdAt).toISOString()}>
              {date(item.createdAt)}
            </time>
            {onOpenLead && item.objectType === 'lead' && (
              <button className="link" onClick={() => onOpenLead(item.objectId)}>
                Open
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------ find businesses */

function FindBusinesses({
  version,
  onOpen,
  onRefresh,
}: {
  version: number
  onOpen: (id: string) => void
  onRefresh: () => void
}) {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [what, setWhat] = useState('')
  const [where, setWhere] = useState('')
  const [results, setResults] = useState<PlaceCandidate[] | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const result = await api<{ configured: boolean }>('/api/find')
        if (live) setConfigured(result.configured)
      } catch (problem) {
        if (live) setError(fail(problem, 'Could not check the search setup.'))
      }
    })()
    return () => {
      live = false
    }
  }, [version])

  async function search(event: React.FormEvent) {
    event.preventDefault()
    setBusy('search')
    setError('')
    try {
      const query = where.trim()
        ? `${what.trim()} in ${where.trim()}`
        : what.trim()
      const result = await api<{ candidates: PlaceCandidate[] }>(
        '/api/find',
        post('/api/find', { query, limit: 10 }),
      )
      setResults(result.candidates)
    } catch (problem) {
      setError(fail(problem, 'The search failed. Please try again.'))
      setResults(null)
    } finally {
      setBusy('')
    }
  }

  async function add(candidate: PlaceCandidate) {
    const key = candidate.placeId || candidate.name
    setBusy(key)
    setError('')
    try {
      await api(
        '/api/find/save',
        post('/api/find/save', {
          place: {
            placeId: candidate.placeId,
            name: candidate.name,
            address: candidate.address,
            website: candidate.website,
            category: candidate.category,
            phone: candidate.phone,
          },
        }),
      )
      setResults((current) =>
        current
          ? current.map((item) =>
              item.placeId === candidate.placeId
                ? { ...item, alreadyAdded: true }
                : item,
            )
          : current,
      )
      onRefresh()
    } catch (problem) {
      setError(fail(problem, 'Could not add that business.'))
    } finally {
      setBusy('')
    }
  }

  if (configured === null)
    return <p className="muted">Checking the search setup…</p>

  if (!configured)
    return (
      <div className="stack">
        <section className="card">
          <h2>Business search is not switched on yet</h2>
          <p className="muted small">
            This page asks Google for companies by what they do and where they
            are. Google needs a key from you before it will answer. One key is
            enough and you only pay for searches you run.
          </p>
          <ol className="steps">
            <li>
              In Google Cloud, turn on <strong>Places API (New)</strong> and
              create an API key. Turn on billing on that project.
            </li>
            <li>
              Copy the key. Do not paste it in this chat — keep it out of
              messages.
            </li>
            <li>
              Open this project in Freebuff → <strong>Sites</strong> →{' '}
              <strong>Secrets</strong> and add a secret named{' '}
              <code>GOOGLE_PLACES_API_KEY</code> with the key as its value, for
              the Production environment.
            </li>
            <li>Tell me when it is saved and I will make sure it is live.</li>
          </ol>
          <p className="muted small">
            Until then you can still add businesses by hand or paste a list you
            already have.
          </p>
        </section>
      </div>
    )

  return (
    <div className="stack">
      <section className="card">
        <h2>Find companies that need what you sell</h2>
        <p className="muted small">
          Results come from Google's business listing. They give you the
          company, its website and its address — not a person's name or email.
          Adding one creates a business on your list for you to fill in the
          person.
        </p>
        <form onSubmit={search} className="form-grid">
          <label>
            What are you looking for?
            <input
              required
              maxLength={200}
              placeholder="online shops, law firms, hotels"
              value={what}
              onChange={(event) => setWhat(event.target.value)}
            />
          </label>
          <label>
            Where?
            <input
              maxLength={100}
              placeholder="Lagos, Nigeria"
              value={where}
              onChange={(event) => setWhere(event.target.value)}
            />
          </label>
          <div className="form-actions">
            <span className="muted small">10 results per search.</span>
            <button disabled={busy === 'search' || !what.trim()}>
              {busy === 'search' ? 'Searching…' : 'Search'}
            </button>
          </div>
        </form>
        {error && <p className="error">{error}</p>}
      </section>

      {results &&
        (results.length ? (
          <section className="card">
            <div className="row-between">
              <h2>{results.length} businesses found</h2>
              <span className="muted small">Company data from Google</span>
            </div>
            <ul className="find-list">
              {results.map((candidate) => (
                <li key={candidate.placeId || candidate.name}>
                  <div>
                    <strong>{candidate.name}</strong>
                    <p className="muted small">
                      {[candidate.category, candidate.address]
                        .filter(Boolean)
                        .join(' · ') || 'No details'}
                    </p>
                    {candidate.website && (
                      <a
                        className="small"
                        href={candidate.website}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {candidate.website.replace(/^https?:\/\//, '')}
                      </a>
                    )}
                  </div>
                  <div className="find-actions">
                    {candidate.closed && (
                      <span className="chip invalid">Closed down</span>
                    )}
                    {candidate.alreadyAdded ? (
                      <span className="chip good">On your list</span>
                    ) : (
                      <button
                        className="quiet small"
                        disabled={busy === (candidate.placeId || candidate.name)}
                        onClick={() => void add(candidate)}
                      >
                        {busy === (candidate.placeId || candidate.name)
                          ? 'Adding…'
                          : 'Add'}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section className="card empty">
            <h3>Nothing came back</h3>
            <p className="muted small">
              Try a plainer description, a wider area, or a different word for
              the kind of business.
            </p>
          </section>
        ))}

      <p className="muted small">
        Only contact businesses you are allowed to contact. Being listed is not
        permission to email.
      </p>
    </div>
  )
}

/* ----------------------------------------------------------------- prospects */

const BLANK_COMPANY = {
  name: '',
  domain: '',
  industry: '',
  size: '',
  country: '',
}
const BLANK_CONTACT = { name: '', title: '', email: '' }

function Prospects({
  version,
  onOpen,
  onRefresh,
}: {
  version: number
  onOpen: (id: string) => void
  onRefresh: () => void
}) {
  const [leads, setLeads] = useState<LeadSummary[] | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [panel, setPanel] = useState<'none' | 'add' | 'import'>('none')

  const load = async (query = search, stage = status) => {
    const params = new URLSearchParams()
    if (query.trim()) params.set('q', query.trim())
    if (stage) params.set('status', stage)
    const result = await api<{ leads: LeadSummary[] }>(
      `/api/leads?${params.toString()}`,
    )
    setLeads(result.leads)
  }

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const params = new URLSearchParams()
        if (search.trim()) params.set('q', search.trim())
        if (status) params.set('status', status)
        const result = await api<{ leads: LeadSummary[] }>(
          `/api/leads?${params.toString()}`,
        )
        if (live) {
          setLeads(result.leads)
          setError('')
        }
      } catch (problem) {
        if (live) setError(fail(problem, 'Could not load prospects.'))
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, status, search])

  return (
    <div className="stack">
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search business, person or website…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search businesses"
        />
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {LEAD_STATUSES.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABEL[value]}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <button className="quiet" onClick={() => setPanel(panel === 'import' ? 'none' : 'import')}>
          Paste a list
        </button>
        <a className="button quiet" href="/api/export" download>
          Download list
        </a>
        <button onClick={() => setPanel(panel === 'add' ? 'none' : 'add')}>
          Add a business
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {panel === 'add' && (
        <AddProspect
          onClose={() => setPanel('none')}
          onDone={async () => {
            setPanel('none')
            await load()
            onRefresh()
          }}
        />
      )}
      {panel === 'import' && (
        <ImportProspects
          onClose={() => setPanel('none')}
          onDone={async () => {
            await load()
            onRefresh()
          }}
        />
      )}

      <section className="card table-card">
        {!leads ? (
          <p className="muted">Loading businesses…</p>
        ) : !leads.length ? (
          <div className="empty">
            <h3>No businesses yet</h3>
            <p className="muted small">
              Add a business and the person you would write to, or paste a list
              you are allowed to use.
            </p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Business</th>
                <th scope="col">Person</th>
                <th scope="col">Match</th>
                <th scope="col">Notes</th>
                <th scope="col">Email</th>
                <th scope="col">Status</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className={lead.suppressed ? 'suppressed' : ''}>
                  <td>
                    <strong>{lead.company.name}</strong>
                    <span className="muted small block">
                      {[lead.company.industry, lead.company.country]
                        .filter(Boolean)
                        .join(' · ') || 'No industry added'}
                    </span>
                  </td>
                  <td>
                    {lead.contact.name}
                    <span className="muted small block">
                      {lead.contact.title || 'No job title'}
                    </span>
                  </td>
                  <td>
                    {lead.score === null ? (
                      <span className="muted small">Not checked</span>
                    ) : (
                      <span className={`score ${lead.score >= 60 ? 'good' : 'low'}`}>
                        {lead.score}
                      </span>
                    )}
                  </td>
                  <td className="small">
                    {lead.evidenceCount
                      ? `${lead.evidenceCount} note${lead.evidenceCount === 1 ? '' : 's'}`
                      : 'None'}
                    {lead.pendingDrafts > 0 && (
                      <span className="tag">message ready</span>
                    )}
                  </td>
                  <td>
                    <span className={`chip ${lead.verification.verdict}`}>
                      {lead.verification.label}
                    </span>
                    {lead.suppressed && <span className="tag danger">do not contact</span>}
                  </td>
                  <td>
                    <span className={`chip ${lead.status}`}>
                      {STATUS_LABEL[lead.status]}
                    </span>
                  </td>
                  <td>
                    <button className="quiet small" onClick={() => onOpen(lead.id)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

function AddProspect({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [company, setCompany] = useState(BLANK_COMPANY)
  const [contact, setContact] = useState(BLANK_CONTACT)
  const [source, setSource] = useState('manual')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/api/leads', post('/api/leads', { company, contact, source }))
      await onDone()
      setCompany(BLANK_COMPANY)
      setContact(BLANK_CONTACT)
    } catch (problem) {
      setError(fail(problem, 'Could not add the prospect.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <div className="row-between">
        <h2>Add one business</h2>
        <button className="quiet small" onClick={onClose}>
          Close
        </button>
      </div>
      <form onSubmit={submit} className="form-grid">
        <label>
          Business name
          <input
            required
            maxLength={160}
            value={company.name}
            onChange={(event) => setCompany({ ...company, name: event.target.value })}
          />
        </label>
        <label>
          Website
          <input
            placeholder="example.com"
            maxLength={200}
            value={company.domain}
            onChange={(event) => setCompany({ ...company, domain: event.target.value })}
          />
        </label>
        <label>
          Industry
          <input
            maxLength={80}
            value={company.industry}
            onChange={(event) => setCompany({ ...company, industry: event.target.value })}
          />
        </label>
        <label>
          How many staff
          <select
            value={company.size}
            onChange={(event) => setCompany({ ...company, size: event.target.value })}
          >
            <option value="">Not recorded</option>
            {COMPANY_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} employees
              </option>
            ))}
          </select>
        </label>
        <label>
          Country
          <input
            maxLength={80}
            value={company.country}
            onChange={(event) => setCompany({ ...company, country: event.target.value })}
          />
        </label>
        <label>
          Person's name
          <input
            required
            maxLength={120}
            value={contact.name}
            onChange={(event) => setContact({ ...contact, name: event.target.value })}
          />
        </label>
        <label>
          Job title
          <input
            maxLength={120}
            value={contact.title}
            onChange={(event) => setContact({ ...contact, title: event.target.value })}
          />
        </label>
        <label>
          Their email
          <input
            type="email"
            maxLength={254}
            value={contact.email}
            onChange={(event) => setContact({ ...contact, email: event.target.value })}
          />
        </label>
        <label>
          Where you found them
          <input
            maxLength={200}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
        </label>
        <div className="form-actions">
          <span className="muted small">
            Only add businesses you are allowed to contact.
          </span>
          <button disabled={busy}>{busy ? 'Adding…' : 'Add business'}</button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  )
}

function ImportProspects({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: () => Promise<void>
}) {
  const [csv, setCsv] = useState(
    'company,domain,industry,size,country,contact,title,email,source\n',
  )
  const [result, setResult] = useState<ImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const response = await api<{ result: ImportResult }>(
        '/api/import',
        post('/api/import', { csv }),
      )
      setResult(response.result)
      await onDone()
    } catch (problem) {
      setError(fail(problem, 'Could not import those rows.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <div className="row-between">
        <h2>Paste a list of businesses</h2>
        <button className="quiet small" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted small">
        Copy rows from a spreadsheet. The first line names the columns; only{' '}
        <code>company</code> and <code>contact</code> are required. You can also
        include <code>domain, industry, size, country, title, email, source</code>.
        Anyone already on your list is skipped and counted.
      </p>
      <form onSubmit={submit}>
        <textarea
          className="code"
          rows={8}
          value={csv}
          onChange={(event) => setCsv(event.target.value)}
          spellCheck={false}
        />
        <div className="form-actions">
          <span className="muted small">Up to 500 rows, 512 KB.</span>
          <button disabled={busy}>{busy ? 'Importing…' : 'Import'}</button>
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      {result && (
        <div className="notice">
          <strong>
            {result.created} created · {result.duplicates} duplicates ·{' '}
            {result.invalid} invalid
          </strong>
          {result.errors.length > 0 && (
            <ul className="errors">
              {result.errors.map((line) => (
                <li key={line} className="small">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

/* --------------------------------------------------------------- lead detail */

function LeadPanel({
  id,
  version,
  onBack,
  onRefresh,
}: {
  id: string
  version: number
  onBack: () => void
  onRefresh: () => void
}) {
  const [lead, setLead] = useState<LeadDetail | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [evidence, setEvidence] = useState({ url: '', excerpt: '', sourceType: 'website' })
  const [person, setPerson] = useState({ name: '', title: '', email: '' })

  const load = async () => {
    const result = await api<{ lead: LeadDetail }>(`/api/leads/${id}`)
    setLead(result.lead)
  }

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const result = await api<{ lead: LeadDetail }>(`/api/leads/${id}`)
        if (live) {
          setLead(result.lead)
          setError('')
        }
      } catch (problem) {
        if (live) setError(fail(problem, 'Could not load the prospect.'))
      }
    })()
    return () => {
      live = false
    }
  }, [id, version])

  useEffect(() => {
    setPerson({
      name:
        lead && lead.contact.name !== 'Person to find' ? lead.contact.name : '',
      title: lead?.contact.title || '',
      email: lead?.contact.email || '',
    })
    // Only resync when this record loads or changes, not while the user types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.id, lead?.updatedAt])

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key)
    setError('')
    try {
      await action()
      await load()
      onRefresh()
    } catch (problem) {
      setError(fail(problem, 'That action failed.'))
    } finally {
      setBusy('')
    }
  }

  if (error && !lead) return <p className="error">{error}</p>
  if (!lead) return <p className="muted">Loading prospect…</p>

  const setStatus = (status: string) =>
    run('status', async () => {
      await api(`/api/leads/${id}`, post(`/api/leads/${id}`, { status }, 'PATCH'))
    })

  const score = () =>
    run('score', async () => {
      await api(`/api/leads/${id}/score`, post(`/api/leads/${id}/score`, {}))
    })

  const draft = () =>
    run('draft', async () => {
      await api(`/api/leads/${id}/draft`, post(`/api/leads/${id}/draft`, {}))
    })

  const send = (draftId: string) =>
    run(`send-${draftId}`, async () => {
      await api(`/api/leads/${id}/send`, post(`/api/leads/${id}/send`, { draftId }))
    })

  const addEvidence = (event: React.FormEvent) => {
    event.preventDefault()
    void run('evidence', async () => {
      await api(`/api/leads/${id}/evidence`, post(`/api/leads/${id}/evidence`, evidence))
      setEvidence({ url: '', excerpt: '', sourceType: 'website' })
    })
  }

  const decide = (draftId: string, decision: 'approve' | 'reject') =>
    run(draftId, async () => {
      await api(
        `/api/drafts/${draftId}/decide`,
        post(`/api/drafts/${draftId}/decide`, { decision }),
      )
    })

  const remove = () => {
    if (!window.confirm('Delete this prospect, its research and its drafts?')) return
    void run('delete', async () => {
      await api(`/api/leads/${id}`, { method: 'DELETE' })
      onRefresh()
      onBack()
    })
  }

  return (
    <div className="stack">
      <button className="quiet small back" onClick={onBack}>
        ← All businesses
      </button>
      {error && <p className="error">{error}</p>}

      <section className="card">
        <div className="row-between start">
          <div>
            <h2 className="lead-name">{lead.contact.name}</h2>
            <p className="muted small">
              {[lead.contact.title, lead.company.name].filter(Boolean).join(' at ')}
              {lead.company.domain ? ` · ${lead.company.domain}` : ''}
            </p>
            <div className="chips">
              <span className={`chip ${lead.status}`}>{STATUS_LABEL[lead.status]}</span>
              <span className={`chip ${lead.verification.verdict}`}>
                {lead.verification.label}
              </span>
              {lead.contact.email && (
                <span className="chip neutral">{lead.contact.email}</span>
              )}
              {lead.suppressed && <span className="chip invalid">Suppressed</span>}
            </div>
          </div>
          <div className="actions">
            <select value={lead.status} onChange={(event) => void setStatus(event.target.value)}>
              {LEAD_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABEL[value]}
                </option>
              ))}
            </select>
            <button className="quiet small danger-text" onClick={remove} disabled={busy === 'delete'}>
              Delete
            </button>
          </div>
        </div>
        <p className="muted small verification-note">{lead.verification.detail}</p>
      </section>

      {(lead.contact.name === 'Person to find' || !lead.contact.email) && (
        <section className="card">
          <h2>Who do you write to?</h2>
          <p className="muted small">
            Business search finds companies, not people. Add the name and email
            of the person you want to reach, then check the match and write to
            them.
          </p>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault()
              void run('person', async () => {
                await api(
                  `/api/leads/${id}`,
                  post(
                    `/api/leads/${id}`,
                    {
                      name: person.name,
                      title: person.title,
                      email: person.email,
                    },
                    'PATCH',
                  ),
                )
              })
            }}
          >
            <label>
              Person's name
              <input
                required
                maxLength={120}
                value={person.name}
                onChange={(event) =>
                  setPerson({ ...person, name: event.target.value })
                }
              />
            </label>
            <label>
              Job title
              <input
                maxLength={120}
                value={person.title}
                onChange={(event) =>
                  setPerson({ ...person, title: event.target.value })
                }
              />
            </label>
            <label>
              Their email
              <input
                type="email"
                maxLength={254}
                value={person.email}
                onChange={(event) =>
                  setPerson({ ...person, email: event.target.value })
                }
              />
            </label>
            <div className="form-actions">
              <span className="muted small">
                Only add an email you are allowed to use.
              </span>
              <button disabled={busy === 'person' || !person.name.trim()}>
                {busy === 'person' ? 'Saving…' : 'Save person'}
              </button>
            </div>
          </form>
        </section>
      )}

      <div className="split">
        <section className="card">
          <div className="row-between">
            <h2>How well they match</h2>
            <button className="quiet small" onClick={() => void score()} disabled={busy === 'score'}>
              {busy === 'score' ? 'Checking…' : 'Check the match'}
            </button>
          </div>
          {lead.fit ? (
            <div className="fit">
              <div className={`score big ${lead.fit.score >= 60 ? 'good' : 'low'}`}>
                {lead.fit.score}
                <span>/100</span>
              </div>
              <p className="small">{lead.fit.reason}</p>
              <div className="chips">
                {lead.fit.matched.map((item) => (
                  <span className="chip good" key={item}>
                    {item}: yes
                  </span>
                ))}
                {lead.fit.failed.map((item) => (
                  <span className="chip low" key={item}>
                    {item}: no
                  </span>
                ))}
              </div>
              <p className="muted small">
                {lead.fit.decision === 'keep'
                  ? 'Worth writing to.'
                  : 'Not worth writing to.'}{' '}
                How sure: {Math.round(lead.fit.confidence * 100)}%.
              </p>
            </div>
          ) : (
            <p className="muted small">
              Not checked yet. Describe your perfect customer on the “What we
              sell” page, then check the match here.
            </p>
          )}
        </section>

        <section className="card">
          <div className="row-between">
            <h2>Message to send</h2>
            <button onClick={() => void draft()} disabled={busy === 'draft' || !lead.evidence.length}>
              {busy === 'draft' ? 'Writing…' : 'Write a message'}
            </button>
          </div>
          {!lead.evidence.length && (
            <p className="muted small">
              Write down what you found first. A message with no source behind it
              cannot be approved.
            </p>
          )}
          {lead.drafts.length ? (
            <ul className="drafts">
              {lead.drafts.map((item) => (
                <DraftItem
                  key={item.id}
                  draft={item}
                  evidence={lead.evidence}
                  busy={busy === item.id}
                  sending={busy === `send-${item.id}`}
                  onDecide={(decision) => void decide(item.id, decision)}
                  onSend={() => void send(item.id)}
                />
              ))}
            </ul>
          ) : (
            <p className="muted small">No message yet.</p>
          )}
        </section>
      </div>

      {lead.messages.length > 0 && (
        <section className="card">
          <h2>Conversation</h2>
          <ul className="thread">
            {lead.messages.map((message) => (
              <li key={message.id}>
                <div className="thread-head">
                  <span
                    className={`chip ${message.direction === 'in' ? 'neutral' : 'good'}`}
                  >
                    {message.direction === 'in' ? 'From them' : 'From you'}
                  </span>
                  {message.category && (
                    <span
                      className={`chip ${
                        message.positive
                          ? 'good'
                          : message.category === 'opt-out' ||
                              message.category === 'bounce'
                            ? 'invalid'
                            : 'held'
                      }`}
                    >
                      {message.category}
                    </span>
                  )}
                  <span className="muted small">
                    {new Date(message.createdAt).toLocaleString()}
                  </span>
                </div>
                <strong className="small">{message.subject}</strong>
                <pre className="draft-body">{message.body}</pre>
                {message.reason && (
                  <p className="muted small">{message.reason}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>What we found out</h2>
        <p className="muted small">
          Write down what you saw, on which page, and when. Messages point back
          to these notes. If you delete a note, any message that used it is
          blocked until it has a source again.
        </p>
        {lead.evidence.length ? (
          <ul className="evidence">
            {lead.evidence.map((item) => (
              <li key={item.id}>
                <div>
                  <a href={item.url} target="_blank" rel="noreferrer" className="small">
                    {item.url}
                  </a>
                  <p className="small">{item.excerpt}</p>
                  <span className="muted small">
                    {item.sourceType} · observed {date(item.observedAt)}
                  </span>
                </div>
                <button
                  className="link danger-text"
                  onClick={() =>
                    void run(item.id, async () => {
                      await api(`/api/evidence/${item.id}`, { method: 'DELETE' })
                    })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">No notes yet.</p>
        )}
        <form onSubmit={addEvidence} className="stack tight">
          <div className="form-grid">
            <label>
              Page address (link)
              <input
                required
                type="url"
                placeholder="https://their-website.com/services"
                value={evidence.url}
                onChange={(event) => setEvidence({ ...evidence, url: event.target.value })}
              />
            </label>
            <label>
              Where you saw it
              <select
                value={evidence.sourceType}
                onChange={(event) =>
                  setEvidence({ ...evidence, sourceType: event.target.value })
                }
              >
                <option value="website">Company website</option>
                <option value="news">News</option>
                <option value="case-study">Case study</option>
                <option value="job-post">Job post</option>
                <option value="directory">Directory</option>
                <option value="other">Other</option>
              </select>
            </label>
          </div>
          <label>
            What you saw (copy their words if you can)
            <textarea
              required
              rows={3}
              maxLength={1200}
              value={evidence.excerpt}
              onChange={(event) => setEvidence({ ...evidence, excerpt: event.target.value })}
            />
          </label>
          <div className="form-actions">
            <span className="muted small">Saved with today's date and the link.</span>
            <button disabled={busy === 'evidence'}>
              {busy === 'evidence' ? 'Saving…' : 'Save note'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

function ClaimList({ claims, evidence }: { claims: Claim[]; evidence: Evidence[] }) {
  const sources = new Map(evidence.map((item) => [item.id, item]))
  if (!claims.length) return null
  return (
    <ul className="claims">
      {claims.map((claim, index) => (
        <li key={`${claim.text}-${index}`}>
          <span className={`chip ${claim.kind === 'fact' ? 'neutral' : 'good'}`}>
            {claim.kind === 'fact' ? 'About them' : 'About us'}
          </span>
          <span className="small">“{claim.text}”</span>
          {claim.kind === 'fact' &&
            claim.evidenceIds.map((sourceId) => {
              const source = sources.get(sourceId)
              if (!source)
                return (
                  <span className="chip invalid" key={sourceId}>
                    no source
                  </span>
                )
              return (
                <a
                  key={sourceId}
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="tag"
                >
                  {new URL(source.url).hostname.replace(/^www\./, '')}
                </a>
              )
            })}
        </li>
      ))}
    </ul>
  )
}

function DraftItem({
  draft,
  evidence,
  busy,
  sending,
  onDecide,
  onSend,
}: {
  draft: Draft
  evidence: Evidence[]
  busy: boolean
  sending: boolean
  onDecide: (decision: 'approve' | 'reject') => void
  onSend: () => void
}) {
  return (
    <li className="draft">
      <div className="row-between">
        <span className={`chip ${draft.status === 'pending' ? 'held' : draft.status === 'approved' ? 'approved' : 'invalid'}`}>
          {draft.status}
        </span>
        <span className="muted small">{date(draft.createdAt)}</span>
      </div>
      <strong className="small">{draft.subject}</strong>
      <pre className="draft-body">{draft.body}</pre>
      <ClaimList claims={draft.claims} evidence={evidence} />
      {draft.status === 'approved' && (
        <div className="form-actions">
          <span className="muted small">
            Approved. It goes out from your Mailgun mailbox, and replies come
            back here on their own.
          </span>
          <button onClick={onSend} disabled={sending}>
            {sending ? 'Sending…' : 'Send now'}
          </button>
        </div>
      )}
      {draft.status === 'pending' && (
        <div className="form-actions">
          <span className="muted small">
            Approving saves this message so you can send it yourself. This app
            does not send email.
          </span>
          <div>
            <button className="quiet" onClick={() => onDecide('reject')} disabled={busy}>
              Don't use
            </button>
            <button onClick={() => onDecide('approve')} disabled={busy}>
              {busy ? 'Saving…' : 'Approve message'}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

/* ------------------------------------------------------------- review queue */

function ReviewQueue({
  version,
  onRefresh,
  onOpen,
}: {
  version: number
  onRefresh: () => void
  onOpen: (id: string) => void
}) {
  const [items, setItems] = useState<ReviewItem[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const load = async () => {
    const result = await api<{ items: ReviewItem[] }>('/api/review')
    setItems(result.items)
  }

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const result = await api<{ items: ReviewItem[] }>('/api/review')
        if (live) {
          setItems(result.items)
          setError('')
        }
      } catch (problem) {
        if (live) setError(fail(problem, 'Could not load the review queue.'))
      }
    })()
    return () => {
      live = false
    }
  }, [version])

  async function decide(id: string, decision: 'approve' | 'reject') {
    setBusy(id)
    setError('')
    try {
      await api(`/api/drafts/${id}/decide`, post(`/api/drafts/${id}/decide`, { decision }))
      await load()
      onRefresh()
    } catch (problem) {
      setError(fail(problem, 'Could not record the decision.'))
    } finally {
      setBusy('')
    }
  }

  if (!items) return <p className="muted">Loading…</p>

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      {!items.length ? (
        <div className="card empty">
          <h3>Nothing waiting</h3>
          <p className="muted small">
            Messages show up here once you write one. Nothing goes out until you
            approve it.
          </p>
        </div>
      ) : (
        items.map((item) => (
          <section className="card review" key={item.draft.id}>
            <div className="row-between start">
              <div>
                <h2 className="lead-name">{item.lead.contact.name}</h2>
                <p className="muted small">
                  {[item.lead.contact.title, item.lead.company.name]
                    .filter(Boolean)
                    .join(' at ')}
                </p>
              </div>
              <div className="chips">
                {item.lead.score !== null && (
                  <span className={`score ${item.lead.score >= 60 ? 'good' : 'low'}`}>
                    {item.lead.score}
                  </span>
                )}
                <span className={`chip ${item.lead.verification.verdict}`}>
                  {item.lead.verification.label}
                </span>
              </div>
            </div>

            {item.lead.fit && <p className="small">{item.lead.fit.reason}</p>}

            <div className="draft-block">
              <strong className="small">{item.draft.subject}</strong>
              <pre className="draft-body">{item.draft.body}</pre>
              <ClaimList claims={item.draft.claims} evidence={item.evidence} />
            </div>

            {item.blocked.length > 0 ? (
              <div className="notice warning">
                <strong>Fix these first</strong>
                <ul className="errors">
                  {item.blocked.map((line) => (
                    <li className="small" key={line}>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="muted small">
                Everything checks out: each claim has a source, this person is
                not on your do-not-contact list, and the email looks fine.
                Approving saves the message for you to send.
              </p>
            )}

            <div className="form-actions">
              <button className="quiet small" onClick={() => onOpen(item.lead.id)}>
                Open the business
              </button>
              <div>
                <button
                  className="quiet"
                  disabled={busy === item.draft.id}
                  onClick={() => void decide(item.draft.id, 'reject')}
                >
                  Don't use
                </button>
                <button
                  disabled={busy === item.draft.id || item.blocked.length > 0}
                  onClick={() => void decide(item.draft.id, 'approve')}
                >
                  {busy === item.draft.id ? 'Saving…' : 'Approve message'}
                </button>
              </div>
            </div>
          </section>
        ))
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ replies */

type RepliesData = {
  items: ReplyItem[]
  needsYou: number
  mailReady: boolean
  dailyCap: number
  sentToday: number
}

function Replies({
  version,
  onRefresh,
  onOpen,
}: {
  version: number
  onRefresh: () => void
  onOpen: (id: string) => void
}) {
  const [data, setData] = useState<RepliesData | null>(null)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState('')

  const load = async () => {
    const result = await api<RepliesData>('/api/replies')
    setData(result)
  }

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const result = await api<RepliesData>('/api/replies')
        if (live) {
          setData(result)
          setError('')
        }
      } catch (problem) {
        if (live) setError(fail(problem, 'Could not load replies.'))
      }
    })()
    return () => {
      live = false
    }
  }, [version])

  async function sendApproved() {
    setBusy('send')
    setError('')
    setSummary('')
    try {
      const result = await api<{
        sent: number
        blocked: number
        failed: number
        blockedReasons: string[]
        remaining: number
        dailyCap: number
      }>('/api/send-approved', post('/api/send-approved', {}))
      setSummary(
        `Sent ${result.sent}. Blocked ${result.blocked}. Failed ${result.failed}. ${result.remaining} of ${result.dailyCap} left today.${
          result.blockedReasons.length
            ? ` First block: ${result.blockedReasons[0]}`
            : ''
        }`,
      )
      await load()
      onRefresh()
    } catch (problem) {
      setError(fail(problem, 'Could not send. Please try again.'))
    } finally {
      setBusy('')
    }
  }

  async function markHandled(messageId: string) {
    setBusy(messageId)
    setError('')
    try {
      await api(`/api/messages/${messageId}/handled`, post(`/api/messages/${messageId}/handled`, {}))
      await load()
      onRefresh()
    } catch (problem) {
      setError(fail(problem, 'Could not update that reply.'))
    } finally {
      setBusy('')
    }
  }

  if (!data) return <p className="muted">Loading replies…</p>

  const origin =
    typeof window === 'undefined' ? '' : window.location.origin

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      {summary && <p className="notice">{summary}</p>}

      <section className="card">
        <div className="row-between start">
          <div>
            <h2>Sending</h2>
            <p className="muted small">
              {data.needsYou} {data.needsYou === 1 ? 'reply needs' : 'replies need'}{' '}
              you. {data.sentToday} of {data.dailyCap} messages sent today.
            </p>
          </div>
          {data.mailReady ? (
            <button
              disabled={busy === 'send' || data.sentToday >= data.dailyCap}
              onClick={() => void sendApproved()}
            >
              {busy === 'send' ? 'Sending…' : 'Send approved messages'}
            </button>
          ) : (
            <span className="chip held">Not switched on</span>
          )}
        </div>
      </section>

      {!data.mailReady && (
        <section className="card">
          <h2>Sending and replies are not switched on yet</h2>
          <p className="muted small">
            The app is ready to send and to read answers, but it needs an email
            account it is allowed to send from. We use Mailgun: it sends the
            message and forwards the reply straight back here.
          </p>
          <ol className="steps">
            <li>
              Create a Mailgun account, add your domain, and add the DNS records
              it gives you. That is what makes your mail trusted.
            </li>
            <li>
              Copy two values from Mailgun: the <strong>API key</strong> (Settings
              → API keys) and the <strong>webhook signing key</strong> (Settings →
              API Security). Do not paste either one in this chat.
            </li>
            <li>
              In Mailgun → Receiving → Routes, add a route that matches{' '}
              <code>reply\+.*@your-domain</code> and forwards to{' '}
              <code>{origin}/api/webhooks/mailgun</code>.
            </li>
            <li>
              In Freebuff → Sites → Secrets, add these for Production:
              <code>MAILGUN_API_KEY</code>, <code>MAILGUN_DOMAIN</code>,
              <code>MAIL_FROM</code> (like{' '}
              <code>Banks Solutions &lt;hello@your-domain&gt;</code>) and{' '}
              <code>MAILGUN_WEBHOOK_KEY</code>. Optional:{' '}
              <code>OWNER_NOTIFY_EMAIL</code> (emails you when someone is
              interested), <code>DAILY_SEND_CAP</code> (default 20).
            </li>
            <li>Tell me when they are saved and I will redeploy and test it.</li>
          </ol>
          <p className="muted small">
            Nothing is sent until you approve a message and press send, and
            never to someone on your do-not-contact list.
          </p>
        </section>
      )}

      {!data.items.length ? (
        <section className="card empty">
          <h3>No replies yet</h3>
          <p className="muted small">
            When someone answers an approved message, it lands here with a plain
            label — interested, not interested, out of office, asked to stop.
          </p>
        </section>
      ) : (
        data.items.map((item) => (
          <section
            className={
              item.message.positive && !item.message.handled
                ? 'card reply positive'
                : 'card reply'
            }
            key={item.message.id}
          >
            <div className="row-between start">
              <div>
                <h2 className="lead-name">{item.lead.contact.name}</h2>
                <p className="muted small">
                  {[item.lead.contact.title, item.lead.company.name]
                    .filter(Boolean)
                    .join(' at ')}
                </p>
              </div>
              <div className="chips">
                <span
                  className={`chip ${
                    item.message.positive
                      ? 'good'
                      : item.message.category === 'opt-out' ||
                          item.message.category === 'bounce'
                        ? 'invalid'
                        : 'held'
                  }`}
                >
                  {item.message.category}
                </span>
                {item.message.handled && (
                  <span className="chip neutral">handled</span>
                )}
              </div>
            </div>
            <strong className="small">{item.message.subject}</strong>
            <pre className="draft-body">
              {item.message.body.slice(0, 1200) || '(no text)'}
            </pre>
            <p className="muted small">
              {item.message.reason} ·{' '}
              {new Date(item.message.createdAt).toLocaleString()}
            </p>
            <div className="form-actions">
              <button
                className="quiet small"
                onClick={() => onOpen(item.lead.id)}
              >
                Open the business
              </button>
              {!item.message.handled && (
                <button
                  className="quiet small"
                  disabled={busy === item.message.id}
                  onClick={() => void markHandled(item.message.id)}
                >
                  Mark handled
                </button>
              )}
            </div>
          </section>
        ))
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- playbook */

const BLANK_OFFER: Offer = {
  name: '',
  service: '',
  outcomes: '',
  proof: '',
  exclusions: '',
  voice: '',
  updatedAt: null,
}

const FILTER_FIELDS: { key: keyof IcpFilters; label: string; hint: string }[] = [
  { key: 'titles', label: 'Job titles', hint: 'operations lead, owner' },
  { key: 'industries', label: 'Industries', hint: 'logistics, online shops' },
  { key: 'countries', label: 'Places', hint: 'nigeria, lagos' },
  { key: 'sizes', label: 'Company size', hint: '11-50, 51-200' },
  { key: 'keywords', label: 'Keywords', hint: 'booking, enquiry' },
  { key: 'exclusions', label: 'Leave out', hint: 'recruiter, franchise' },
]

const toList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

function Playbook({ version, onRefresh }: { version: number; onRefresh: () => void }) {
  const [offer, setOffer] = useState<Offer>(BLANK_OFFER)
  const [icps, setIcps] = useState<Icp[]>([])
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState('')
  const [brief, setBrief] = useState({ name: '', brief: '' })
  const [filters, setFilters] = useState<Record<keyof IcpFilters, string>>({
    titles: '',
    industries: '',
    countries: '',
    sizes: '',
    keywords: '',
    exclusions: '',
  })

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const [offerResult, icpResult] = await Promise.all([
          api<{ offer: Offer }>('/api/offer'),
          api<{ icps: Icp[] }>('/api/icps'),
        ])
        if (!live) return
        setOffer(offerResult.offer)
        setIcps(icpResult.icps)
      } catch (problem) {
        if (live) setError(fail(problem, 'Could not load the playbook.'))
      }
    })()
    return () => {
      live = false
    }
  }, [version])

  async function saveOffer(event: React.FormEvent) {
    event.preventDefault()
    setBusy('offer')
    setError('')
    setSaved('')
    try {
      const result = await api<{ offer: Offer }>('/api/offer', post('/api/offer', offer, 'PUT'))
      setOffer(result.offer)
      setSaved('Offer saved.')
      onRefresh()
    } catch (problem) {
      setError(fail(problem, 'Could not save the offer.'))
    } finally {
      setBusy('')
    }
  }

  async function interpret() {
    if (!brief.brief.trim()) return
    setBusy('parse')
    setError('')
    try {
      const result = await api<{ filters: IcpFilters }>(
        '/api/icps/preview',
        post('/api/icps/preview', { brief: brief.brief }),
      )
      setFilters({
        titles: result.filters.titles.join(', '),
        industries: result.filters.industries.join(', '),
        countries: result.filters.countries.join(', '),
        sizes: result.filters.sizes.join(', '),
        keywords: result.filters.keywords.join(', '),
        exclusions: result.filters.exclusions.join(', '),
      })
    } catch (problem) {
      setError(fail(problem, 'Could not read that brief.'))
    } finally {
      setBusy('')
    }
  }

  async function saveIcp(event: React.FormEvent) {
    event.preventDefault()
    setBusy('icp')
    setError('')
    try {
      const explicit = Object.values(filters).some((value) => value.trim())
      const payload = {
        name: brief.name,
        brief: brief.brief,
        ...(explicit
          ? { filters: Object.fromEntries(FILTER_FIELDS.map((field) => [field.key, toList(filters[field.key])])) }
          : {}),
      }
      await api('/api/icps', post('/api/icps', payload))
      setBrief({ name: '', brief: '' })
      setFilters({ titles: '', industries: '', countries: '', sizes: '', keywords: '', exclusions: '' })
      const result = await api<{ icps: Icp[] }>('/api/icps')
      setIcps(result.icps)
      onRefresh()
    } catch (problem) {
      setError(fail(problem, 'Could not save the ICP.'))
    } finally {
      setBusy('')
    }
  }

  async function removeIcp(id: string) {
    setBusy(id)
    setError('')
    try {
      await api(`/api/icps/${id}`, { method: 'DELETE' })
      setIcps((current) => current.filter((item) => item.id !== id))
      onRefresh()
    } catch (problem) {
      setError(fail(problem, 'Could not delete the ICP.'))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      {saved && <p className="notice">{saved}</p>}

      <section className="card">
        <h2>What we sell</h2>
        <p className="muted small">
          A message can only say what you write here, plus what you found and
          saved about the business. Anything you list as “not promised” stays
          out of the message.
        </p>
        <form onSubmit={saveOffer} className="stack tight">
          <div className="form-grid">
            <label>
              Your business name
              <input
                required
                maxLength={120}
                value={offer.name}
                onChange={(event) => setOffer({ ...offer, name: event.target.value })}
              />
            </label>
            <label>
              What you sell
              <input
                required
                maxLength={2000}
                value={offer.service}
                onChange={(event) => setOffer({ ...offer, service: event.target.value })}
              />
            </label>
          </div>
                      <label>
              What the customer gets
              <textarea
              required
              rows={3}
              maxLength={2000}
              placeholder="fewer missed enquiries; customers can see their own order status"
              value={offer.outcomes}
              onChange={(event) => setOffer({ ...offer, outcomes: event.target.value })}
            />
          </label>
          <div className="form-grid">
            <label>
              Proof (work you have done)
              <textarea
                rows={3}
                maxLength={2000}
                value={offer.proof}
                onChange={(event) => setOffer({ ...offer, proof: event.target.value })}
              />
            </label>
            <label>
              Things you will not promise
              <textarea
                rows={3}
                maxLength={2000}
                value={offer.exclusions}
                onChange={(event) => setOffer({ ...offer, exclusions: event.target.value })}
              />
            </label>
          </div>
                      <label>
              How you like to sound
              <input
              maxLength={1000}
              placeholder="plain, specific, no hype"
              value={offer.voice}
              onChange={(event) => setOffer({ ...offer, voice: event.target.value })}
            />
          </label>
          <div className="form-actions">
            <span className="muted small">
              {offer.updatedAt ? `Last saved ${date(offer.updatedAt)}` : 'Not saved yet'}
            </span>
            <button disabled={busy === 'offer'}>
              {busy === 'offer' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <h2>Who we want to reach</h2>
        <p className="muted small">
          Describe the businesses you want in your own words. We turn that into
          simple filters. Check them, change anything, then save.
        </p>
        <form onSubmit={saveIcp} className="stack tight">
          <div className="form-grid">
            <label>
              Name this customer type
              <input
                required
                maxLength={120}
                placeholder="Lagos online shops"
                value={brief.name}
                onChange={(event) => setBrief({ ...brief, name: event.target.value })}
              />
            </label>
            <label>
              Describe them in your own words
              <input
                required
                maxLength={2000}
                placeholder="Online shops in Lagos with 11-50 staff, run by an operations lead"
                value={brief.brief}
                onChange={(event) => setBrief({ ...brief, brief: event.target.value })}
              />
            </label>
          </div>
          <div className="form-actions">
            <span className="muted small">You can change any filter before saving.</span>
            <button
              type="button"
              className="quiet"
              onClick={() => void interpret()}
              disabled={busy === 'parse' || !brief.brief.trim()}
            >
              {busy === 'parse' ? 'Working…' : 'Turn this into filters'}
            </button>
          </div>
          <div className="form-grid">
            {FILTER_FIELDS.map((field) => (
              <label key={field.key}>
                {field.label}
                <input
                  placeholder={field.hint}
                  value={filters[field.key]}
                  onChange={(event) =>
                    setFilters({ ...filters, [field.key]: event.target.value })
                  }
                />
              </label>
            ))}
          </div>
          <div className="form-actions">
            <span className="muted small">
              Leave these empty and we will fill them from your description.
            </span>
            <button disabled={busy === 'icp'}>
              {busy === 'icp' ? 'Saving…' : 'Save customer type'}
            </button>
          </div>
        </form>

        {icps.length > 0 && (
          <ul className="icp-list">
            {icps.map((icp) => (
              <li key={icp.id}>
                <div>
                  <strong>{icp.name}</strong>
                  <p className="muted small">{icp.brief}</p>
                  <div className="chips">
                    {FILTER_FIELDS.flatMap((field) =>
                      icp.filters[field.key].map((value) => (
                        <span className="chip neutral" key={`${field.key}-${value}`}>
                          {value}
                        </span>
                      )),
                    )}
                    {!Object.values(icp.filters).some((list) => list.length) && (
                      <span className="muted small">No filters</span>
                    )}
                  </div>
                </div>
                <button
                  className="link danger-text"
                  disabled={busy === icp.id}
                  onClick={() => void removeIcp(icp.id)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/* --------------------------------------------------------------- guardrails */

function Guardrails({ version, onRefresh }: { version: number; onRefresh: () => void }) {
  const [entries, setEntries] = useState<Suppression[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ value: '', reason: '' })
  const [check, setCheck] = useState('')
  const [verification, setVerification] = useState<Verification | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const result = await api<{ suppressions: Suppression[] }>('/api/suppressions')
        if (live) setEntries(result.suppressions)
      } catch (problem) {
        if (live) setError(fail(problem, 'Could not load suppression entries.'))
      }
    })()
    return () => {
      live = false
    }
  }, [version])

  async function add(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await api<{ suppression: Suppression }>(
        '/api/suppressions',
        post('/api/suppressions', form),
      )
      setEntries((current) => [result.suppression, ...current])
      setForm({ value: '', reason: '' })
      onRefresh()
    } catch (problem) {
      setError(fail(problem, 'Could not add that entry.'))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    setError('')
    try {
      await api(`/api/suppressions/${id}`, { method: 'DELETE' })
      setEntries((current) => current.filter((item) => item.id !== id))
      onRefresh()
    } catch (problem) {
      setError(fail(problem, 'Could not remove that entry.'))
    }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    try {
      const result = await api<{ verification: Verification }>(
        '/api/verify',
        post('/api/verify', { email: check }),
      )
      setVerification(result.verification)
    } catch (problem) {
      setError(fail(problem, 'Could not check that address.'))
    }
  }

  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <div className="split">
        <section className="card">
          <h2>Check an email address</h2>
          <p className="muted small">
            We only look for spelling problems, throwaway inboxes and shared
            inboxes like info@. A pass does not prove the inbox exists or that
            you are allowed to email them.
          </p>
          <form onSubmit={verify} className="row">
            <input
              type="email"
              required
              placeholder="name@company.com"
              value={check}
              onChange={(event) => setCheck(event.target.value)}
              aria-label="Email address to check"
            />
            <button>Check</button>
          </form>
          {verification && (
            <div className="notice">
              <span className={`chip ${verification.verdict}`}>{verification.label}</span>
              <p className="small">{verification.detail}</p>
              <p className="muted small">
                {verification.sendable
                  ? 'Eligible for approval, subject to suppression and approval.'
                  : 'Not eligible to send.'}
              </p>
            </div>
          )}
        </section>

        <section className="card">
          <h2>Add someone to the do-not-contact list</h2>
          <p className="muted small">
            One entry blocks that person, or their whole company, everywhere —
            including messages you have already written.
          </p>
          <form onSubmit={add} className="stack tight">
            <label>
              Email or website
              <input
                required
                maxLength={254}
                value={form.value}
                onChange={(event) => setForm({ ...form, value: event.target.value })}
              />
            </label>
            <label>
              Reason
              <input
                required
                maxLength={200}
                placeholder="Opted out by email on 12 Nov"
                value={form.reason}
                onChange={(event) => setForm({ ...form, reason: event.target.value })}
              />
            </label>
            <div className="form-actions">
              <span className="muted small">Removing is recorded too.</span>
              <button disabled={busy}>{busy ? 'Adding…' : 'Add to list'}</button>
            </div>
          </form>
        </section>
      </div>

      <section className="card">
        <h2>Do-not-contact list</h2>
        {!entries.length ? (
          <p className="muted small">The list is empty.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Value</th>
                <th scope="col">Reason</th>
                <th scope="col">Added</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.value}</td>
                  <td className="small">{entry.reason}</td>
                  <td className="small muted">{date(entry.createdAt)}</td>
                  <td>
                    <button className="link danger-text" onClick={() => void remove(entry.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

/* ----------------------------------------------------------------- activity */

function ActivityLog({ version }: { version: number }) {
  const [data, setData] = useState<{ activity: Activity[]; usage: { eventType: string; units: number }[] } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const result = await api<{ activity: Activity[]; usage: { eventType: string; units: number }[] }>(
          '/api/activity',
        )
        if (live) setData(result)
      } catch (problem) {
        if (live) setError(fail(problem, 'Could not load activity.'))
      }
    })()
    return () => {
      live = false
    }
  }, [version])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading activity…</p>

  return (
    <div className="stack">
      <section className="card">
        <h2>What we have used</h2>
        <p className="muted small">
          A running count of the work done, so cost stays visible.
        </p>
        {!data.usage.length ? (
          <p className="muted small">Nothing used yet.</p>
        ) : (
          <ul className="usage">
            {data.usage.map((row) => (
              <li key={row.eventType}>
                <span>{row.eventType}</span>
                <strong>{row.units}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <h2>History</h2>
        {!data.activity.length ? (
          <p className="muted small">Nothing here yet.</p>
        ) : (
          <ul className="feed">
            {data.activity.map((item) => (
              <li key={item.id}>
                <div>
                  <span className="action">{item.action}</span>
                  <p className="small">{item.detail}</p>
                </div>
                <time
                  className="muted small"
                  dateTime={new Date(item.createdAt).toISOString()}
                >
                  {new Date(item.createdAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
