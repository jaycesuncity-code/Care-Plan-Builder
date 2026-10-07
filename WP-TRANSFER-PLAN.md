# WordPress transfer plan — Care Plan pages

**Repository:** `jaycesuncity-code/Care-Plan-Builder`  
**Authoritative base:** `main` @ `8eefb9f280700c93636b11f50bb096b3920090f8`  
**Transfer/fix branch:** `docs/wp-transfer-staging`  
**WordPress:** `https://www.youknowsuncity.com` — WP Engine + LiveCanvas + Yoast  
**Existing staff Pages host:** `https://care-plan-builder.pages.dev`

This plan supersedes the older transfer document where it conflicts with the owner's current launch decisions. It does **not** instruct anyone to split the repository, create a separate `care-plan-intake` project, reapply completed D1 migrations, remove the staff practice Builder, or expose the staff application broadly.

## 1. Current verified state

- `main` is still `8eefb9f`; no newer main commit displaced the transfer base.
- The WordPress transfer package was generated from that release and the 02–07 page regions match that intended release structure.
- Member Rewards was the real paste blocker. It has now been rebuilt on `docs/wp-transfer-staging` under `.scp-rw` with prefixed classes/IDs, no global page selectors, no duplicate `<header>`, `<main>`, or `<footer>` landmarks, and no scripts.
- Member Rewards visible-text parity with the original was checked mechanically and is exact.
- Its CSS verification reports 48/48 selectors rooted at `.scp-rw`.
- 03–06 each contain two complete inline script blocks and now point directly to `https://care-plan-builder.pages.dev/catalog.json`.
- The WordPress Builder points to `https://care-plan-builder.pages.dev/catalog.json` and `https://care-plan-builder.pages.dev/api/care-plan-request`; it does not execute the staff `/api/pricing` or `/api/test/` routes.
- The Builder still intentionally contains a real-sitekey placeholder and 16 Media Library URL references for 15 files.
- The D1 migration phase is treated as complete. No migration is a WordPress “next action.” If additional confidence is needed, use read-only remote migration/schema inspection only.
- No production D1 write, Cloudflare Access change, secret rotation, n8n submission, or WordPress production edit is part of this package-fix phase.

## 2. Architecture recommendation

### Decision: keep the existing Pages project

**Yes — keep `care-plan-builder.pages.dev` and expose only the two exact customer-facing resources required by WordPress.**

Desired public resources:

1. `https://care-plan-builder.pages.dev/catalog.json`
2. `https://care-plan-builder.pages.dev/api/care-plan-request`

Everything else remains Access-protected, including `/`, `/pricing/`, `/api/pricing`, `/api/pricing-admin/*`, `/api/submissions/*`, `/api/test/*`, the staff practice Builder, and the Cloudflare-hosted marketing/plan pages.

Why this is appropriate:

- `/catalog.json` is static build output, excluded from Pages Functions by `public/_routes.json`, with JSON/CORS/cache headers in `public/_headers`.
- The live intake wrapper server-forces live classification; the browser cannot opt into test/staff mode.
- Intake independently enforces exact-origin CORS, validation, Turnstile verification, D1-backed rate limiting, authoritative D1 repricing, and server-side persistence.
- Cloudflare Access supports more-specific application paths taking precedence over a broader root application. A narrowly scoped Bypass application can therefore make one endpoint public without removing Access from the rest of the hostname.
- A Bypass policy removes Access enforcement and Access logging on the matching resource, so the path scope must remain exact. Do not expose `/api/*` or the whole hostname.

### Proposed Cloudflare Access configuration — do not broaden it

Do this only when ready to enable logged-out integration testing:

1. Keep the existing broad self-hosted Access application protecting `care-plan-builder.pages.dev` for staff.
2. Create a separate, more-specific self-hosted Access application for `care-plan-builder.pages.dev/catalog.json`.
3. Give that application one policy: **Bypass → Include Everyone**.
4. Create another separate, more-specific self-hosted Access application for `care-plan-builder.pages.dev/api/care-plan-request`.
5. Give that application one policy: **Bypass → Include Everyone**.
6. Do **not** create `care-plan-builder.pages.dev/api/*`, `care-plan-builder.pages.dev/*`, or a hostname-wide Bypass.
7. In a logged-out/private browser verify:
   - `/catalog.json` is reachable without Access and returns the catalog.
   - `OPTIONS`/`POST` reaches the intake Function rather than an Access login page.
   - `/`, `/pricing/`, `/api/pricing`, `/api/submissions`, and `/api/test/care-plan-request` still require Access.

## 3. Catalog generation on the existing project

The repository side is ready for static catalog generation, but the Cloudflare dashboard build settings must be confirmed rather than assumed.

Required production build configuration:

- Build command: `node scripts/build-catalog.mjs`
- Output directory: `public`
- Build environment values: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`
- `DB` D1 binding remains the existing `care-plan-builder` database.
- `public/_routes.json` must continue excluding `/catalog.json` from Functions.
- `public/_headers` must continue serving `/catalog.json` as JSON with `Access-Control-Allow-Origin: *`.
- `PUBLIC_CATALOG_URL` for the staff Pricing Editor/publication polling should resolve to `https://care-plan-builder.pages.dev/catalog.json` once the public-path architecture is enabled.
- If automatic publication after Pricing Editor changes is used, confirm the deploy hook(s) and `CATALOG_DEPLOY_HOOK_URLS` secret are configured on the staff project.

The repository does not prove that these dashboard-only settings currently exist. Confirm them in Cloudflare before calling catalog integration ready.

## 4. Turnstile, n8n, and intake launch configuration

Before full Builder integration testing:

- Create/use the real Cloudflare Turnstile widget in Managed mode.
- Add `youknowsuncity.com` and `www.youknowsuncity.com` as widget hostnames as appropriate for the actual canonical/redirect behavior.
- Put the real sitekey into `07-careplan-builder.html` in place of `{{TURNSTILE_SITEKEY}}`.
- Put the matching encrypted `TURNSTILE_SECRET` on the existing Pages project.
- Confirm encrypted `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`, and `IP_HASH_SALT` exist on the correct Pages environment.
- Import/configure the n8n workflow and Outlook credential. Use a test webhook or disable/redirect the Outlook-send step for the first controlled end-to-end test so the office is not emailed accidentally.
- Keep `ALLOWED_ORIGINS` exact. The live WordPress origins are `https://youknowsuncity.com` and/or `https://www.youknowsuncity.com`; remove obsolete preview/staff origins from the eventual production intake allowlist unless they are deliberately required.

Do not put any secret value into WordPress, this plan, or the Git repository.

## 5. D1 migrations

**Status: already completed / verified prerequisite.**

Do not apply 0008 or 0009 because an older transfer plan lists them as Phase 0 work. Do not rewrite already-applied migrations.

Optional read-only confidence check:

```bash
npx wrangler d1 migrations list care-plan-builder --remote
```

If that unexpectedly reports required migrations pending, stop and reconcile the contradiction before doing anything. No remote D1 write is part of WordPress staging.

## 6. Page readiness

| Page | Paste Ready | Integration Ready | Public Launch Ready | Remaining work |
|---|---|---|---|---|
| Member Rewards | **YES** | **YES** | **NO** | Owner naming choice and Rewards/giveaway copy signoff before public launch. |
| Memberships | **YES** | **YES** | **NO** | Replace/approve two photo placeholders; resolve navigation relationship with existing maintenance-plan page. |
| HVAC Care Plan | **YES** | **NO** | **NO** | Public catalog path must be tested; replace photos; resolve `Read Reviews`; decide equipment add-on naming. |
| Plumbing Care Plan | **YES** | **NO** | **NO** | Same: catalog, photos, reviews, add-on naming. |
| Bundled Care Plan | **YES** | **NO** | **NO** | Same: catalog, photos, reviews, add-on naming. |
| Premier Care Plan | **YES** | **NO** | **NO** | Same: catalog, photos, reviews, add-on naming; confirm displayed Premier benefit terminology. |
| Care Plan Builder | **YES — visual staging** | **NO** | **NO** | Media URLs, real Turnstile, public catalog/intake exceptions, n8n/runtime secrets, then controlled end-to-end test. |

