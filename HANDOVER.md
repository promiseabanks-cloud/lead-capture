# Handover — read this first

This note is the source of truth for anyone (human or model) picking this
project up. `README.md` describes the product; this file describes the *state*:
what works, what is a stub, what needs a human, and the decisions you should not
casually undo. It was last updated on **14 November 2026**.

If anything here disagrees with the code, trust the code and fix this file in the
same commit.

---

## 1. What this is

**Banks Growth Engine** — an internal prospecting and outreach workspace for
Banks Solutions, built from the Leadash replication blueprint (Phase 1), with
original naming, copy and design.

The loop, end to end:

1. Say what you sell (`What we sell`).
2. Describe your ideal customer; the app turns plain English into editable
   filters (`Home → ideal customer`).
3. Add businesses by hand, by CSV, or from Google Places search
   (`Find businesses`).
4. Record sourced research per business (`Businesses → a business → notes`).
5. Score fit against the ideal customer, with written reasons.
6. Generate an outreach draft in which **every fact is tied to a stored note**.
7. A person approves the draft.
8. The app **sends** the approved message through Mailgun.
9. Replies come back through a Mailgun route into a signed webhook, are matched
   to the business, and are **labelled in plain English** (interested / not
   interested / question / referral / out of office / asked to stop / bounced /
   unclear).
10. Interested replies mark the business "Replied", appear under `Replies`,
    count on `Home` as **Need your reply**, and — when `OWNER_NOTIFY_EMAIL` is
    set — email the owner. "Asked to stop" auto-adds the address to `Do not
    contact`. Bounces mark the address invalid and hold the business.

UI rule: **plain English only**. No "queue", "playbook", "guardrails", "ICP",
"sequencing" in user-facing copy. Those words were explicitly rejected by the
owner. Internal identifiers may still use them (e.g. `icps` table).

---

## 2. Where it runs

| Thing | Value |
| --- | --- |
| Hosting | Freebuff Sites, project name `Banks Growth Engine` |
| Site id | `f407906f-cb51-4551-aff4-d573a7571058` |
| Production | https://site-4d55d3d0172046d0b62e81506da9f367.freebuff.page (published) |
| Preview env | https://site-02de176e87cb43adb095b970d10a0716.freebuff.page |
| Database | D1, bound as `DB`, in both environments |
| Sign-in | Sign in with Freebuff, client `7797fa8a-88a8-4ad6-a3ff-0355ac0e856b`, issuer `https://freebuff.com/oidc` |
| GitHub | `promiseabanks-cloud/lead-capture`, branch `main` |

Preview and production are independent environments but share **one** published
slot. Deploying does not unpublish or republish; publication is a separate flag.

### Deploy

```sh
bun run build          # vite build + scripts/postbuild.mjs -> dist/
# then, from an agent session with the Sites tools:
#   sites_deploy(siteId, environment: "production", requestId: <fresh UUID>,
#                manifestPath: "deploy.json")
```

`deploy.json` points at `dist/banks_growth_engine/index.js` and `dist/client`.
`dist/` is gitignored; it is build output, not source.

Fresh `requestId` (a UUID) for every intended change; reuse the **same** id only
when retrying an uncertain request. Inspect the operation receipt; `succeeded`
means deployed, `published` is a separate check (`sites_inspect`).

---

## 3. Current state

### Verified working

- 17 tests pass (`bun test`), typecheck clean, production build succeeds.
- Live production: `/` returns 200; signed-out `/api/replies` and
  `/api/send-approved` return 401; a webhook call with a bad signature returns
  401; `/api/cron/send` without a configured secret returns 503.
- Sending: gated on mailbox config, suppression, address verdict and re-checked
  claims; records the outbound message, moves the business to "Messaged", writes
  audit + usage rows; a draft cannot be sent twice (unique index).
- Receiving: signature + timestamp window + one-time token; matches by
  `reply+<lead id>@domain` first, then by sender address; stores and labels the
  reply; updates the business; auto-suppresses opt-outs; notifies the owner on
  positive replies.
- Daily cap (`DAILY_SEND_CAP`, default 20) and batch send of approved messages.
- Signed `POST /api/cron/send` for scheduled sending (see gaps).

### Not verified (honest limits)

- No real email has been sent or received: that needs the owner's Mailgun
  credentials and route (below). Everything on the Mailgun path is tested
  against a stubbed `fetch` and locally computed HMACs.
- The signed-in screens were never visually checked by an agent — an agent
  cannot complete the owner's sign-in. Layout/styling changes need the owner's
  eyes or an authenticated browser.
- Google Places search is tested against a stub; the real key is not set.

### Needs a human (blockers, not bugs)

1. **Mailgun**: create the account, verify a sending domain (SPF/DKIM records),
   copy the API key and the *webhook signing key* (these are different), create
   an inbound route matching `reply\+.*@your-domain` with the action
   `forward("https://<production host>/api/webhooks/mailgun")`, then add the
   secrets below in Sites → Secrets for Production.
