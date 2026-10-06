# Care Plan Submissions Dashboard

Internal office tool for Sun City Plumbing & Heating. Lists leads that came in through
the public-facing Care Plan Builder widget, lets office staff update each lead's status,
and attach notes as they work it. Cloudflare Pages + Pages Functions + D1.

See [`SCHEMA.md`](./SCHEMA.md) for the database schema and how it maps to the
dashboard's JSON shape.

## Structure

```
/functions/api/submissions/index.js   GET  /api/submissions      — list all submissions
/functions/api/submissions/[id].js    PATCH /api/submissions/:id — update status (+ optional note)
/functions/api/care-plan-request.js   POST /api/care-plan-request — PUBLIC intake from the Builder
/functions/api/pricing.js             GET  /api/pricing — PUBLIC read-only pricing feed
/functions/api/pricing-admin.js       GET/PUT pricing editor API — gated dashboard only
/functions/[[path]].js                sandbox-only 404 fallback to the live site
/lib/submissions.js                   shared helpers (row → JSON shaping, used by both)
/lib/intake/                          public/intake modules, including D1 pricing reads
/lib/admin/                           Access JWT verification; gated dashboard only
/public/pricing/index.html             staff price editor (Access + passphrase speed bump)
/public/index.html                    the dashboard itself (Pages build output dir)
/public/memberships/index.html        NEW Memberships landing page — built by a separate branch (feature/memberships-landing-page)
/public/careplan-builder/index.html    SANDBOX mirror of the residential WordPress Care Plan Builder
/public/{hvac,plumbing,bundled,premier}-care-plan/  sandbox mirrors of the plan pages
/migrations/0001_init_schema.sql      D1 schema
/migrations/0002_seed_data.sql        4 sample submissions, for local dev/testing
/migrations/0004_…, 0005_…            intake schema changes (0003 is intentionally skipped)
/migrations/0006_pricing.sql           editable pricing + audit + optimistic version
/n8n/care-plan-request-notification.json  importable workflow: webhook → Outlook email
/tests/                               unit, API and browser suites
/wrangler.toml                        D1 binding (DB), vars, pages_build_output_dir = "public"
```

## The public intake endpoint

`POST /api/care-plan-request` is what the Care Plan Builder submits to. It is written
to be **self-contained**: at launch it moves to a separate *public* Pages project with
no Cloudflare Access, bound to this same D1 database, while this dashboard stays behind
Access. Nothing in `functions/api/care-plan-request.js` or `lib/intake/*` imports the
Access middleware or reads `context.data.staffEmail`; every knob comes from `env`.

Order of checks — cheapest and most private first:

1. method + CORS origin allowlist (denied origin → 403, no CORS headers)
2. body size + JSON parse (413 / 400)
3. field validation (400 with per-field messages)
4. rate limit, read-only (429 + `Retry-After`)
5. Turnstile siteverify (403; fails closed)
6. server-side repricing from D1 via `lib/intake/pricing.js`, requiring complete, valid pricing with no catalog-price fallback — **client prices are ignored**
7. insert submission + add-on rows
8. record the rate-limit hit (only successful submissions count)
9. 201, then the n8n office email via `context.waitUntil()` — an n8n outage can never
   fail the customer's submission

See `SETUP.md` for the click-by-click config, and `builder-walkthrough.md` for the
Find/Replace steps to bring the LiveCanvas copy of the Builder in line.

## Tests

```bash
npm run test:unit   # pricing, validation, builder↔catalog parity, the n8n Code node
npm run test:api    # wrangler pages dev + local D1 + mocked n8n/Turnstile
npm run test:e2e    # optional: real Chromium against the real Builder page
                    #   npm i -D playwright && npx playwright install chromium
npm test            # unit + api
```

`npm run test:api` starts `wrangler pages dev` itself (four times, one per config
group) and needs ports 8788 and 8799 free. `npm run mock:n8n` runs just the webhook +
siteverify mock if you want to poke at the endpoint by hand.

## Prerequisites

- Node.js
- A Cloudflare account with the `care-plan-builder` D1 database already created
  (done — see `SCHEMA.md` for its id)
- `wrangler login` (run once, opens a browser to authenticate)

```bash
npm install
wrangler login
```

## Run it locally

`wrangler pages dev` runs a local D1 (a SQLite file under `.wrangler/`), separate from
your real Cloudflare D1 database until you explicitly apply migrations `--remote`.

```bash
# Apply schema + seed data to the local D1
npm run db:migrate:local

# Start the dashboard + API locally
npm run dev
```

This serves the dashboard at `http://localhost:8788` with `/api/submissions` backed by
the local D1. Reloading the page re-fetches from that local database, so any status/note
changes you make persist across reloads (unlike the old mock-data prototype, which reset
on every reload).

