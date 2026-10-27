# Care Plan Builder — canonical production launch checklist

**Reviewed documentation baseline:** GitHub `jaycesuncity-code/Care-Plan-Builder`, `main` at `1f313b5086684afa5f634349d49d86e1f7fdc4f7`, inspected October 27, 2026. **Do not treat this SHA as a permanent release pin.** Re-check `origin/main` before acting. This checklist is the single source of truth for remaining launch work. `SETUP.md` contains procedural details; `SCHEMA.md` contains migrations and table definitions.

**Locked architecture:** **one** GitHub repository, **one** Cloudflare Pages project (`care-plan-builder`, `https://care-plan-builder.pages.dev`), **one** production D1 (`care-plan-builder`), **one** shared codebase. WordPress/LiveCanvas on `youknowsuncity.com` hosts the final public customer pages. **No second public repository/Pages project and no `care-plan-intake.pages.dev`.** Cloudflare Access controls private paths on the same Pages hostname; public endpoints are limited to `/catalog.json` and `/api/care-plan-request`. A permanent internal practice Builder stays at `/careplan-builder/`.

**Evidence policy:** Check only those activities you personally verify in the intended environment. Distinguish implemented code, owner-reported outcomes, and actual live configuration. A file in `migrations/` does not prove application to remote D1; prior test counts do not mean the current commit was tested; owner security confirmation does not expose actual Access policy details. No action on this checklist alone authorizes a production change.

## A. Completed and independently verified in the current repository

