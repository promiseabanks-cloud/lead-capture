# Banks Growth Engine

An internal prospecting and outreach workspace for Banks Solutions, built from
the Leadash replication blueprint (Phase 1: internal prospecting MVP).

The workflow is: define what you sell → define an ideal customer profile → add
prospects → record sourced research → score fit → draft outreach → human
review → send → read the reply. No draft can cite a fact without a stored
source, and no message is sent without a person approving it. Replies are
labelled in plain English and the owner is notified when one is worth closing.

See [`HANDOVER.md`](HANDOVER.md) for current state, decisions, configuration and
the things that still need a human.

## What is implemented

- **Offer profile** — service, outcomes, proof, exclusions and voice notes.
- **ICP builder** — a plain-English brief interpreted into editable filters by
  deterministic keyword rules (not a model call), with per-criterion scoring.
- **Find businesses** — searches Google Places API (New) Text Search for
  companies by what they do and where they are, then adds a chosen company as
  a business record for you to fill in the person. Off until a key is set;
  it never falls back to scraping.
- **Prospect CRM** — companies, contacts, lists-free lead records, duplicate
  detection on normalised email and on company + contact name, CSV import
  (500 rows) and CSV export.
- **Research evidence** — every note stores a URL, excerpt, source type and
  observation timestamp; evidence is never overwritten.
- **Fit scoring** — weighted, explainable match against one ICP with matched
  and failed criteria, a keep/reject decision and a confidence value.
- **Claim-checked drafts** — drafts are generated from the offer plus the most
  recent evidence. Each prospect fact carries an evidence ID, and the gate
  re-validates on creation and again at approval, so removing a source blocks
  the draft.
- **Review queue** — approve or reject, with the blocking reasons shown
  (missing source, suppression, ineligible address).
- **Guardrails** — deterministic address checks (syntax, disposable domain,
  role mailbox) and a workspace suppression list that applies to addresses and
  whole domains before any approval.
- **Audit trail and usage ledger** — append-only, one row per consequential
  action, scoped to the signed-in account.

### Business search setup

Business search needs `GOOGLE_PLACES_API_KEY`, set as a Sites secret for the
environment you use (Sites → Secrets). It never belongs in a committed file or a
chat message. The adapter lives in `src/worker/places.ts` and requests only
`places.id,displayName,formattedAddress,websiteUri,primaryTypeDisplayName,nationalPhoneNumber,businessStatus`
to keep each call in the cheapest Places SKU. Google returns companies, not
named people, so a saved result carries a placeholder contact to be completed.

## Sending and replies

Approved messages go out through Mailgun (`src/worker/mail.ts`). Each message
carries a per-business reply address (`reply+<business id>@your-domain`), and a
Mailgun inbound route forwards answers to a signed webhook
(`POST /api/webhooks/mailgun`). Replies are matched to the business, labelled by
plain-English rules (`src/worker/replies.ts`), stored in `messages`, and shown
under `Replies`. Interested replies mark the business "Replied", count as
"Need your reply" on the home screen and email the owner when
`OWNER_NOTIFY_EMAIL` is set; "asked to stop" adds the address to the
do-not-contact list; bounces mark the address invalid.

Sending stays off until `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAIL_FROM` and
`MAILGUN_WEBHOOK_KEY` exist as Sites secrets, and the app explains that instead
of failing quietly. `DAILY_SEND_CAP` defaults to 20. Scheduled sending uses the
signed `POST /api/cron/send` endpoint (header `x-cron-key`), because hosting does
not run timers.

## Not implemented (deliberately deferred)

Gmail/Microsoft OAuth mailboxes, campaign sequences, follow-up reminders,
LinkedIn actions of any kind, an LLM provider, billing and team seats. Mail is
plain text only — no HTML templates, tracking pixels or open tracking.

## Run and check

```sh
bun install
bun run dev        # http://localhost:5173, local D1 under .wrangler
bun test
bun run typecheck
bun run build
```

The dev server binds to `0.0.0.0` for Cloud previews and runs the Worker with a
local D1 database. With no auth configuration on a loopback origin a single
labelled local preview identity is used; the fallback never applies on a hosted
origin or with incomplete auth configuration.

## Layout

- `src/client/main.tsx` — the React workspace (overview, prospects, review,
  playbook, guardrails, activity).
- `src/client/style.css` — styling.
- `src/worker/app.ts` — private API, validation, authorization, audit events.
- `src/worker/score.ts` — ICP parsing and explainable fit scoring.
- `src/worker/draft.ts` — draft construction and the claim-to-source gate.
- `src/worker/email.ts` — address checks and suppression matching.
- `src/worker/db.ts` — D1 schema plus audit and usage writers.
- `src/shared/types.ts` — API types shared by browser and server.

Every query binds parameters and scopes ownership by the authenticated user's
`sub`; schema creation is idempotent. Mutations require a same-origin request
and are rejected cross-origin.

## Publish with Freebuff

1. Create/inspect the site and target preview first.
2. Enable Sign in with Freebuff with `sites_enable_auth`; for local login
   testing supply the dev server's loopback origin and use only the returned
   development configuration locally.
3. Provision Sites database storage as `DB` with `sites_add_storage`.
4. Deploy with `sites_deploy` and `deploy.json`. Sites injects the reserved
   `FREEBUFF_CLIENT_ID`, `FREEBUFF_ISSUER` and `APP_ORIGIN` bindings.

Read `node_modules/@freebuff/auth/AGENTS.md` before changing sign-in. Never
derive the canonical origin from a request `Host`.

## Verify before publishing

`bun test` runs against a real local D1 database through Miniflare and covers
owner isolation, duplicate detection, scoring decisions, the evidence and
approval gates, suppression, CSV import/export, cross-origin refusal and
payload validation. After provisioning, verify real Freebuff sign-in, callback,
refresh and sign-out plus two real accounts' isolation in a browser — unit
identities do not prove the hosted login flow.
