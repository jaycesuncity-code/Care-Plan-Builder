# Care Plan Builder — setup, operations, and WordPress handoff

**Current architecture, October 27, 2026:** one GitHub repository (`jaycesuncity-code/Care-Plan-Builder`), one existing Cloudflare Pages project (`care-plan-builder`; `https://care-plan-builder.pages.dev`), one production D1 (`care-plan-builder`; `DB` binding), and one shared codebase. **Do not create `care-plan-intake`, a second Pages project, or a separate public repository.** Staff functionality and public endpoints share the same host and require carefully verified, path-specific Cloudflare Access coverage.

Use [`LAUNCH-CHECKLIST.md`](LAUNCH-CHECKLIST.md) to track readiness. This guide explains *how* to configure the architecture. It does not authorize a deployment, migration, pricing edit, secret change, or WordPress publication. Owner-reported completed work is not automatically independently verified here.

## 0. Operation safety: read-only versus mutating

**Safe inspections** (assuming the intended repo/account is selected): `git status`, `git branch -avv`, `git rev-parse HEAD`, `git diff --check`, `npm run test:unit` (local one-shot), `npx wrangler d1 migrations list care-plan-builder --remote` (lists pending; check account first), and **SELECT-only** `wrangler d1 execute --remote --command "SELECT ..."`. Inspecting Cloudflare dashboard settings without saving is read-only.

**Mutating actions requiring separate explicit approval:** `git push` or merge; `npm run deploy`; Pages Deploy Hook invocation; `npm run db:migrate:remote`; any remote `wrangler d1 migrations apply`, `INSERT`, `UPDATE`, `DELETE`, or D1 restore; changing Cloudflare Access, secrets, builds, n8n, or WordPress; and editing prices. Local migrations (`npm run db:migrate:local`) alter only local D1 and must still be intentional. `npm run build:catalog` is **not a harmless docs check** without `--fixture`: it queries D1 and writes generated output.

Before acting on production, verify the actual Cloudflare account, Pages project, D1 database, branch, and current repository SHA. The checked-in `wrangler.toml` has `name = "sun-city-care-plan-dashboard"` whereas the actual Pages project is reported as `care-plan-builder`; confirm Cloudflare's project/build association rather than assuming a direct CLI deploy targets the right project. Avoid speculative deployments.

## 1. Local development

Use Node.js 22.13+ for the current test suites (`node:sqlite`). From a clean checkout:

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local   # MUTATES LOCAL D1 ONLY; applies pending local migrations
```

The example `.dev.vars` uses local mock URLs and non-production example values. Inspect it before running the app. Do **not** copy real secrets into git or into logs.

For interactive local development, in separate terminals:

```bash
npm run mock:n8n     # local mock webhook/siteverify, usually port 8799
npm run dev          # local Pages runtime, usually http://localhost:8788
```

Staff UI: `http://localhost:8788/`; practice Builder: `http://localhost:8788/careplan-builder/`; editor: `http://localhost:8788/pricing/`. Local-only `DEV_ADMIN_EMAIL` in `.dev.vars` bypasses Access verification **only** for `localhost`/`127.0.0.1`, per `lib/admin/access.js`. It cannot activate for a deployed hostname. Keep test fixtures and production data separate.

Tests/scripts verified in `package.json`:

| Command | What it does | Caution |
| --- | --- | --- |
| `npm run test:unit` | Node unit tests, including catalog, editor, and Builder tests | No production service required; may create local test artifacts |
| `npm run test:api` | Local D1/Wrangler/mock integration suite | Launches local processes; use bounded runs, no CI watcher |
| `npm run test:e2e` | Browser suite | Requires Playwright/Chromium setup and launches local processes |
| `npm test` | Unit and API suites | Not a static Markdown check |
| `npm run test:all` | Unit, API, e2e | Most expensive local verification |
| `npm run build:catalog` | Reads remote D1 REST and writes generated `public/catalog.json` | Requires configured build credentials; do not run during docs-only work |
| `npm run db:migrate:remote` | Applies remote migrations | **MUTATES PRODUCTION** if bound there; approval and backup required |

