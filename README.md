# Sun City Care Plan Builder

Customer-facing Care Plan selection and intake, staff practice, office submission management, and editable catalog publishing for Sun City Plumbing & Heating.

**Architecture (decision current October 27, 2026):** one GitHub repository (`jaycesuncity-code/Care-Plan-Builder`), one Cloudflare Pages project (`care-plan-builder`, production hostname `https://care-plan-builder.pages.dev`), one production Cloudflare D1 database (`care-plan-builder`, bound as `DB`), and one shared application codebase. The final customer pages are embedded into `youknowsuncity.com` via WordPress/LiveCanvas. **There is no planned public-repository or second-Pages-project split.** Historical mentions of a `care-plan-intake` project are superseded.

This is **request intake, not checkout**. Customers select a plan and eligible add-ons, review an estimated annual total, and send a request. The office confirms the selection, terms, and final price before payment and enrollment. Neither a submission nor a staff-practice request activates a membership.

## Components and trust boundaries

| Component | Path/source | Intended audience and behavior |
| --- | --- | --- |
| Public pricing catalog | `GET /catalog.json` | Unauthenticated, static, generated from approved D1 catalog during Pages builds; CORS `*` and short cache policy. |
| Live customer intake | `POST /api/care-plan-request` (`OPTIONS` preflight) | Unauthenticated, intended for the WordPress Builder; validates Turnstile, applies rate limits, reprices from D1, writes a **live** submission (`is_test=0`), and dispatches an office notification. |
| Office dashboard | `/`, `/api/submissions`, `/api/submissions/:id` | **Cloudflare Access required at the edge**. Staff read submissions, change statuses, and add notes. These routes do not independently verify Access JWTs in application code. |
| Pricing Editor | `/pricing/`, `/api/pricing-admin` | **Cloudflare Access required at the edge**. Pricing administration API independently verifies the Cloudflare Access JWT (issuer, audience, signature, editor permissions), plus origin/request checks. The page also has a non-security passphrase speed bump. |
| Staff practice Builder | `/careplan-builder/` | **Cloudflare Access required**. Uses `GET /api/pricing` for D1-backed catalog and `POST /api/test/care-plan-request` to save `is_test=1` requests. Normal office notifications are suppressed for practice requests. Keep this permanently. |
| Internal catalog API | `GET /api/pricing` | **Cloudflare Access required**. Reads the live D1 catalog; CORS checks are not authentication and do not replace Access. |
| WordPress membership pages | `youknowsuncity.com` | Public Memberships hub, interactive Builder, and HVAC, Plumbing, Bundled, Premier detail pages; embed curated markup from `public/`. |

The public Access exemptions must be tightly scoped to `/catalog.json` and `/api/care-plan-request` (including preflight). Protect every private route and any unclassified path that could expose staff data. A URL being on one Pages project does **not** automatically make its APIs private. Review route coverage and verify denied unauthenticated requests before launch. The owner reports that Access configuration was reviewed/addressed; its actual live rules are not stored or verifiable from this repository.

The public WordPress Builder uses:

```js
var CATALOG_ENDPOINT = 'https://care-plan-builder.pages.dev/catalog.json';
var SUBMIT_ENDPOINT = 'https://care-plan-builder.pages.dev/api/care-plan-request';
```

Each of the four WordPress plan-detail blocks uses:

```js
var CATALOG_URL = 'https://care-plan-builder.pages.dev/catalog.json';
```

The practice Builder instead deliberately keeps `CATALOG_ENDPOINT = '/api/pricing'` and `SUBMIT_ENDPOINT = '/api/test/care-plan-request'`; never repoint it at the live intake route. Configure the real Turnstile sitekey in the public WordPress Builder and the corresponding server-side `TURNSTILE_SECRET` on Pages. Confirm both WordPress origins are allowed for cross-origin POSTs.

## Pricing and publication

The **authoritative** catalog is in D1 (`pricing_items`, `pricing_meta`, `pricing_audit`). The editor can change approved plan/add-on prices and supported display text; eligibility rules, quantities, IDs, and non-price benefits remain in application code. All intake totals are recalculated server-side. An accepted change increments the version once and records field-level audit data. The editor detects conflicting versions and rejects unsupported full-plan-name changes if the `0009` schema correction is not present.

