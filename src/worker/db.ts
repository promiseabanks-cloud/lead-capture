const schema = [
  `CREATE TABLE IF NOT EXISTS offers (
    owner_sub TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    service TEXT NOT NULL,
    outcomes TEXT NOT NULL,
    proof TEXT NOT NULL,
    exclusions TEXT NOT NULL,
    voice TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS icps (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    name TEXT NOT NULL,
    brief TEXT NOT NULL,
    filters_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS icps_owner ON icps(owner_sub, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    name TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    industry TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    company_id TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    verdict TEXT NOT NULL DEFAULT 'unknown',
    checked_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS contacts_owner_email ON contacts(owner_sub, email)`,
  `CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    company_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    status TEXT NOT NULL,
    score INTEGER,
    score_json TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS leads_owner_contact ON leads(owner_sub, contact_id)`,
  `CREATE INDEX IF NOT EXISTS leads_owner_updated ON leads(owner_sub, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    url TEXT NOT NULL,
    source_type TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS evidence_lead ON evidence(owner_sub, lead_id)`,
  `CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    claims_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS drafts_owner_status ON drafts(owner_sub, status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS suppressions (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    value TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS suppressions_owner_value ON suppressions(owner_sub, value)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    draft_id TEXT,
    direction TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    from_email TEXT NOT NULL DEFAULT '',
    to_email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    provider_id TEXT NOT NULL DEFAULT '',
    category TEXT,
    positive INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    handled_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS messages_owner_lead ON messages(owner_sub, lead_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS messages_owner_direction ON messages(owner_sub, direction, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS messages_draft_once ON messages(owner_sub, draft_id) WHERE draft_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS webhook_tokens (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS audit_owner_created ON audit_logs(owner_sub, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS usage_ledger (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    event_type TEXT NOT NULL,
    units INTEGER NOT NULL,
    reference_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS usage_owner_created ON usage_ledger(owner_sub, created_at DESC)`,
]

const ready = new WeakMap<D1Database, Promise<void>>()
export function ensureSchema(db: D1Database): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = db
      .batch(schema.map((sql) => db.prepare(sql)))
      .then(() => undefined)
      .catch((error) => {
        ready.delete(db)
        throw error
      })
    ready.set(db, pending)
  }
  return pending
}

/** Append-only activity trail for consequential actions. */
export async function recordAudit(
  db: D1Database,
  owner: string,
  action: string,
  objectType: string,
  objectId: string,
  detail: string,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO audit_logs (id, owner_sub, action, object_type, object_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(crypto.randomUUID(), owner, action, objectType, objectId, detail, now)
    .run()
}

/** Usage is append-only; corrections belong in new compensating rows. */
export async function recordUsage(
  db: D1Database,
  owner: string,
  eventType: string,
  units: number,
  referenceId: string,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO usage_ledger (id, owner_sub, event_type, units, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(crypto.randomUUID(), owner, eventType, units, referenceId, now)
    .run()
}