2. **Google Places**: `GOOGLE_PLACES_API_KEY` in Sites → Secrets.

Never ask for or paste any of these values into chat, a file, or a commit. The
app already shows a setup card with these steps in the `Replies` tab.

---

## 4. Configuration

Set with Sites → Secrets (never committed). Optional ones can be omitted.

| Variable | Purpose | Needed for |
| --- | --- | --- |
| `MAILGUN_API_KEY` | Basic auth `api:<key>` | sending |
| `MAILGUN_DOMAIN` | verified sending domain | sending |
| `MAIL_FROM` | e.g. `Banks Solutions <hello@your-domain>` | sending |
| `MAILGUN_WEBHOOK_KEY` | webhook signing key (HMAC-SHA256) | receiving |
| `MAIL_REPLY_DOMAIN` | override the reply domain | optional |
| `MAILGUN_BASE_URL` | `https://api.eu.mailgun.net` for EU domains | optional |
| `OWNER_NOTIFY_EMAIL` | where "good news" notifications go | optional |
| `DAILY_SEND_CAP` | messages per day, default 20, max 200 | optional |
| `CRON_SECRET` | shared key for `POST /api/cron/send` (`x-cron-key`) | scheduled sending |
| `GOOGLE_PLACES_API_KEY` | business search | optional feature |

Sites injects `FREEBUFF_CLIENT_ID`, `FREEBUFF_ISSUER` and `APP_ORIGIN` — never
derive the canonical origin from a request `Host`, and check
`node_modules/@freebuff/auth/AGENTS.md` before touching sign-in.

Sending stays off (`mailReady()` false) until the first three mail variables
exist, and the UI says so plainly. That is the intended state, not a bug.

---

## 5. Code map

| File | Role |
| --- | --- |
| `src/worker/index.ts` | Worker entry; wraps the Hono app with the auth SDK, then serves assets |
| `src/worker/app.ts` | All API routes, validation, origin checks, audit/usage writes, send logic |
| `src/worker/auth.ts` | `Env` type, SDK auth setup, `currentUser`, loopback-only local preview |
| `src/worker/db.ts` | Idempotent schema (`ensureSchema`), `recordAudit`, `recordUsage` |
| `src/worker/score.ts` | ICP brief → filters (keyword rules) and weighted explainable scoring |
| `src/worker/draft.ts` | Draft construction + the claim→evidence gate (`auditClaims`) |
| `src/worker/email.ts` | Address checks (syntax, disposable, role mailbox) and suppression matching |
| `src/worker/places.ts` | Google Places Text Search adapter; no scraping fallback |
| `src/worker/mail.ts` | Mailgun send, `mailReady`, `replyAddress`, `leadIdFromAddress`, `verifyMailgunSignature` |
| `src/worker/replies.ts` | Deterministic reply triage; returns category, positive, confidence, reason |
| `src/client/main.tsx` | The whole UI (single file: tabs, lead panel, replies, theming) |
| `src/client/style.css` | Variable-based palette with `[data-theme='dark']` |
| `src/shared/types.ts` | Types shared by browser and Worker |
| `tests/app.test.ts` | Miniflare D1 integration tests (17) |
| `deploy.json` | Sites deployment manifest |

Frontend is React 19 + Vite; server is Hono 4 on Cloudflare Workers; no ORM, no
state library, no CSS framework. Keep it that way unless there is a reason.

---

## 6. Data model (D1)

`offers`, `icps`, `companies`, `contacts`, `leads`, `evidence`, `drafts`,
`suppressions`, `messages`, `webhook_tokens`, `audit_logs`, `usage_ledger`.

Notes that matter:

- Every table is scoped by `owner_sub` (the Freebuff `sub`); every query binds
  parameters and filters by owner. Never trust a client-supplied id without the
  owner in the same `WHERE`.
- `leads` is the join of a company and a contact plus status and score JSON.
  Statuses: `new`, `qualified`, `held`, `approved`, `contacted`, `replied`,
  `won`, `lost`.
- `messages` holds both directions. `direction` is `out` or `in`; outbound
  `status` is `sent`/`failed`, inbound is `received`. Inbound rows carry
  `category`, `positive`, `confidence`, `reason`, `handled_at`.
- `messages_draft_once` (unique on owner + draft id, where draft id is not null)
  is what makes double-sending impossible. Do not drop it.
- `webhook_tokens` is replay protection: the Mailgun token is inserted with
  `INSERT OR IGNORE`; if nothing changed, the delivery is acknowledged and
  ignored.
- Schema is created lazily and idempotently on first request. There is **no
  migration system**: adding a column to an existing table needs a deliberate
  `ALTER TABLE` guarded by a check, and the running production database already
  holds the current shape.

---

## 7. API surface