“Paste Ready” means safe to place in a private LiveCanvas staging page. “Integration Ready” means required dynamic assets/endpoints are actually available for testing. “Public Launch Ready” means a logged-out customer can use everything the page promises.

Do not hold the first six pages hostage to Builder backend work. They can be staged privately now.

## 7. WordPress staging order

### Existing WordPress pages

For HVAC, Plumbing, and Member Rewards:

1. Preserve the live page, URL, ID, revisions, and current SEO.
2. Create a private/draft staging copy or a temporary staging page.
3. Set it noindex while staging.
4. Add exactly one LiveCanvas HTML block.
5. Open the **CODE** editor and paste the matching transfer file.
6. Leave “Insert Script to head” empty.
7. Save, reopen the code editor, and confirm the block/scripts survived.
8. Test responsive layout, links, headings, and console/network behavior before cutover.

### New pages

For Memberships, Bundled, Premier, and Builder:

1. Create Draft/Private pages.
2. Use the final desired slug when it will not collide with a live page; otherwise use a temporary staging slug until cutover.
3. Set noindex while staging.
4. Use one LiveCanvas HTML block, CODE editor only.
5. Build all linked destinations before publishing any cross-linked page.

### Recommended staging sequence

1. Member Rewards
2. Memberships
3. HVAC Care Plan
4. Plumbing Care Plan
5. Bundled Care Plan
6. Premier Care Plan
7. Builder shell/visual layout
8. Builder media replacement
9. Cloudflare public-path + catalog integration
10. Turnstile/n8n integration
11. One controlled fake end-to-end request
12. Public cutover only after owner decisions and final QA

## 8. LiveCanvas verification checklist

After each paste:

- No theme/site-wide restyling.
- One intended H1 after accounting for what the WordPress template itself renders.
- Mobile and desktop layout are intact.
- Internal cross-links target real staging/live destinations as intended.
- 03–06 still contain two inline scripts after save.
- Builder retains the Turnstile loader and main inline script after save.
- Browser console has no page-blocking JS error.
- Static pages require no backend.
- Plan pages remain readable if catalog hydration fails.
- Builder should not be considered integrated until catalog/Turnstile/intake are available.

## 9. Media requirements

Builder: 15 files / 16 references.

Upload/use:

- `hvac.JPG`
- `general-plumbing.JPG`
- `bundled.JPG`
- `premier.JPG`
- `background.png`
- `addon-hvaccount.jpg`
- `addon-filterchange.jpg`
- `addon-minisplit.jpg`
- `addon-waterheatercount.jpg`
- `addon-softenerservice.jpg`
- `addon-softenersalt.jpg`
- `addon-reverseosmosis.jpg`
- `addon-tanklessflush.jpg`
- `addon-bigbluefilter.jpg`
- `question-mark-icon.png` (referenced twice)

Do not upload `hvac1.JPG` or `scph-transparent-logo.png` for the Builder. Resize the oversized plan/hero photos and the oversized question-mark icon before upload. Fill placeholders only with the actual File URLs WordPress creates.

The Memberships and four plan-detail pages also contain visible photo placeholders. Those are separate owner/content replacements and should not be invented automatically.

## 10. Owner decisions

These are deliberately not silently chosen by the transfer work:

1. Rewards public name: **Member Rewards**, **Loyalty Rewards**, or **Sun City Rewards**.
2. Builder/customer-facing phone: current Builder `575-526-9758` vs the alternate website number `575-777-9758`.
3. Plan-page equipment add-on labels:
   - `Additional HVAC System` vs `# of HVAC Systems`
   - `Additional Water Heater` vs `# of Water Heaters`