- [x] GitHub repository exists, default branch `main`, and commit `1f313b5` fixes Pages Deploy Hook redirect handling (`redirect: "manual"` in `functions/api/pricing-admin.js`).
- [x] `testbranch` is **two commits behind** `main`, **zero ahead**; there is no need to merge it just to bring `main` current (verified October 27, 2026).
- [x] Draft [PR #8](https://github.com/jaycesuncity-code/Care-Plan-Builder/pull/8) (alternative authenticated catalog-export Worker) remains **open and unmerged**; it is **not** a launch prerequisite for the implemented REST-based build.
- [x] One shared application repository contains dashboard, live intake, practice intake, editor, staff pricing API, static-catalog generator and WordPress HTML templates.
- [x] `POST /api/care-plan-request` explicitly passes `isTest:false` and `POST /api/test/care-plan-request` explicitly passes `isTest:true` to the shared handler; the client cannot designate live/test classification.
- [x] `lib/intake/*` implements server-side validation, rate limiting, Turnstile verification, D1 catalog repricing, persistence, version-check `409`, and asynchronous notification; practice notifications are suppressed by code.
- [x] The staff Builder's repository source uses internal live pricing `/api/pricing` and practice intake `/api/test/care-plan-request`; keep both endpoints permanently behind Access.
- [x] The WordPress-facing templates have catalog hydration support; the four detail pages expose a configurable `CATALOG_URL` (currently relative in the template), so they need their **public absolute** URL upon transfer.
- [x] `GET/PUT /api/pricing-admin` validates Cloudflare Access JWT in `lib/admin/access.js` (not a blanket JWT check on all other internal routes); pricing changes are audited, versioned and guarded against conflicts.
- [x] Static-catalog generator `scripts/build-catalog.mjs` reads D1 via Cloudflare REST using three build-time values, validates required fields, and writes `public/catalog.json` atomically.
- [x] `public/_routes.json` excludes `/catalog.json` from Pages Function routing; `public/_headers` provides JSON, CORS, and cache headers. Catalog is generated and ignored by Git; not a manually editable source.
- [x] Repository migrations exist through `0009_submission_plan_names.sql` (`0006` pricing, `0007` live/test, `0008` catalog text/field audit, `0009` plan-name CHECK rebuild and history preservation). **Existence only; remote migration status still unknown.**
- [x] `n8n/care-plan-request-notification.json` and configured tests/scripts exist. This is not proof that live Outlook/n8n delivery works.
- [x] Current `main` Git tree has **no** `.github/workflows/*` files; no CI workflow changes are necessary for docs cleanup.

## B. Completed according to owner confirmation; independent operational verification pending where applicable

- [x] **Owner-confirmed October 27:** Pricing Editor successfully invoked automatic Pages deployment, published an updated catalog, and observed public `catalog.json` at **version 17**. Treat version 17 as a **dated checkpoint**, not a fixed expected version.
- [x] **Owner-confirmed October 27:** Original prices were restored and automatic pricing publication worked after the redirect fix. No need to induce another price save or deployment solely to repeat this.
- [x] **Owner-confirmed October 27:** The formerly exposed Pages Deploy Hook URL was rotated and `CATALOG_DEPLOY_HOOK_URLS` was updated. **Do not rotate again just to satisfy stale instructions.**
- [x] **Owner-confirmed October 27:** Access public/private configuration was reviewed and addressed. Actual effective policies/path precedence remain external to GitHub and have not been independently checked in this documentation audit.

These confirmations are recorded to prevent repeatedly declaring finished work a blocker. The checks below are **targeted validation of the live environment**, not requests to redo completed setup.

## C. Remaining launch tasks — dependency order and priority

### P0 — establish a safe, reproducible release state (read-only first)

- [ ] **NEXT TASK:** Independently inspect production D1 migration history and current schema for `0006`–`0009` **without applying migrations**. Confirm the correct Cloudflare account, production D1 ID and repository binding; run `wrangler d1 migrations list care-plan-builder --remote` and approved read-only schema checks. Record applied/pending status per migration and identify schema drift or required safeguards. **Stop before any mutation.**
- [ ] Confirm current `origin/main` SHA immediately before launch, tree status, and any relevant unmerged PRs; do not use `testbranch` just because an old document said it was ahead.
- [ ] Review migrations present but not applied (if any), protect a restricted backup, check table/child/index/trigger/sequence preservation, and separately authorize any required remote migration. `0009` is a rebuild; avoid writes during its approved application and perform post-migration integrity checks. Do not execute it as a byproduct of a read-only audit.
- [ ] Verify the production Pages project and runtime/build configurations point at the expected single D1; note Preview currently references **the same production D1** in `wrangler.toml` and plan non-destructive testing accordingly.

### P0 — confirm security boundaries and production configuration

- [ ] Independently inspect **effective** Cloudflare Access application/path rules on the actual Pages production hostname. Public anonymous requests must reach **only** the intended catalog and live intake paths. The dashboard, `/api/submissions*`, `/pricing/`, `/api/pricing-admin`, `/careplan-builder/`, `/api/test/care-plan-request`, and `/api/pricing` must be protected, including trailing-slash and preview variations. Test anonymous denial for both read and write methods. Owner reports Access reviewed: **validate, do not recreate**.
- [ ] Confirm pricing-specific Access issuer/AUD and editor-domain authorization against the existing JWT implementation. Do not assume the dashboard app's AUD is interchangeable with the Pricing Editor AUD.
- [ ] Confirm that the current rotated Deploy Hook secret is stored in the encrypted Pages settings and not present in repo, public HTML, screenshots, or logs. **No unnecessary rotation or hook invocation.**
- [ ] Confirm the three build-time variables (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`) are available to the existing Pages build with minimum practical D1 read permissions; never expose values.
- [ ] Confirm runtime secrets (`TURNSTILE_SECRET`, `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`, `IP_HASH_SALT`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, optional `PRICING_EDITORS`) and plaintext `wrangler.toml` variables are in the correct environments. Do not recreate known-good secrets without cause.
- [ ] Verify actual `PUBLIC_CATALOG_URL` and generated catalog version/shape, current Pages build command (`node scripts/build-catalog.mjs`), output (`public`), cache headers and unauthenticated CORS. A production catalog version higher than the historical v17 checkpoint is normal.
- [ ] Confirm configured public `ALLOWED_ORIGINS` matches the WordPress production origin(s) exactly; CORS is not staff authentication.

### P1 — approve customer-facing business content and web flow

- [ ] Authorized owner reviews current **D1** pricing, names, descriptions, add-ons, Premier salt/RO rules and plan policies against the latest approved business pricebook. Do not revert to old spreadsheet prices by assumption. Verify WordPress marketing pages express the same approved terms.
- [ ] Obtain final business/legal review of the annual-plan terms, automatic-renewal/cancellation disclosures, benefits and customer acknowledgments before publishing. A request does not constitute enrollment, payment, or appointment booking; keep marketing consent separate. Legal review is an approval task, not proof of legal noncompliance.
- [ ] Validate the existing WordPress page structure/slugs: Memberships hub plus HVAC, Plumbing, Bundled and Premier plan details; Rewards and Commercial Maintenance links remain separate where needed. No separate Member Sign-Up page is part of this request flow.
- [ ] Paste a freshly reviewed Builder block from `public/careplan-builder/index.html` into the WordPress Memberships page, preserving scoped HTML/CSS/JS and removing demo wrapper. Confirm production-safe content/Turnstile; **do not overwrite** the protected practice Builder or route it to live intake.
- [ ] Configure WordPress Builder `CATALOG_ENDPOINT = 'https://care-plan-builder.pages.dev/catalog.json'` and `SUBMIT_ENDPOINT = 'https://care-plan-builder.pages.dev/api/care-plan-request'`; confirm the **real** Turnstile widget sitekey (not a test key).
- [ ] Configure **each** of the four WordPress plan detail blocks' `CATALOG_URL` to the **same** absolute `https://care-plan-builder.pages.dev/catalog.json`; verify public prices, text hydration, accessible failure behavior and no protected `/api/pricing` dependency.
- [ ] Publish/update existing Memberships and plan detail pages through the approved WordPress process; verify all navigation targets and replace local `/img/` references with correct WordPress media URLs as appropriate.

### P1 — operational intake and notifications

- [ ] Verify production Turnstile widget hostnames include the actual WordPress origin(s), the LiveCanvas script persists, the corresponding Pages secret is configured and real tokens validate server-side; retries use new tokens.
- [ ] Verify n8n workflow is imported/active with the **production** webhook and matching Header Auth credential; Outlook can send the intended notification to `service@suncitylc.com` and the message includes the correct dashboard link and accepted price snapshot.
- [ ] Test the permanent staff-practice Builder behind Access: catalog from `/api/pricing`, submission to `/api/test/care-plan-request`, dashboard label TEST, and **no routine office email**. Use controlled practice inputs only; Preview shares production D1.
- [ ] Confirm office dashboard operations: private submission read/write APIs, statuses, notes, record ordering, accepted historic prices, link safety and staff authorization.

### P2 — controlled final verification and go/no-go

- [ ] Run appropriate bounded unit/API/browser verification on the **actual release SHA**. Prior report counts (`202` unit, `191` API at implementation time; other earlier counts) are history, not current-run proof. No unnecessary GitHub Actions workflow or unbounded process launch.
- [ ] Verify desktop/mobile/keyboard/accessibility behavior, loading/error states, changed-pricing 409 path, Turnstile and CORS without generating repeated live leads.
- [ ] Obtain explicit authorization for **one controlled real production intake smoke test**. Confirm unauthenticated public access, actual request submission, correct live classification, saved plan/add-on totals, protected dashboard visibility and delivered office email. Use a clearly traceable test ID, not ID-range deletion.
- [ ] Review alerts/failure handling, office callback ownership, documentation of the current release/catalog version and rollback/recovery approach. Record who approved launch and when.
- [ ] Confirm no security/terms blocker remains. Finalize WordPress visibility only after the go/no-go review; do not treat this checklist as permission to publish.

## Change-control / CI safety

- No GitHub commits/pushes, PR merges, deployments, remote D1 writes/migrations, secret changes or WordPress changes are authorized by this documentation-only update.
- Do not create, modify, or trigger `.github/workflows/*` as a side effect. If separate CI changes are ever approved: `timeout-minutes`, PR-only feature verification, main-only push verification, concurrency cancellation, bounded child processes and careful inspection before reruns are mandatory.
- `public/catalog.json` is generated output; it must never be hand-edited or used as a source file.
- Preserve `public/careplan-builder/index.html` for permanent staff practice.
- Keep separate historical reports as history; current verified status belongs here.

**Single next logical launch task after documentation cleanup:** *Read-only production D1 migration/schema reconciliation for 0006–0009, with exact applied/pending status and schema evidence recorded, before deciding whether any database operation is needed.*
