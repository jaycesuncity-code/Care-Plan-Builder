# Catalog-export Worker rollout — current source of truth (2026-10-08)

This runbook supersedes conflicting static-catalog credential, split-project
and deployment steps in older `SETUP.md`, `README.md`,
`STATIC-CATALOG-REPORT.md`, `LAUNCH-CHECKLIST.md`, and the
`docs/wp-transfer-staging` branch's `WP-TRANSFER-PLAN.md`.
Do not follow historical instructions to create an account-wide D1 Read token,
create another Pages project, or rerun completed D1 migrations.

## Owner decisions

- Keep the existing Git-connected `care-plan-builder` Pages project at
  `https://care-plan-builder.pages.dev` with Cloudflare Access enabled by default.
- Expose exactly two customer-facing paths via narrow Access Bypass applications:
  `/catalog.json` (static JSON) and `/api/care-plan-request` (live intake).
- All other routes, including `/`, `/pricing/`, `/api/pricing`,
  `/api/pricing-admin/*`, `/api/submissions/*`, `/api/test/*`, and
  `/careplan-builder/`, remain staff-only.
- Do not change WordPress, n8n, Turnstile, D1 schema, or the permanent staff
  practice Builder as part of this Worker implementation.
- This PR is repository-only: no Worker, Cloudflare environment variable,
  Deploy Hook, Access setting, remote D1 command, or main merge is performed.

## Why the replacement is needed

A Cloudflare D1 Read API token is account-scoped rather than restricted to one
database. The former `scripts/build-catalog.mjs` used
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and
`D1_DATABASE_ID` against the D1 REST query endpoint. This replacement removes
that requirement. The build calls a dedicated authenticated `catalog-export`
Worker over HTTPS. Only that Worker binds to the existing `care-plan-builder`
D1 database (`2c79b253-9f8d-4441-b2ca-6666ac23196a`), executes the two
shared fixed `CATALOG_QUERIES` SELECTs in one D1 batch, and returns raw
`{meta,items}`. `catalogFromRows` continues to validate and shape the public
catalog. D1 bindings are intrinsically write-capable; the read-only guarantee
is the Worker code surface, not a database permission. Do not add write routes,
request-controlled SQL, or other bindings.

## Repository verification (before any Cloudflare action)

1. Review `catalog-export-worker/index.js`, its `wrangler.toml`,
   `scripts/build-catalog.mjs`, `tests/catalog-export-worker.test.mjs`
   and `package.json` against the actual PR diff.
2. From a local clone with Node 22.13+ run `npm ci`,
   `node --test tests/catalog-export-worker.test.mjs`,
   `npm run test:unit`, and a bounded integration test where available.
   Check existing failures against clean main. Never rerun hosted CI blindly.
3. Run `cd catalog-export-worker && npx wrangler deploy --dry-run
   --outdir /tmp/catalog-export-dryrun` locally (no Cloudflare upload).
   Confirm the cross-folder `../lib/intake/pricing.js` import bundles.
4. Verify fixture-mode catalog generation and remove generated
   `public/catalog.json` if it did not preexist. Do not commit it.
5. Inspect for secrets/generated files and confirm no Actions workflow was
   created. This branch must remain unmerged until the owner separately approves.
6. Inspect **Pages Settings -> Builds -> Branch control** before allowing
   feature-branch builds. A missing export URL/token intentionally fails closed.
   This implementation commit uses `[CF-Pages-Skip]` as a safeguard, but
   do not rely on it alone for later pushes, PR builds, or the eventual merge.

## Cloudflare owner operations — Preview first, then Production

Do these steps only after deliberately approving Cloudflare work:

1. Verify the actual D1 database name and ID in the dashboard. Stop if they
   disagree with the sole D1 binding in `catalog-export-worker/wrangler.toml`.
2. From the reviewed feature checkout, `cd catalog-export-worker` and
   `npx wrangler deploy`. This deploys the standalone Worker, not Pages.
   `workers_dev = true` enables its `workers.dev` URL;
   `preview_urls = false` prevents additional Worker preview hostnames.
3. Generate a fresh random bearer token of at least 32 random bytes, store
   it in a password manager, and run `npx wrangler secret put
   CATALOG_EXPORT_TOKEN` from the Worker directory. **Secret put creates
   a new Worker deployment**. Do not paste secret values in GitHub, docs,
   chats, URLs, or terminal logs.
