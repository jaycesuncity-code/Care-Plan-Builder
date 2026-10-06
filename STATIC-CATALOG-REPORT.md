# Static catalog implementation report

All catalog changes are implemented, including approved
[`migrations/0009_submission_plan_names.sql`](migrations/0009_submission_plan_names.sql).
On October 6, 2026 the user explicitly authorized including this migration and pushing
the completed work to `main`, superseding the original no-rebuild/no-main constraints.
The migration preserves historical submissions and child records while allowing full
plan-name edits. Until it is applied, the editor keeps full-name inputs read-only and the
API rejects unsupported renames before writing anything. No remote database was changed.

## Starting point and commits

- Starting branch: `main`, clean checkout.
- Starting commit: `43b4961353142d3190075395068717dd97c4b13a` — Text changes to care plan builer.
- Working branch: `feature/static-catalog`.
- Release target: `main`, explicitly authorized by the user after initial local review.
- The earlier push was rejected for missing publishing authorization; the user has now
  explicitly supplied it. No alternate publishing route was attempted.

| Commit | Purpose |
|---|---|
| 8c99f17 | Repair stale baseline tests for the removed retry button and historical walkthrough comments. |
| e9394dc | Add shared validated catalog loading, additive text migration, static build, audited editor fields and awaited hooks. |
| 9fe4dac | Hydrate Builder/marketing pages, update dashboard plan filters and show manager publication status. |
| 13c855d | Test catalog text, real SQL concurrency/audits, hook outcomes, hydration, renames and proposed migration preservation. |
| bf9baef | Add this report and the exact configuration, migration and launch instructions. |

The final follow-up commit promotes 0009 into the migration chain, updates deployment
instructions and tests renamed-plan intake against the normal migrations.
To print all exact commit SHAs after checkout:

```bash
git log --reverse --format='%h %s' 43b4961..feature/static-catalog
```

## Verification

| Suite | Baseline | Final |
|---|---:|---:|
| npm run test:unit | 116 passed, 0 failed | 202 passed, 0 failed |
| npm run test:api | 171 passed, 0 failed | 191 passed, 0 failed |

The unit suite exercises both the pre-0009 safety guard and the approved schema. The API
suite uses Wrangler, actual local D1, local Turnstile/n8n mocks and the normal migration
chain through 0009. It checks that a full-name rename is audited, appears in the catalog,
and is stored in `submissions.plan` and included in the n8n payload.

Verified behavior includes:

- Current Builder text is backfilled character for character, including the qbb rename
  already carried by 0007; prices and coverage rules are unchanged.
- Live `/api/pricing` and fixture-generated `/catalog.json` produce identical JSON bytes
  for the same rows, regardless of row order. Required catalog text/price gaps fail closed.
- All field limits, markup and C0/C1/invisible/line-control rejection, before trimming.
- Text-only saves bump the version once, with real SQL audit rows per field. Price audits
  preserve both old/new numeric and text values. Guarded conflict/race writes remain atomic.
- Hook success/failure/timeout is awaited after the save; hooks are not called on validation,
  database failure or conflict. URLs never enter API responses or errors. Failed hooks do
  not roll back the save.
- Editor reviews each field, retains proposals after conflicts, displays per-field validation,
  maintains large-price confirmation, updates counters, escapes audit values and polls
  the static version with no-store until live or timed out.
- Builder applies text atomically, escapes quotes in accessible-name attributes, preserves
  selected quantities after 409, and disables requests when required text is invalid.
- Each plan page updates marked names/prices/identical descriptions while preserving its
  price formatting. Network, HTTP, JSON, missing fields, invalid controls/prices and
  request/body timeouts leave the page HTML byte-identical. Premier conditional salt
  stays included; it is not hydrated as a paid price.
- Dashboard plan filters derive sorted distinct historical/current names through textContent.
- Approved 0009 preserves complete historical rows and children, all current flags and
  indexes, remaining CHECK constraints and a deleted-ID AUTOINCREMENT high-water mark.
- `git diff --check` is clean. No GitHub Actions workflow was created or changed.