Do not add or modify GitHub Actions workflows as part of setup documentation. If CI is considered later: every job hard-timeout, `push` only on main plus PR verification, concurrency cancellation, bounded child processes, no rapid speculative reruns. A historically unbounded `wrangler pages dev` workflow exhausted runner minutes on another project. This repo's current `main` tree contains no `.github/workflows` files.

## 2. Cloudflare project, D1, and environment ownership

Cloudflare Pages: **`care-plan-builder`**. Production hostname: **`https://care-plan-builder.pages.dev`**. Production D1 name: **`care-plan-builder`**; code binding: **`DB`**. Confirm the ID directly in Cloudflare, then reconcile it with `wrangler.toml`; do not substitute an ID from an old screenshot. The current `wrangler.toml` binds Preview to the **same** D1 as production, so Preview activity is **not isolated** from production data. Do not conduct destructive or lead-submission experiments in Preview without a deliberate safety plan.

The repo is Git-connected. `wrangler.toml` controls plaintext runtime `[vars]` and D1 bindings; encrypted Pages secrets are configured in Cloudflare's environment settings. **Build-time** variables used by `scripts/build-catalog.mjs` must actually be available to the Pages **build process**; Functions/runtime `.dev.vars` is not the build environment. Confirm where each variable is configured and which environment/branch receives it. `[env.preview.vars]` and similar blocks are non-inheritable: restate the variables if overrides are used. Never add encrypted credentials to `wrangler.toml` or checked-in `.dev.vars.example`.

**Runtime plaintext configuration (in `wrangler.toml`):**

- `PUBLIC_CATALOG_URL`: URL the editor polls for published catalog version; production currently points at `https://care-plan-builder.pages.dev/catalog.json`. Preview is separately configured to a branch alias; verify it actually exists.
- `DASHBOARD_URL`: office dashboard URL used in notification payload.
- `ALLOWED_ORIGINS`: exact origin allowlist for browser CORS on intake and internal pricing API. Production must contain the actual `https://youknowsuncity.com` and/or `https://www.youknowsuncity.com` origins used. Preview entries should be reviewed, not treated as a security perimeter.
- `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_SECONDS`: default configured limit is five successful submissions in 600 seconds per hashed IP.

**Encrypted runtime secrets (Cloudflare Pages settings, never in source):**

| Secret | Purpose |
| --- | --- |
| `TURNSTILE_SECRET` | Verifies public intake Turnstile tokens server-side |
| `N8N_WEBHOOK_URL` | Private notification webhook destination |
| `N8N_WEBHOOK_SECRET` | Shared authentication credential for webhook |
| `IP_HASH_SALT` | Salt for the rate-limiter's stored IP hashes |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access team domain for pricing API token verification |
| `ACCESS_AUD` | **Pricing-specific** Access application audience tag |
| `PRICING_EDITORS` (optional) | Named exceptions beyond the exact `@suncitylc.com` editor domain |
| `CATALOG_DEPLOY_HOOK_URLS` | Private comma-separated Pages Deploy Hook URL(s); never paste the values into docs or logs |

`DEV_ADMIN_EMAIL` and `ACCESS_JWKS_URL` are local/test-only switches and must not be deployed as production bypasses. The Pricing Editor's page-side passphrase is a UI speed bump **not a replacement** for JWT verification or Access gating.

**Pages build-only configuration:**

- `CLOUDFLARE_API_TOKEN`: limited to the D1 read permission necessary for the catalog REST query (account scoping is not per-database authorization unless Cloudflare explicitly supports that restriction).
- `CLOUDFLARE_ACCOUNT_ID`: the verified Cloudflare account ID.
- `D1_DATABASE_ID`: the verified production D1 ID.

Use encrypted build-secret storage where supported and verify build logs do not echo values. Missing credentials or invalid D1 results cause a failed build; the script does not use hardcoded pricing as a fallback.

## 3. Cloudflare Access — same host, explicit public/private paths