To inspect the local database directly:

```bash
npm run db:query:local "SELECT id, name, status FROM submissions"
```

## Deploy

```bash
# One-time: apply schema + seed to the REAL Cloudflare D1 database
npm run db:migrate:remote

# Deploy
npm run deploy
```

`wrangler pages deploy public` uploads `/public` as static assets and `/functions` as
Pages Functions, using the `DB` binding from `wrangler.toml`.

### Connecting to GitHub (manual step, on you)

This repo is set up ready for `git init` + push, but isn't connected to GitHub or
Cloudflare's auto-deploy yet — that's a manual step in the Cloudflare dashboard once the
GitHub repo exists (Pages project → Settings → Builds & deployments → connect repo).

## Known gaps — flagging before this goes live

- **No authentication.** The dashboard and both API endpoints are wired up but
  completely unauthenticated in this repo — anyone with the URL can view and edit
  submissions. The plan (per project notes) is to gate this with Cloudflare Access +
  Microsoft Entra ID at the edge, same pattern as the Membership Email List project.
  **Don't share the deployed URL outside the office until that's configured.** The
  dashboard's footer says this in-product as a reminder.
- **No rate limiting or captcha on the dashboard's own endpoints.** `GET
  /api/submissions` and `PATCH /api/submissions/:id` still rely on Access to gate
  them. The rate limiting and Turnstile in this repo protect
  `POST /api/care-plan-request` only.
- **No `POST /api/submissions`.** Still true, and still intentional: creating a
  submission is `POST /api/care-plan-request`'s job.
- **The sandbox pages are in this project.** `public/careplan-builder/` is the residential Builder mirror; `public/memberships/` is the new landing page built by a separate branch (`feature/memberships-landing-page`); and the four `*-care-plan/` directories mirror the WordPress plan pages. `functions/[[path]].js` + `public/404.html` exist only to keep sandbox links alive.
  All of it is listed for deletion in `SETUP.md`'s launch section.
- `migrations/0002_seed_data.sql` is 4 rows of realistic test data — useful for local
  dev, not meant to ship into the real database more than once. Re-running it will
  error on the primary-key conflicts if the rows already exist.

## What changed from the mock-data prototype

- `MOCK_SUBMISSIONS` (the hardcoded array) is gone. The dashboard now `fetch`es
  `/api/submissions` on load, with a loading state while that's in flight and a retry
  button if it fails.
- `applyStatusChange()` now `PATCH`es `/api/submissions/:id` instead of mutating a
  local array. On success, the row returned by the API (which reflects what's actually
  in D1) replaces the local copy. On failure, the status dropdown reverts to its
  previous value and an alert is shown — the same recovery behavior Cancel already had
  on the notes prompt.
- The API additionally returns `basePrice` per submission (not in the original mock
  shape, but present in the DB and cheap to include — see `SCHEMA.md`).
  Historical submission details use the accepted base price and add-on line totals saved
  with that submission. Later catalog changes do not reprice historical submissions.
  Missing historical amounts show **Not recorded**.
- The header's "UX PROTOTYPE · MOCK DATA" tag and the footer's "resets on reload" note
  were updated since both were now inaccurate — replaced with a "LIVE DATA · NO AUTH
  YET" tag and a footer note about the auth gap. No other visual/layout changes.


## Editable pricing

Prices are stored in D1 `pricing_items`; coverage, included quantities and all pricing
rules remain in `lib/intake/catalog.js`. The public Builder reads
`GET /api/pricing` (edge-cached for up to five minutes), while the intake endpoint reads
D1 directly before every submission. If a customer submits a stale pricing version whose
total changed, the endpoint returns `409 PRICES_CHANGED` before inserting anything.

The Builder shows a loading state until the complete pricing payload is validated.
A failed request, timeout, malformed payload, or missing required price clears displayed
amounts and disables requests, including submission from an open modal. Selections remain
in place; an explicit retry can restore pricing. It displays **Current pricing is unavailable.**
and a clickable office number (575-526-9758). There are no background retries or default-price
fallbacks. Intake requires a loaded pricing version and complete authoritative D1 prices;
`503 PRICING_UNAVAILABLE` saves no submission and sends no office notification.

The staff editor at `/pricing/` writes through `PUT /api/pricing-admin`. It requires
a valid pricing-specific Cloudflare Access JWT and a verified email exactly on
`@suncitylc.com` (or an address in the optional `PRICING_EDITORS` exception list), uses
SQL-guarded optimistic concurrency, and records each real change in `pricing_audit`.
See `SETUP.md` for Access policy, secrets and the passphrase-hash step.