The sandbox denies network-interface enumeration that Wrangler performs at startup.
The API suite was run with a temporary local Node preload that supplies explicit loopback
interface information. This workaround is not in the repository and changes no product
code. Normal local environments should run the ordinary npm commands. Initial environment
failures and one corrected API test assertion were resolved; only the final counts above
represent the finished verification. No remote services were used by these tests.

## Files changed or added

| File | Reason |
|---|---|
| .dev.vars.example | Add blank hook/public URL placeholders and explain build-only D1 variables. |
| .gitignore | Ignore generated catalog and its atomic-write temporary file. |
| LAUNCH-CHECKLIST.md | Add public catalog endpoints, split exclusions and setup/schema prerequisites. |
| README.md | Explain editor-managed text, static publishing, live staff/intake reads and the migration prerequisites. |
| SCHEMA.md | Document 0008 fields/audit shape and the approved plan-name constraint migration. |
| SETUP.md | Provide click-by-click token, build-variable, hook, migration, split and WordPress instructions. |
| STATIC-CATALOG-REPORT.md | Record delivery, evidence, changed files, judgment calls and the approved follow-up. |
| builder-walkthrough.md | Keep affected existing replacement blocks aligned with the Builder; add no new paste steps. |
| functions/api/pricing-admin.js | Validate editable fields, audit each change, preserve concurrency/auth/CSRF, await hooks and guard unsupported plan renames. |
| functions/api/pricing.js | Serve the shared full catalog live with no-store instead of the old five-minute cache. |
| lib/intake/catalog.js | Validate plain catalog text and use D1 names in priced/stored/email lines, preserving rules/suffixes. |
| lib/intake/pricing.js | Share canonical row shaping and loadCatalog; retain loadPricing as the live intake loader. |
| migrations/0008_catalog_text.sql | Add/backfill text and audit columns without touching submission tables or historical rows. |
| package.json | Add build/test scripts and type: module so Node 18 can import the zero-dependency build's .js modules. |
| migrations/0009_submission_plan_names.sql | Preserve historical submissions and children while allowing manager-edited full plan names. |
| public/_headers | Add public static catalog CORS/cache/content-type/nosniff headers; retain noindex. |
| public/_routes.json | Exclude /catalog.json from the catch-all Function so catalog reads remain static. |
| public/bundled-care-plan/index.html | Mark catalog elements and add scoped fail-soft static hydration. |
| public/careplan-builder/index.html | Apply validated text with prices, rename CATALOG_ENDPOINT and escape attribute quotes. |
| public/hvac-care-plan/index.html | Mark catalog elements and add scoped fail-soft static hydration. |
| public/index.html | Derive plan filter options from loaded submission names. |
| public/plumbing-care-plan/index.html | Mark catalog elements and add scoped fail-soft static hydration. |
| public/premier-care-plan/index.html | Hydrate catalog elements while retaining conditional included-salt messaging. |
| public/pricing/index.html | Add text inputs/counters, field review/errors, publishing status/polling and schema-aware full-name protection. |
| scripts/build-catalog.mjs | Generate minified catalog from read-only D1 REST or a fixture; fail safely and write atomically. |
| scripts/catalog-seed.mjs | Extract literal Builder seed text for generated migration/test tooling without executing page scripts. |
| scripts/generate-pricing-seed.mjs | Add --catalog-text generation mode while leaving the applied 0006 migration untouched. |
| tests/builder-pricing-state.test.mjs | Remove obsolete retry-button dependency and verify 409 preserves selections/quantities. |
| tests/builder-pricing.test.mjs | Include required catalog text in Builder pricing fixtures. |
| tests/catalog-editor.test.mjs | Exercise actual editor DOM, review, errors, conflicts, statuses, polling and schema protection. |
| tests/catalog-hydration.test.mjs | Exercise Builder text escaping/failure, four plan-page hydration paths and derived dashboard choices. |
| tests/catalog-parity.test.mjs | Compare 0008 backfill to Builder text and verify additive child preservation. |
| tests/catalog-text.test.mjs | Test limits, shape/bytes, build failures, D1 names, static routing and approved migration preservation. |
| tests/intake-pricing-unavailable.test.mjs | Supply real text rows so failure tests still isolate authoritative pricing problems. |
| tests/pricing-admin.test.mjs | Use real SQLite SQL and cover text edits, audits, hooks/timeouts and current-schema protection. |
| tests/pricing-endpoint.test.mjs | Verify full catalog/live D1 reads rather than the retired cache behavior. |
| tests/pricing-fixture.mjs | Supply explicit test-only catalog text and D1 row fixtures from Builder seeds. |
| tests/run-integration.mjs | Add local D1 admin-field, live text, audit, concurrency, full-name rename and office-name checks. |
| tests/sqlite-d1.mjs | Provide an in-memory real-SQL adapter and version-selectable migration fixture for unit tests. |
| tests/walkthrough.test.mjs | Align launch-constant and complete-payload checks with the new catalog endpoint/text. |
| wrangler.toml | Add the publicCatalogUrl polling var with an empty pre-split default. |