Cloudflare Access/Microsoft Entra must authenticate staff paths **before** requests reach the Pages Functions. The owner reports that Access coverage was reviewed/addressed, but policies live outside this repository; repeat an **independent configuration and negative-access inspection** before launch. Do not change any policies while following this document without separate authorization.

**Public (no Entra sign-in):**

- `GET /catalog.json` (and relevant static-resource request handling).
- `OPTIONS` and `POST /api/care-plan-request` (live customer intake). Other unsupported methods may respond 405, not redirect to sign-in.

**Staff-only (Entra sign-in, correct path/subpath coverage):**

- `/` dashboard and any dashboard static assets/data endpoints.
- `/api/submissions` and `/api/submissions/*` (read/update, notes/status).
- `/pricing/` and `/api/pricing-admin` (Pricing Editor application, API).
- `/careplan-builder/` and its assets (permanent staff practice).
- `/api/test/care-plan-request` (practice-only intake).
- `/api/pricing` (live D1 pricing for staff practice; its CORS allowlist is **not** auth).
- Any other private API/routes revealed by a full tree/router audit. Keep unknown/unintended routes inaccessible to anonymous visitors.

Use Cloudflare Access application/path matching consistent with Cloudflare's actual behavior. Do **not** assume a broad application automatically exempts two public paths; test actual effective priority and wildcard behavior. Test unauthenticated requests in a clean browser/session and with a command-line client: the two public resources must remain usable, and **every** private UI/API must return an Access challenge/denial rather than staff data or an administrative action. Repeat checks for trailing slashes, path variants, previews and custom domains. Access token validation is implemented directly in `lib/admin/access.js` for **pricing administration only**; dashboard/submissions/practice/pricing read routes presently rely on the edge policy.

## 4. D1 migration review — do not infer production state

Repository migrations: `0001`, `0002` (development seed), `0004`, `0005`, `0006`, `0007`, `0008`, and `0009`. `0003` is absent; do not invent or execute it. The latest migration is `0009_submission_plan_names.sql`, a submissions-table rebuild allowing approved editor-managed full plan names while retaining existing children, history, IDs, classification and AUTOINCREMENT state. `0008_catalog_text.sql` adds display text and per-field pricing audits; `0007` adds `is_test`; `0006` adds catalog pricing/meta/audit.

**Production application status of 0006–0009 is unknown to this GitHub-only audit.** An SQL file existing on `main` does **not** mean it has been applied remotely. Before any planned migration, with explicit authorization:

1. Inspect Cloudflare account, Pages DB binding, `npx wrangler d1 migrations list care-plan-builder --remote` (**read-only**), `d1_migrations`, and the *actual* remote schema (`PRAGMA table_info`, `sqlite_master`, indexes/triggers, relevant row counts) using read-only commands.
2. Stop if schema differs from the migration assumptions; never silently rewrite already-applied migrations.
3. Export/verify a restricted backup (`wrangler d1 export ... --remote` reads production but writes a sensitive local backup). Never commit backup data.
4. Schedule any required write pause for a table-rebuild migration. Separately approve and apply **only** reviewed pending migrations; no migration is authorized by this guide.
5. Compare post-migration counts, child rows, flags, IDs, foreign keys, `sqlite_sequence`, catalog rows, and `d1_migrations`; then verify the Pricing Editor schema gate.

**Never** run `0002_seed_data.sql` against production as a launch step or delete any submissions by assuming an ID range is test data. See `SCHEMA.md` for the historical schema sequence.

## 5. Pricing Editor and automatic static-catalog publication

The Pricing Editor is at `/pricing/`; its API is `GET/PUT /api/pricing-admin`. Access protects the page, while the API independently verifies the signed Access JWT and checks editor email, issuer/audience, and request-origin/header conditions. D1 changes and audit records are transactionally coordinated via `DB.batch()` and version checks. A real changed save increments `pricing_meta.version`; a no-op save can intentionally retry publication without a new version/audit entry.

