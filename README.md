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
/lib/submissions.js                   shared helpers (row → JSON shaping, used by both)
/public/index.html                    the dashboard itself (Pages build output dir)
/migrations/0001_init_schema.sql      D1 schema
/migrations/0002_seed_data.sql        4 sample submissions, for local dev/testing
/wrangler.toml                        D1 binding (DB), pages_build_output_dir = "public"
```

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
- **No rate limiting or captcha** on the API — out of scope here per the original spec
  (that belongs to the public-facing Builder intake, not this internal dashboard), but
  worth keeping in mind given point above.
- **No `POST /api/submissions`.** This dashboard only ever reads and updates existing
  rows; creating a submission is the public Builder's job (a separate system), so that
  endpoint was intentionally not built here.
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
  shape, but present in the DB and cheap to include — see `SCHEMA.md`). The dashboard
  doesn't currently read it; it still computes the price breakdown from its own
  `PLAN_BASE_PRICE`/`ADDON_CATALOG` lookups, same as before.
- The header's "UX PROTOTYPE · MOCK DATA" tag and the footer's "resets on reload" note
  were updated since both were now inaccurate — replaced with a "LIVE DATA · NO AUTH
  YET" tag and a footer note about the auth gap. No other visual/layout changes.