## Exact setup and release instructions

Follow [`SETUP.md`, section 9](SETUP.md#9-static-catalog-publishing--dashboard-and-future-public-project).
It contains every dashboard click and command, in this order:

1. Inspect pending migrations/schema, export D1, verify the backup, apply approved additive
   0008 and approved 0009, then compare historical/child values and verify populated catalog fields.
2. Profile → API Tokens → Create Token → Custom token → Account / D1 / Read → the specific
   account → Continue to summary → Create Token. No write/Edit grant is needed.
3. On every catalog-serving Pages project/environment, set CLOUDFLARE_API_TOKEN,
   CLOUDFLARE_ACCOUNT_ID and D1_DATABASE_ID as build-process values; keep the token encrypted.
   Set the build command to `node scripts/build-catalog.mjs`, output `public`.
4. Pages project → Settings → Builds → Add deploy hook; select the correct branch and retain
   its URL privately. Repeat for both projects after the split.
5. Put comma-separated hook URLs only in the gated project's encrypted
   CATALOG_DEPLOY_HOOK_URLS secret. Keep preview hooks separate from production.
6. Set the gated runtime PUBLIC_CATALOG_URL in wrangler.toml to the public absolute
   catalog URL after the split. Keep it empty beforehand if no public catalog host exists.
7. Fresh WordPress Builder: CATALOG_ENDPOINT → public /catalog.json, SUBMIT_ENDPOINT → live
   /api/care-plan-request, real Turnstile sitekey. Each of four plan-page CATALOG_URL constants
   → the same static URL. Staff endpoints remain live /api/pricing and test intake.
8. Verify a save's version/audit, hook build source, public catalog version advance,
   cross-origin reads and actual submission/email behavior in the intended release environment.

Remote application of 0009 requires a verified backup and comparison with the actual
remote schema. Stop and adapt the migration if additional columns, indexes or triggers
exist. The user approved inclusion and pushing to main, not remote D1 migration execution.

## Limits and judgment calls

- Added /catalog.json to `_routes.json` even though the handoff mentioned only headers:
  the existing catch-all Function made this necessary for the static-request goal.
- Removed the staff feed's cache to implement the requested live staff behavior. Public
  marketing/Builder traffic uses the generated static feed after endpoint configuration.
- Canonical row ordering ensures byte equality even when fixture rows arrive unsorted.
- Declared ES modules so the generator works on Node 18, not only newer Node versions that
  auto-detect ES-module syntax. Local tests use node:sqlite and require Node 22.13+.
- Rejected invisible format controls and Unicode line/paragraph separators in addition to
  C0/C1 controls; those strings are intended for inline plain-text rendering.
- Historical audit rows retain NULL new text-value columns and render through their existing
  numeric values. Historical submissions are not rewritten by 0008 or by renames.
- Existing 409 semantics are unchanged: a text-only version change with an identical total
  is accepted using current D1 names. This does not guarantee that a customer viewing an
  older static text version saw the current name; changing that rule is a separate decision.
- Long marketing paragraphs remain hand-authored. Only identical Builder description text
  is marked for replacement; catalog editing is not a full marketing-copy CMS.
- No remote migration, real hook, production intake/API request, live token verification,
  real n8n/Outlook delivery, Cloudflare account configuration or WordPress paste was done.
- Deploy build timing is not measured on the actual account. “About 2 minutes” is the requested
  UI estimate; static-version polling determines whether publication actually completed.
- No repo split or direct production deployment command was performed. Pushing main may
  trigger the existing hosting deployment integration.