4. `Read Reviews`: supply the real destination or remove the button.
5. Choose/approve replacement photos for the Memberships and care-plan detail placeholders.
6. Decide how `/memberships/` relates to the existing `/services/maintenance-plan` page: replacement, redirect, navigation coexistence, or another plan.
7. Decide whether `/member-sign-up/` should be kept, redirected, or removed if it exists/still receives traffic.

These do not block private staging. Reviews/placeholder photos/navigation and customer-facing naming do block a polished public launch.

## 11. Safe testing

From a complete checkout of this branch:

```bash
python3 wp-transfer/build-paste-files.py --check
npm ci
npm run test:unit
npm run test:api
```

Known pre-existing unit drift: `tests/test-submissions.test.mjs` expects the dashboard label `Live`; the intended UI says `Real`. If that remains the sole failure, report it as stale test text rather than changing application behavior.

Do not use six real production submissions to manually prove the 429 path; automated tests cover rate limiting. For eventual WordPress end-to-end QA, use the minimum number of clearly fake `ZZTEST` requests, make n8n/Outlook safe first, and document/delete test rows as appropriate.

Do not create CI loops, add unbounded workflows, or run dev/watch servers in GitHub Actions.

## 12. Files to use

- `wp-transfer/01-member-rewards-program.html` — **USE / PASTE READY**
- `wp-transfer/02-memberships.html` — **USE / PASTE READY**
- `wp-transfer/03-hvac-care-plan.html` — **USE / PASTE READY**
- `wp-transfer/04-plumbing-care-plan.html` — **USE / PASTE READY**
- `wp-transfer/05-bundled-care-plan.html` — **USE / PASTE READY**
- `wp-transfer/06-premier-care-plan.html` — **USE / PASTE READY**
- `wp-transfer/07-careplan-builder.html` — **USE FOR PRIVATE VISUAL STAGING; FILL TURNSTILE + MEDIA PLACEHOLDERS BEFORE INTEGRATION/PUBLIC LAUNCH**

No file in the finished package should say `BLOCKED - DO NOT PASTE`.

## 13. Audit snapshot

| Area | Verdict | Evidence / status |
|---|---|---|
| Current main SHA | **PASS** | `8eefb9f280700c93636b11f50bb096b3920090f8` remains the release base. |
| Transfer parity | **PASS** | 02–07 structure/production substitutions independently inspected against package/repo expectations. |
| Member Rewards | **FIXED** | Scoped rebuild on `docs/wp-transfer-staging`; exact visible text parity; 48/48 selectors under `.scp-rw`; no duplicate page landmarks/scripts. |
| CSS isolation | **PASS** | 01 `.scp-rw`; 02 `.scp-mem`; plan pages `.scp-care`; Builder remains its existing `#sc-cpb`-rooted implementation. |
| JS integrity | **PASS structural** | 03–06 each two balanced script blocks; Builder balanced Turnstile loader + main script; no executable staff/test endpoint leakage in WP package. |
| Catalog architecture | **PASS design / CONFIG PENDING** | Existing project can serve static `/catalog.json`; Cloudflare build variables/settings and logged-out reachability still must be confirmed. |
| Access architecture | **PASS design / CONFIG PENDING** | Exact path exceptions are technically supported; no Access change made yet. |
| Migration status | **OWNER-COMPLETE / NOT REAPPLIED** | Transfer plan no longer treats 0008/0009 as next actions. Optional read-only check remains available. |
| Turnstile | **PENDING** | Real widget/sitekey/secret and live hostname verification still required. |
| n8n | **PENDING** | Runtime URL/secret + workflow/Outlook activation and safe test still required. |
| Media | **PENDING** | 15 Builder files require Media Library URLs; detail-page photo placeholders also remain. |
| Unit tests | **NOT RE-RUN IN THIS PACKAGE ENVIRONMENT** | Known stale `Live` vs `Real` assertion remains documented. |
| API tests | **NOT RE-RUN IN THIS PACKAGE ENVIRONMENT** | Must be run from a complete repo checkout/Codespace; no production endpoint was exercised here. |
