# SETUP — Care Plan intake, sandbox to launch

Click-by-click for the sandbox, then the launch move. Written against the
`care-plan-builder` Pages project and the `care-plan-builder` D1 database
(`2c79b253-9f8d-4441-b2ca-6666ac23196a`).

Part 1–7 get the sandbox working end to end. Part 8 is the launch move.

---

## Read this first: where configuration lives

This repo has a `wrangler.toml` **and** the Pages project is Git-connected. Per the
current Cloudflare docs that makes the file the source of truth, and it has a
consequence that will waste an afternoon if you don't know it:

> **Plaintext environment variables added in the Cloudflare dashboard are ignored.**
> The dashboard says so itself: *"Environment variables for this project's production
> environment are being managed through wrangler.toml. Only Secrets (encrypted
> variables) can be added or removed through the Dashboard."*

So:

| Kind | Where it goes | Why |
|---|---|---|
| `DASHBOARD_URL`, `ALLOWED_ORIGINS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SECONDS` | **`wrangler.toml` → `[vars]`** (already committed) | plaintext; dashboard values wouldn't load |
| `TURNSTILE_SECRET`, `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`, `IP_HASH_SALT` | **Dashboard → Secrets (encrypted)** | intake secrets; copy these four to the public intake project at launch |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | **Gated dashboard → Secrets (encrypted)** | required pricing-admin JWT verification; never copy these to the public intake project |
| `PRICING_EDITORS` *(optional)* | **Gated dashboard → Secret (encrypted)** | named editor exceptions outside `@suncitylc.com`; never copy this to the public intake project |
| everything, for local dev | **`.dev.vars`** (gitignored) | `wrangler pages dev` reads it |

`N8N_WEBHOOK_URL` is technically not a secret, but it is an unauthenticated-looking
endpoint on a public repo, so it is treated as one.

One more trap: `vars` is a **non-inheritable** key. If you ever add an
`[env.preview.vars]` or `[env.production.vars]` block, you must restate *every*
variable inside it — an environment block replaces the top-level one rather than
merging. The committed `[vars]` values are deliberately correct for both
environments, so there is nothing to restate today.

---

## 1. Local sandbox

### Repo layout

```text
public/memberships/index.html        Memberships landing page — built by a separate branch (feature/memberships-landing-page)
public/careplan-builder/index.html   residential Care Plan Builder
public/{hvac,plumbing,bundled,premier}-care-plan/index.html
```

```bash
npm install
cp .dev.vars.example .dev.vars     # already points at the local mocks
npm run db:migrate:local           # applies all currently unapplied local migrations through 0009
```

Two terminals:

```bash
npm run mock:n8n                   # webhook + Turnstile siteverify mock, port 8799
npm run dev                        # dashboard + both APIs, port 8788
```

Then:

- dashboard → <http://localhost:8788/>
- the Builder → <http://localhost:8788/careplan-builder/>

Images: the Builder references `/img/*`, which lives in the WordPress media library,
not this repo. The pages work without them (broken image icons only). The e2e suite
generates throwaway 1×1 stand-ins and deletes them afterwards.

Run the tests:

```bash
npm run test:unit                  # pricing, validation, parity, n8n Code node, walkthrough
npm run test:api                   # starts wrangler pages dev itself, 4 config groups
npm run test:e2e                   # optional, needs: npm i -D playwright && npx playwright install chromium
```

`test:api` needs ports 8788 and 8799 free.

## 2. Apply the migrations to the real D1

`0003` is skipped on purpose — `0003_add_auth_audit_columns.sql` belongs to the
Cloudflare Access work. Nothing here depends on it, and the numbering gap is fine.

```bash
npx wrangler d1 migrations list care-plan-builder --remote   # read-only: see what's pending
# For the current 0008/0009 release, do not apply from this generic section.
# Follow the guarded backup/preflight/application procedure in section 9.1.
```

`0006_pricing.sql` is additive: it creates the three pricing tables and seeds them.
`0007_submission_is_test.sql` is also additive: it adds `submissions.is_test` with
`NOT NULL DEFAULT 0 CHECK (is_test IN (0,1))`; it does not rebuild `submissions`.
Unknown existing rows remain live. Only the four exact documented `0002` fixtures are
backfilled to test by matching id + name + phone. It also updates the already-seeded
`addon:qbb` label to the preview branch's current "Quarterly Sediment Filter Change".
Back up and inspect the real D1 before applying pending migrations.