Configured `CATALOG_DEPLOY_HOOK_URLS` cause an HTTPS POST from the server after an accepted save. A fix to `redirect: "manual"` is present in current `main` at `1f313b5`, addressing failed Deploy Hook triggers. The Pages build must run:

```text
Build command: node scripts/build-catalog.mjs
Output directory: public
```

`scripts/build-catalog.mjs` reads D1 through the Cloudflare REST API using the three **build-time** values, checks the two query results and catalog fields, then atomically writes `public/catalog.json`. `public/_routes.json` excludes that URL from the catch-all Pages Function; `public/_headers` sets JSON/CORS/cache headers. The public WordPress site loads this generated file; no manual catalog editing or manual WordPress price synchronization should be required for ordinary supported catalog updates.

Owner-confirmed checkpoint on **October 27, 2026**: an updated catalog was published successfully, version 17 was visible, original prices had been restored, and the formerly exposed Deploy Hook was rotated with the new value configured. **Do not rotate the hook again or trigger another deployment just because older docs say to.** This audit could inspect repository code, but not the Cloudflare production build history, hook configuration or actual public version; those remain owner-reported unless inspected in Cloudflare.

If publication fails in the future: inspect the saved D1 version versus the accessible static version, Pages build logs, build-time variable presence (not values), hook status and exact effective catalog URL. Do not repeatedly retry hooks or make speculative pricing changes. If saved D1 changes already occurred, separate catalog publication failure from pricing persistence failure before attempting recovery. Draft PR #8's alternative export Worker remains unmerged and is **not** a launch requirement.

## 6. WordPress/LiveCanvas setup — final customer journey

Use existing WordPress pages on `youknowsuncity.com` where appropriate; do **not** create a separate Member Sign-Up step. The Builder ends in a customer **request form** with no online payment/enrollment. The public-facing pages are:

1. **Memberships:** hub/overview, embedded Builder, links to four plan details and any separately maintained commercial service/rewards content.
2. **HVAC Care Plan:** source `public/hvac-care-plan/index.html`.
3. **Plumbing Care Plan:** source `public/plumbing-care-plan/index.html`.
4. **Bundled Care Plan:** source `public/bundled-care-plan/index.html`.
5. **Premier Care Plan:** source `public/premier-care-plan/index.html`.

For the hub, use the `BEGIN PASTE` / `END PASTE` section from `public/memberships/index.html`. For the Builder, paste the bounded block beginning at `BEGIN SUN CITY CARE PLAN BUILDER` into a LiveCanvas custom HTML block (keep scoped CSS/IIFE) without demo document wrappers. For the four details, retain the intended block but remove the demo HTML wrapper, preserving their scoped styles/JS and live navigation. Verify WordPress slugs and any media-library image replacements. Do not assume older `builder-walkthrough.md` Find/Replace steps can be replayed unmodified: they are a historical transformation reference and the current source template is authoritative.

**WordPress Builder launch constants:**

```js
var CATALOG_ENDPOINT = 'https://care-plan-builder.pages.dev/catalog.json';
var SUBMIT_ENDPOINT = 'https://care-plan-builder.pages.dev/api/care-plan-request';
var TURNSTILE_SITEKEY = '<real public widget sitekey, not the Cloudflare test key>';
```

**All four detail pages:**

```js
var CATALOG_URL = 'https://care-plan-builder.pages.dev/catalog.json';
```

**Protected staff practice Builder, do not change:**

```js
var CATALOG_ENDPOINT = '/api/pricing';
var SUBMIT_ENDPOINT = '/api/test/care-plan-request';
```

Use the **same** static catalog URL for every WordPress component. Its data controls catalog prices, plan names, short labels and descriptions, while plan eligibility, feature bullets and other business rules remain in source. Make no business-price or benefit changes based on an old screenshot/spreadsheet; review the live D1 catalog against the approved pricebook first. WordPress pages need graceful catalog-load failure behavior and must not silently submit with stale prices.