All under `/api`. Everything requires a signed-in session **except**:
`/api/health`, `/api/session`, `/api/webhooks/mailgun` (own signature check) and
`/api/cron/send` (own shared key). Mutations additionally require a same-origin
request; JSON bodies are limited to 32 KB (import 512 KB, webhook 256 KB).

- Session/overview: `GET /api/health`, `GET /api/session`, `GET /api/overview`
- Offer: `GET|PUT /api/offer`
- Ideal customer: `GET /api/icps`, `POST /api/icps/preview`, `POST /api/icps`,
  `DELETE /api/icps/:id`
- Businesses: `GET|POST /api/leads`, `GET|PATCH|DELETE /api/leads/:id`,
  `POST /api/leads/:id/score`, `POST /api/leads/:id/draft`,
  `POST /api/leads/:id/evidence`, `DELETE /api/evidence/:id`
- Review: `GET /api/review`, `POST /api/drafts/:id/decide`
- Sending: `POST /api/leads/:id/send`, `POST /api/send-approved`,
  `POST /api/cron/send`
- Replies: `GET /api/replies`, `POST /api/messages/:id/handled`,
  `POST /api/webhooks/mailgun`
- Guardrails: `GET|POST /api/suppressions`, `DELETE /api/suppressions/:id`,
  `POST /api/verify`
- Search: `GET /api/find`, `POST /api/find`, `POST /api/find/save`
- Data out: `GET /api/export`, `GET /api/activity`

Error bodies are `{ error: string }` in plain English; blockers come back as
`{ blocked: string[] }` with 409.

---

## 8. Decisions and why (do not undo without a reason)

- **Mailgun** chosen for send + inbound webhook: one provider for both, signed
  webhooks, form-encoded API. Resend and Postmark were considered; Resend's
  inbound needs extra setup, Postmark's inbound is a separate product.
- **Plain text only.** No HTML templates, no tracking pixels, no open tracking.
- **Deterministic reply labels, not an LLM.** No API key, no cost, and the label
  always carries the phrase that decided it. The ordering (bounce → opt-out →
  out-of-office → negative → referral → positive → question → unknown) matters:
  "not interested, thanks" must never be labelled interested.
- **The claim gate runs again at send time**, not only at approval, so deleting
  a source after approval cannot let an unsupported claim leave the building.
- **No scraping** of LinkedIn or company sites. Search is Google Places behind
  an adapter; without a key the feature is visibly off.
- **Automation is a signed endpoint, not a cron trigger.** The Sites deploy
  manifest has no scheduled trigger, so `POST /api/cron/send` with `x-cron-key`
  exists for any scheduler to call. Do not add a `triggers` block and pretend it
  runs.
- **Local preview identity is loopback-only.** On a hosted origin without auth
  configuration the app shows a "sign-in is not configured" gate on purpose.

---

## 9. Known gaps / sensible next steps

1. **Wire a scheduler** (hourly) to `POST /api/cron/send` with `x-cron-key`, or
   use a Cloudflare Cron Trigger only if the hosting path supports triggers.
2. **Unmatched replies** currently return `{ ok: true, ignored: ... }`. They are
   dropped, not stored. An "unknown replies" inbox would prevent losing a
   referral who wrote from a different address.
3. **Threads**: only the first reply is matched by lead id; follow-ups rely on
   the sender-address fallback. Real `In-Reply-To`/`References` threading is
   not modelled.
4. **Follow-up cadence**: no sequences, no reminders. "Needs you" is manual.
5. **Won/lost**: statuses exist; nothing automates them.
6. **Local development**: `.env` is read by Vite/Wrangler for local testing;
   `.dev.vars` must not exist (its presence stops Wrangler reading `.env`).
7. Tests cover the API; there are no browser tests.

---

## 10. Gotchas that have bitten before

- Cloud dev preview points at a `*.style.dev` host; the auth gate rejects
  non-loopback origins, so previews there show the sign-in setup message. Use
  the production URL for anything that needs a session.
- The nav must stay **left-aligned**; a previous centred-nav regression was
  explicitly fixed (`button.nav` is `display: block`, `text-align: left`).
- Dark mode is a `data-theme` attribute on `:root`, persisted in
  `localStorage['bge-theme']`; every colour is a CSS variable — add new colours
  in both palettes.
- `sendMail` posts `FormData`; do not set `Content-Type` by hand.
- The webhook trusts nothing in the body until the HMAC over
  `timestamp + token` matches and the timestamp is within an hour.
- Audit and usage rows are append-only; do not update or delete them.

---

## 11. First ten minutes

```sh
bun install
bun test            # 17 passing
bun run typecheck
bun run build
bun run dev         # http://localhost:5173 with local D1
```

Then read `src/worker/app.ts` from the "sending" section onwards — it is the
heart of the newest work — and `src/client/main.tsx` for the `Replies` view.