**`0004` rebuilds the `submissions` table** (SQLite can't ALTER a CHECK constraint), so
read this before running it on real data:

- It copies `submission_addons` and `submission_notes` aside, rebuilds `submissions`,
  then restores them. This is necessary because `DROP TABLE` on a parent runs an
  implicit `DELETE FROM`, and that **does** fire `ON DELETE CASCADE` on the children —
  `PRAGMA defer_foreign_keys` defers constraint *checking*, it does not stop a cascade.
- Verified locally against the seed data: 4 submissions kept all 5 add-on rows and all
  4 notes, and the existing `Anytime` value still validates.
- If the remote database holds anything you care about, take a backup first:
  `npx wrangler d1 export care-plan-builder --remote --output backup-before-0004.sql`

Sanity check afterwards:

```bash
npx wrangler d1 execute care-plan-builder --remote --command \
  "SELECT COUNT(*) AS submissions, (SELECT COUNT(*) FROM submission_addons) AS addons, (SELECT COUNT(*) FROM submission_notes) AS notes, (SELECT COUNT(*) FROM intake_rate_limit) AS rate_rows FROM submissions"
```

## 3. Turnstile

**Now (sandbox).** Nothing to create. The Builder ships with Cloudflare's always-passes
test sitekey `1x00000000000000000000AA`, and the matching secret is
`1x0000000000000000000000000000000AA`. Set that secret in step 4.

The other documented test pairs, useful for deliberately breaking things:

| Sitekey | Secret | Behaviour |
|---|---|---|
| `1x00000000000000000000AA` | `1x0000000000000000000000000000000AA` | always passes (visible) |
| `2x00000000000000000000AB` | `2x0000000000000000000000000000000AA` | always fails |
| — | `3x0000000000000000000000000000000AA` | token already spent |

**At launch (real widget).**

1. Cloudflare dashboard → **Turnstile** → **Add widget**.
2. Name it `Care Plan Builder`.
3. Hostnames: add **`youknowsuncity.com`** *and* **`www.youknowsuncity.com`**. A widget
   only renders on hostnames listed here — this is the single most common cause of "the
   box shows an error on the live site". Add `care-plan-builder.pages.dev` too if you
   want the sandbox on the real key.
4. Widget mode: **Managed**.
5. Copy the **sitekey** into the Builder's `TURNSTILE_SITEKEY` constant (step 5 of
   `builder-walkthrough.md`, and the same one line in the LiveCanvas copy).
6. Copy the **secret key** into the `TURNSTILE_SECRET` secret on the Pages project.

## 4. Pages secrets and vars

Cloudflare dashboard → **Workers & Pages** → **care-plan-builder** → **Settings** →
**Variables and Secrets**.

For **each** of Production and Preview on the **gated dashboard project**, add the six required values below as **Secret** (encrypted). Add `PRICING_EDITORS` only if you intentionally need a named exception outside `@suncitylc.com`:

| Name | Sandbox value | Notes |
|---|---|---|
| `TURNSTILE_SECRET` | `1x0000000000000000000000000000000AA` | real secret key at launch |
| `N8N_WEBHOOK_URL` | `https://suncityautomation.app.n8n.cloud/webhook/care-plan-request` | see step 6 about test vs production URLs |
| `N8N_WEBHOOK_SECRET` | any long random string | must match the n8n Header Auth credential exactly |
| `IP_HASH_SALT` | any long random string | salts the stored IP hashes; rotating it just resets the rate-limit counters |
| `PRICING_EDITORS` | *(optional)* comma-separated emails | named editor exceptions outside `@suncitylc.com`; company-domain staff do not need to be listed |
| `ACCESS_TEAM_DOMAIN` | your Access team domain | used to verify the Access JWT issuer + fetch JWKS |
| `ACCESS_AUD` | pricing Access application AUD tag | **must be the pricing-specific app's AUD, not the dashboard app's tag** |

Generate the two random ones however you like, e.g.:

```bash
openssl rand -hex 32
```

Use **different** values for Preview and Production for `IP_HASH_SALT` and
`N8N_WEBHOOK_SECRET` if you want preview traffic fully separated. `TURNSTILE_SECRET` can
stay the test secret on Preview forever — that's convenient, since preview URLs aren't
on the widget's hostname list.