Configure a real **Cloudflare Turnstile** widget for the actual WordPress hostname(s) (`youknowsuncity.com` and `www.youknowsuncity.com` when both resolve); configure its secret on the Pages app. Ensure the script survives LiveCanvas code-editor saves. Ensure both actual `Origin` values are in `ALLOWED_ORIGINS`. Cross-origin POST requests must use the live endpoint; never submit production leads to `/api/test/care-plan-request` or price the public Builder against protected `/api/pricing`.

Customer submits name, phone, service address, preferred callback time and selected plan/add-ons (plus verification). The server validates the request, verifies Turnstile, enforces rate limiting, compares catalog version for changed totals, reprices authoritatively, saves live `is_test=0`, returns a request confirmation, and sends the office notification asynchronously. No online card capture, charge, membership activation, or appointment booking occurs. Staff follows up to verify selection, final price, terms and payment, then activates/schedules through the approved office process. Keep required acknowledgment separate from marketing or recurring-charge consent.

## 7. Production notifications (n8n / Outlook)

`n8n/care-plan-request-notification.json` defines the webhook → formatting Code node → Outlook office email pipeline. Importing JSON does not configure real credentials; confirm the production workflow is active and that the webhook credential matches `N8N_WEBHOOK_SECRET`, the secret URL is the production `/webhook/` URL (not editor `/webhook-test/`), and Outlook is authorized to deliver to `service@suncitylc.com`. Check that the office email includes the correct submission/plan/add-on snapshot and dashboard link.

`lib/intake/notify.js` suppresses normal notifications for `is_test=1`. The public live route creates `is_test=0` independently of browser-supplied flags. A failed n8n delivery does not undo a saved submission; monitor failures and manually follow up when needed. Never include real webhook secrets or customer PII in screenshots/public audit output.

## 8. Launch and troubleshooting verification order

Use the **remaining** section of `LAUNCH-CHECKLIST.md`, in dependency order. At minimum independently verify: current release commit and code/DB identity; actual applied migrations/schema; effective Access public/private path coverage; production secrets and build settings; public catalog structure/version; approved plan prices/terms; WordPress constants and media; Turnstile; n8n/Outlook delivery; and a controlled live request leading to the protected office dashboard. Perform browser/mobile/keyboard/accessibility checks.

Avoid the old test instruction to send six live requests merely to test a 429: that creates unnecessary real leads, sends notifications, and consumes production rate limits. Exercise 429 behavior locally/integration tests or in a controlled test environment. If a real production smoke request is approved, use a clearly identified test lead and record its exact ID for authorized cleanup; **never** bulk-delete rows by assuming IDs above a threshold are synthetic.

Common diagnostics:

| Symptom | Check |
| --- | --- |
| WordPress price stays stale | Catalog URL, public cache, D1 version vs generated `catalog.json`, publication/build logs |
| Catalog build fails | Presence of 3 build-time credentials, D1 query shape/permissions, required item/text rows; don't print tokens |
| Price editor fails 401/403/503 | Pricing Access app and audience, exact company editor identity, JWT configuration/JWKS, DB binding |
| Public resource redirects to Entra | Effective Access path priority; public catalog/intake exemptions |
| Anonymous staff data exposed | **Stop launch**; close Access coverage before further live tests |
| WordPress request CORS error | Exact WordPress origin(s) in `ALLOWED_ORIGINS`, correct live intake URL and preflight |
| Turnstile fails | Production sitekey hostname binding, `TURNSTILE_SECRET`, script persistence, one-use token reset |
| `409 PRICES_CHANGED` | Re-fetch static catalog and require customer review of changed total |
| `503 PRICING_UNAVAILABLE` | Live D1/catalog validation or binding; never submit fallback seed prices |
| Office email missing | n8n active production workflow, webhook credentials, Outlook credential, Function notification error logs |
| Practice lead emails office | Check server-controlled `is_test` routing/notification suppression; stop live testing if misrouted |

See `SCHEMA.md` for the DB contract, `builder-walkthrough.md` for legacy exact-match details, and `STATIC-CATALOG-REPORT.md` for historical implementation evidence.