4. Record the actual HTTPS Worker URL, typically
   `https://catalog-export.<your-worker-subdomain>.workers.dev/`.
   Verify that unauthenticated GET returns 401 with `no-store`. For the
   authenticated check, use a safe local script or client with the secret
   kept out of command history and logs. Expected 200 body is exactly
   `{meta,items}`; no unrelated D1 contents.
5. In the **existing Pages project**, set build-process **Preview** values:
   `CATALOG_EXPORT_URL` = verified HTTPS Worker URL (ordinary setting);
   `CATALOG_EXPORT_TOKEN` = same token (encrypted/secret).
   If your dashboard treats build/runtime values separately, confirm these
   actually reach `process.env` during the Node build; do not assume
   Pages runtime `wrangler.toml [vars]` supplies build variables.
   `NODE_VERSION` is optional when the current v3 image provides Node 22.
6. Confirm build command `node scripts/build-catalog.mjs` and output
   directory `public`. Trigger one controlled feature-branch Preview build
   when ready; verify correct catalog version, required plans/add-ons,
   headers, and that build logs contain no secrets.
7. Test missing/wrong credentials on a deliberately controlled Preview
   build if practical, expect a generic failed build and no new publication,
   then restore Preview settings. Do not provoke a Production failure.
8. Configure **Production** `CATALOG_EXPORT_URL` and encrypted
   `CATALOG_EXPORT_TOKEN` before allowing a merge to main, because the
   merge can trigger Production Pages build automatically.
9. After explicit separate owner approval to merge, inspect the resulting
   Production build. Check the logged-out static URL
   `https://care-plan-builder.pages.dev/catalog.json` and ensure all
   staff-only paths remain protected behind Cloudflare Access.
10. Confirm the existing Pages Deploy Hook and staff
    `CATALOG_DEPLOY_HOOK_URLS` and `PUBLIC_CATALOG_URL` (currently
    empty on main) point to this **same project and public catalog URL**,
    rather than the obsolete second-project host. Only then test a
    controlled Pricing Editor -> D1 -> Deploy Hook -> Pages build ->
    catalog version polling cycle. No second public Pages project or hook.

## Rollback / failures

- Worker unavailable or token wrong: pause new catalog publishing, retain
  last successful Pages deployment, repair the Worker or corresponding
  secret, then run one controlled build. The build cannot fall back to
  embedded seed pricing.
- Incorrect Pages build variable: restore the known correct secret/URL
  in the affected environment; verify a controlled Preview rebuild
  before attempting Production.
- Wrong Worker deployment: restore/redeploy known reviewed Worker code
  with its fixed SELECTs and single verified D1 binding; do not remove
  the Worker while current builds rely on it.
- Failed Production build: investigate logs without printing tokens.
  Do not repeatedly trigger a Deploy Hook or hosted CI jobs.
- Reverting this PR alone restores the old D1 REST-based build that
  requires an account-wide D1 Read token, so **revert alone is not a
  functional rollback without reintroducing the risk**. Prefer repairing
  the Worker while serving the previous successful Pages deployment.
- If Cloudflare Pages automatic branch builds would start before you
  configure the Worker, disable that branch's automatic deployment or
  defer deployment until ready. A feature-branch push might create a
  failed Preview build; it does not grant access to D1.

## WordPress transfer — no paste changes

The four detail-page `CATALOG_URL` constants remain
`https://care-plan-builder.pages.dev/catalog.json`. The WordPress
Builder's `CATALOG_ENDPOINT` is the same static URL; `SUBMIT_ENDPOINT`
remains `https://care-plan-builder.pages.dev/api/care-plan-request`.
The Worker is never called from a customer browser. The real Turnstile
sitekey, Media Library files, LiveCanvas code editor process, and page
staging order are unchanged. **Do not regenerate or restage prepared
WordPress files solely for the export Worker.**

The currently prepared WordPress documents are still on
`docs/wp-transfer-staging`, not main. Before launch, reconcile their
stale references to the old three D1 REST build variables with this
runbook, without silently merging all unrelated staging changes.

## Official Cloudflare references

- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/pages/configuration/build-configuration/
- https://developers.cloudflare.com/pages/configuration/branch-build-controls/
- https://developers.cloudflare.com/pages/configuration/deploy-hooks/