Do **not** add `DASHBOARD_URL` or `ALLOWED_ORIGINS` here; they are in `wrangler.toml`
and dashboard copies would be ignored (see the note at the top). Change them by editing
`wrangler.toml` and pushing.

Secrets take effect on the **next deployment** — redeploy after adding them.

### Configure the pricing-page passphrase speed bump

The passphrase is not the security boundary; Cloudflare Access and the server-side editor
authorization rule are. The page ships fail-closed with a hash placeholder. Choose an internal
passphrase, generate its SHA-256 hash locally, and paste **only the hash** into
`PASSPHRASE_SHA256` in `public/pricing/index.html`:

```bash
node scripts/hash-passphrase.mjs "your passphrase"
```

Never commit the passphrase itself. The salt and hash are visible in page source by design.

### Restrict the Pricing page to editors

Create a **second Cloudflare Access application** for the dashboard project. Keep the
existing dashboard Access application as-is, then add a pricing-specific application whose
paths cover both `/pricing*` and `/api/pricing-admin*`. Its Allow policy should include
company staff whose emails end in `@suncitylc.com`, plus any named outside-domain
exceptions you intentionally support. Copy that application's AUD tag into the
`ACCESS_AUD` secret above. A dashboard-app AUD in `ACCESS_AUD` will make every otherwise
valid pricing editor receive 401. After JWT verification, the server independently
requires an exact, case-insensitive `@suncitylc.com` email match or membership in the
optional `PRICING_EDITORS` exception list. Subdomains and lookalike domains do not match.

For local development only, `.dev.vars` may set `DEV_ADMIN_EMAIL`; that bypass is
accepted only on `localhost` or `127.0.0.1`. `ACCESS_JWKS_URL` is test-only and must
stay unset in production.

## 5. Deploy and verify the binding

Push the branch and let the Pages build run, or deploy by hand:

```bash
npm run deploy
```

Then confirm both intake wrappers are live and config arrived. Each empty POST should
return **400 with field errors** (not 404, not 500). The routes differ only in the
server-forced classification:

```bash
curl -i -X POST https://care-plan-builder.pages.dev/api/care-plan-request \
  -H 'Content-Type: application/json' -d '{}'

curl -i -X POST https://care-plan-builder.pages.dev/api/test/care-plan-request \
  -H 'Content-Type: application/json' -d '{}'
```

- `404` → the Function didn't deploy; check the build log's Functions section.
- `500 SERVER_ERROR` → the `DB` binding is missing.
- `400 VALIDATION_FAILED` → correct.

## 6. n8n: import, credentials, activate

1. n8n Cloud → <https://suncityautomation.app.n8n.cloud> → **Workflows** → **Import
   from File** → `n8n/care-plan-request-notification.json`.
2. It imports **inactive**, with three nodes and a sticky note holding the payload
   contract. It cannot send anything until you activate it.
3. **Header Auth credential** (on the Webhook node):
   - **Credentials** → **Add credential** → **Header Auth**
   - Name: `X-Webhook-Secret`
   - Value: the exact `N8N_WEBHOOK_SECRET` you set in step 4
   - Back on the Webhook node, select this credential. The imported placeholder id
     (`REPLACE_WITH_HEADER_AUTH_CREDENTIAL_ID`) will not resolve — you must pick it
     from the dropdown.
4. **Microsoft Outlook credential** (on the Send node):
   - **Add credential** → **Microsoft Outlook OAuth2 API**
   - Complete the Microsoft 365 consent flow with the account that should *send* the
     mail. Whatever mailbox you authenticate becomes the From address.
   - Select it on the `Send Office Email (Outlook)` node.
   - Check the node's parameter fields after import — the Microsoft Outlook node's
     field names have moved between n8n versions, so if `To`/`Subject`/`Body` look
     empty, re-select `Message → Send` and re-point them at
     `{{ $json.to }}`, `{{ $json.subject }}`, `{{ $json.html }}` with
     **Body Content Type = HTML**.