After a changed save, `functions/api/pricing-admin.js` triggers the configured Cloudflare Pages Deploy Hook(s). A successful Pages build runs `node scripts/build-catalog.mjs`, which queries D1 through Cloudflare's REST API using **build-time** credentials, validates the catalog, and atomically generates `public/catalog.json`. The editor polls the published version. A failed hook/build does not undo the accepted D1 change, and a reviewed no-op save can retry publication. The generated catalog is ignored by Git; **never hand-edit or commit it**.

The owner confirmed automatic publication worked and the public catalog reached **version 17 on October 27, 2026**, with original prices restored and the exposed hook rotated. This is a historical operational checkpoint, **not** the expected current version or independently verified production state. The current trigger fix is in `main` commit `1f313b5086684afa5f634349d49d86e1f7fdc4f7`. Read `STATIC-CATALOG-REPORT.md` as an implementation-time historical report, not live operational proof. Draft PR #8's alternative export Worker is **not** required for the working D1 REST build mechanism.

## Repository map

- `functions/api/care-plan-request.js`, `functions/api/test/care-plan-request.js`, and `lib/intake/*`: separate server-trusted live/test classification and shared intake, validation, authoritative pricing, persistence, rate limiting, Turnstile, and notifications.
- `functions/api/submissions/*`, `lib/submissions.js`, and `public/index.html`: dashboard API and interface.
- `functions/api/pricing.js`, `functions/api/pricing-admin.js`, `lib/admin/access.js`, `public/pricing/`: live staff pricing and protected editor.
- `scripts/build-catalog.mjs`: versioned public static catalog build; `public/_routes.json` excludes `/catalog.json` from the catch-all Function; `public/_headers` sets its content/cache/CORS headers.
- `public/careplan-builder/`, `public/memberships/`, `public/{hvac,plumbing,bundled,premier}-care-plan/`: practice Builder and WordPress/LiveCanvas source templates. Preserve the permanent practice Builder.
- `migrations/`: schema evolution through `0009_submission_plan_names.sql`; migration file presence does **not** prove production application.
- `n8n/care-plan-request-notification.json`: webhook-to-office-email workflow template, not proof that live n8n/Outlook credentials are configured.
- `tests/`: unit, local API/integration, and Chromium browser suites.
- `wrangler.toml`, `.dev.vars.example`: D1, environment variables, and secret-name reference. No real credentials belong in the repository.

The deployed Pages project's real name and its `wrangler.toml` top-level `name` are not currently identical. Verify project identity and Pages build configuration in Cloudflare before using any direct CLI deployment command. Git-connected deployments and deploy hooks are the established publication workflow; no deploy is part of documentation maintenance.

## Local development and tests

Requires a supported Node runtime; Node 22.13+ is the documented local test baseline (the tests use `node:sqlite`). Do not run tests pointing at production D1.

```bash
npm ci
cp .dev.vars.example .dev.vars  # local-only mock credentials; never commit this file
npm run db:migrate:local         # WRITES to the LOCAL D1 only
npm run mock:n8n                # optional local test service, port 8799
npm run dev                     # local Pages dev server, port 8788
```

Available scripts in `package.json`:

```bash
npm run test:unit  # one-shot Node tests
npm run test:api   # local Wrangler + mock-service integration; bounded-process caution
npm run test:e2e   # Chromium browser tests; requires Playwright setup
npm run test:all   # unit + API + browser
npm test           # unit + API
npm run build:catalog # production D1 REST query unless --fixture; NOT a routine local docs check
```

`test:api`, `test:e2e`, and `npm run dev` launch servers; they are **not** appropriate for unbounded CI. Never add duplicate feature-branch push/PR workflows or unbounded `wrangler pages dev` jobs. During documentation-only edits, use static checks instead of starting these services.

## Documentation hierarchy

1. **`README.md`** — system orientation, current architecture, and developer entrypoint.
2. **`SETUP.md`** — concrete local/Cloudflare/Access/catalog/WordPress configuration and safety boundaries.
3. **`LAUNCH-CHECKLIST.md`** — the one canonical, ordered launch checklist; distinguishes independently verified code, owner confirmation, and outstanding production verification.
4. **`SCHEMA.md`** — migration-by-migration schema and dashboard JSON contract.
5. **`builder-walkthrough.md`** — original exact-match LiveCanvas transformation reference, plus current routing corrections; prefer a fresh vetted copy of the current repository template rather than blindly replaying old replacements.
6. **`STATIC-CATALOG-REPORT.md`** — historical implementation/test evidence.

No repository changes, migrations, secret rotations, production requests, or WordPress edits should be inferred as complete merely because these documents describe how to do them.