5. **Test vs production URL.** The Webhook node shows two URLs:
   - `…/webhook-test/care-plan-request` — only live while you have the editor open with
     **Listen for test event** armed. Good for the first end-to-end check.
   - `…/webhook/care-plan-request` — the real one, live only while the workflow is
     **Active**.

   To test first: temporarily set the `N8N_WEBHOOK_URL` secret to the `webhook-test`
   URL, redeploy, click **Listen for test event**, submit a lead, watch the execution.
   Then set the secret back to the `/webhook/` URL, **Activate** the workflow, and
   redeploy.
6. Toggle **Active** on.

If the office email never arrives, the Cloudflare Function log is the place to look —
it records `office notification failed for id=NNN` with a reason
(`webhook_timeout`, `webhook_http_error`, `webhook_unreachable`) and never fails the
customer's submission.

## 7. Smoke test (sandbox, end to end)

1. Open <https://care-plan-builder.pages.dev/careplan-builder/>.
2. Pick **Premier**, tick **Mini-Split Tune-Up**, raise **# of HVAC Systems** to 3.
   Sidebar total should read **$930/yr** (600 + 80 + 2 × 125).
3. Confirm that this canonical selection shows **no** Water Softener Salt line and
   **no** Reverse Osmosis Service line. Neither corresponding paid service was selected.
4. Click the CTA. The recap should show Premier, Mini-Split Tune-Up, and
   **# of HVAC Systems × 3** with total **$930**. It should not contain phantom
   water-treatment lines. The Turnstile box should appear and self-solve (test key).
5. Fill in a clearly fake name, a real-format phone, an address, pick **Midday**, tick
   the acknowledgement, send.
6. Expect the confirmation panel, and the form to disappear.
7. Check the dashboard at <https://care-plan-builder.pages.dev/> — the lead should be
   at the top of the queue. Open it: **Best time to call** = `Midday`, base $600,
   `Mini-Split Tune-Up` = $80, `# of HVAC Systems × 3` = $250, total **$930**,
   and no phantom salt/RO line.
8. This Cloudflare-hosted Builder is the permanent staff-practice Builder, so **no
   normal office email should be sent**. Confirm the row is visibly marked TEST in the
   dashboard. Use the live endpoint separately when validating normal notification
   delivery.
9. Verify the numbers in the database are the server's, not the browser's:

   ```bash
   npx wrangler d1 execute care-plan-builder --remote --command \
     "SELECT id, plan, best_time, base_price, addon_total, total_price FROM submissions ORDER BY id DESC LIMIT 3"
   ```

10. Run a focused Premier softener-pairing check:
    - select **Water Softener Service × 2**
    - the service line should be **$150**
    - **Water Softener Salt × 2** should appear automatically as **Included / $0**
    - increasing/decreasing the service quantity should change salt 1:1
    - removing Water Softener Service should remove the included salt line
    - **Reverse Osmosis Service** should remain a normal paid **$50 each** add-on; its
      replacement filters are the Premier perk, so no separate free RO line should appear.
11. Submit six leads in a row. The sixth should be refused with the wait-time message
    (default limit: 5 per 10 minutes per IP).
12. Keep practice rows as normal test records unless you intentionally want cleanup.
    They are identified by `is_test = 1`, not by submission id.

---

## 8. Launch architecture — one existing Pages project

**Current owner decision superseding older split notes:** Retain the Git-connected
`https://care-plan-builder.pages.dev` Pages project. Do not create a new public repository
or a `care-plan-intake` Pages project. Keep Cloudflare Access protecting the hostname
and allow only two exact public paths:

- `/catalog.json` — static JSON, excluded from Pages Functions via `public/_routes.json`;
- `/api/care-plan-request` — live customer request intake.

Use narrowly scoped Access applications and Bypass policies for these exact paths.
All staff pages/routes (especially `/`, `/pricing/`, `/api/pricing`,
`/api/pricing-admin/*`, `/api/submissions/*`, `/api/test/*`, and
`/careplan-builder/`) remain protected. Do not bypass all of `/api/*`.
The staff practice Builder continues to post only to the test intake route.

WordPress plan pages use
`https://care-plan-builder.pages.dev/catalog.json`. The WordPress Builder uses
the same static catalog and
`https://care-plan-builder.pages.dev/api/care-plan-request`.
No WordPress paste files, Turnstile settings, media references, or staging steps
change because catalog generation switches to the export Worker.
The prepared transfer plan resides on `docs/wp-transfer-staging`, not main.
Reconcile its older D1 REST build-variable instructions before release.

Do not rerun completed D1 migrations or imports for this Worker change.

## 9. Live/Test verification after 0007

The existing live wrapper server-forces `is_test = 0`, and the staff-only
practice wrapper server-forces `is_test = 1`. A browser cannot override
classification through request fields or query strings. Keep practice requests
behind Access and do not generate office notifications for practice submissions.

## 10. Static catalog publishing — dedicated export Worker

This is the current build design. The old account-wide D1 Read API-token
instructions are obsolete. The owner confirms required migrations are already
complete; no remote D1 write, migration or seed import is part of this change.

### 10.1 Worker (owner-only Cloudflare action)

1. Review the feature-branch PR and verify the actual Cloudflare D1 database ID
   for `care-plan-builder` matches the sole Worker D1 binding:
   `2c79b253-9f8d-4441-b2ca-6666ac23196a`. Stop on mismatch.
2. Only after approving a Cloudflare deployment, run:
   `cd catalog-export-worker && npx wrangler deploy`.
3. Generate a long random bearer token (at least 32 random bytes) and store it
   privately. From that Worker folder, run
   `npx wrangler secret put CATALOG_EXPORT_TOKEN` and enter it interactively.
   **Secret put deploys a Worker version.** Never put a secret in the repository,
   chat, command arguments, screenshots, or logs.
4. Record the actual `https://catalog-export.<subdomain>.workers.dev/` URL.
   Check that unauthenticated GET returns 401, and authenticated GET returns
   `{meta,items}` with `Cache-Control: no-store`. The code permits only fixed
   catalog SELECTs; the D1 binding itself has write capability.

The build does not need `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, or `D1_DATABASE_ID`.

### 10.2 Pages *build-time* environment (Preview before Production)

Keep the **existing** Pages project and build command
`node scripts/build-catalog.mjs`, with output directory `public`.
Set these as values available to the Node **build process**, not merely
Pages Functions runtime `[vars]`:

| Name | Source | Handling |
|---|---|---|
| `CATALOG_EXPORT_URL` | The verified HTTPS Worker URL | Ordinary build configuration |
| `CATALOG_EXPORT_TOKEN` | Same secret set on Worker | Encrypted/secret build value |
| `NODE_VERSION` | Optional Node 22 setting | Ordinary build configuration |

Root `wrangler.toml` controls runtime bindings/plaintext vars. That warning
is not proof that the separate Pages build settings are unavailable.
Confirm the actual Cloudflare dashboard controls and build environment.

Before pushing/triggering a branch deployment, check **Settings → Builds →
Branch control**. A feature-branch build with missing export credentials will
fail closed. The implementation's `[CF-Pages-Skip]` commit prefix is an
additional safety measure, not a substitute for branch-build controls.

Configure **Preview** values, allow one intentional Preview build and verify
generated `/catalog.json` version/content/CORS/cache behavior. In a
controlled Preview-only check, missing or wrong tokens must fail the build
without publishing incomplete prices. Restore values afterward.
Configure **Production** build values **before** merging the reviewed PR:
merging into main can immediately start a Production Pages build.

### 10.3 Publication, Access and rollback

After separate merge approval and a successful Production build:

1. Verify logged-out access to exactly `/catalog.json` and
   `/api/care-plan-request`. Check staff routes remain protected.
2. Confirm the existing project's `CATALOG_DEPLOY_HOOK_URLS` and
   `PUBLIC_CATALOG_URL` reference its real catalog URL. The root
   `wrangler.toml` currently has an empty Production `PUBLIC_CATALOG_URL`;
   update this later only through a separately reviewed configuration change.
3. Test one authorized Pricing Editor → D1 → existing Pages Deploy Hook →
   catalog publication/version-poll cycle.
4. Do not create a separate public Pages project, duplicate deploy hooks,
   or change the WordPress constants.

If the Worker or token fails, pause catalog publication and retain the last
successful Pages deployment. Correct the Worker and Preview/Production build
variables and run a controlled verification. Never fall back to embedded
prices or create an account-wide D1 Read token as a shortcut. **Reverting
the PR alone is not a functional rollback:** the old build script then
expects the credential deliberately being removed.

For the full ordered checklist and platform references, see
`CATALOG-EXPORT-ROLLOUT.md`.
