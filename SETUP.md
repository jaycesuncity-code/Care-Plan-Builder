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

## 8. Launch move

The dashboard/practice side can remain behind Cloudflare Access + Entra ID; the future
public intake project cannot, because customers have no Entra accounts. **Do not split
the repo yet.** The current repo deliberately contains both paths until shared development
is complete.

At the later split, move/copy the live wrapper, public pricing endpoint, and required
shared `lib/intake/*` modules into a **public** Pages project bound to the **same** D1.
Keep the test wrapper and staff dashboard here. The shared intake modules do not import
Access middleware or read `context.data.staffEmail`.

> Note on the Access middleware: the `add-cloudflare-access-auth` branch **does not
> exist** on `jaycesuncity-code/Care-Plan-Builder` — `main` is the only branch, at
> `8ce0142`. So there is nothing to merge yet, and nothing in this work depends on it.

### 8a. Create the public intake project

1. A new repo (or a subdirectory build) containing only:
   ```
   functions/api/care-plan-request.js
   functions/api/pricing.js
   lib/intake/          (catalog.js, pricing.js, validate.js, http.js, ratelimit.js,
                         turnstile.js, persist.js, notify.js)
   public/              (can be a single index.html saying "nothing to see here")
   wrangler.toml
   package.json
   migrations/          (optional — the schema is already applied by the dashboard project)
   ```
2. Cloudflare → **Workers & Pages** → **Create** → **Pages** → connect that repo.
3. Project name: `care-plan-intake` → `care-plan-intake.pages.dev`.
4. **Do not** put this project behind Access. Leave it public. That is the point.
5. `wrangler.toml` for it:

   ```toml
   name = "care-plan-intake"
   pages_build_output_dir = "public"
   compatibility_date = "2026-09-01"

   [[d1_databases]]
   binding = "DB"
   database_name = "care-plan-builder"
   database_id = "2c79b253-9f8d-4441-b2ca-6666ac23196a"

   [vars]
   DASHBOARD_URL = "https://care-plan-builder.pages.dev"
   ALLOWED_ORIGINS = "https://youknowsuncity.com,https://www.youknowsuncity.com"
   RATE_LIMIT_MAX = "5"
   RATE_LIMIT_WINDOW_SECONDS = "600"
   ```

   Same D1 id — both projects share one database. The public project contains pricing
   SELECT code only; **do not copy `functions/api/pricing-admin.js` or `lib/admin/` into
   it**. A D1 binding itself cannot be read-only, so the project boundary is what enforces
   public pricing read-only behavior. `ALLOWED_ORIGINS` drops the `pages.dev` entry once
   the sandbox is gone.
6. Add **only the four intake secrets** to this public project, Production and Preview:
   `TURNSTILE_SECRET`, `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`, and
   `IP_HASH_SALT`. Do **not** copy `PRICING_EDITORS`, `ACCESS_TEAM_DOMAIN`, or
   `ACCESS_AUD` to the public intake project.
7. Deploy, then re-run the step 5 curl against
   `https://care-plan-intake.pages.dev/api/care-plan-request`. Also GET
   `https://care-plan-intake.pages.dev/api/pricing` and confirm it returns only
   `version`, `updatedAt`, `plans` and `addons`.

A new plan or add-on added later in `lib/intake/catalog.js` requires a new migration
to seed its `plan:<id>` or `addon:<id>` pricing row. Until every required row contains a
valid price, the Builder and intake return pricing unavailable; catalog seeds are not
runtime fallbacks. Requests remain disabled and customers can retry explicitly or call
575-526-9758.

### 8b. Point the Builder at it

In the LiveCanvas copy of the Builder (`builder-walkthrough.md` steps 5 and 15 keep the launch constants together for this moment):

```js
var SUBMIT_ENDPOINT = 'https://care-plan-intake.pages.dev/api/care-plan-request';
var PRICING_ENDPOINT = 'https://care-plan-intake.pages.dev/api/pricing';
var TURNSTILE_SITEKEY = '<real sitekey from step 3>';
```

Because WordPress isn't on Cloudflare, this is now a **cross-origin** POST. It works
only if the page's origin is in that project's `ALLOWED_ORIGINS`. Both
`https://youknowsuncity.com` and `https://www.youknowsuncity.com` are listed above —
keep whichever the site actually serves, and remember the scheme and any `www.` must
match exactly. No trailing slash.

Apply all 20 walkthrough steps to the LiveCanvas block if you haven't already.

### 8c. Constants and values to swap, in one list

| Where | From | To |
|---|---|---|
| Builder, `SUBMIT_ENDPOINT` | `/api/care-plan-request` | `https://care-plan-intake.pages.dev/api/care-plan-request` |
| Builder, `PRICING_ENDPOINT` | `/api/pricing` | `https://care-plan-intake.pages.dev/api/pricing` |
| Builder, `TURNSTILE_SITEKEY` | `1x00000000000000000000AA` | the real sitekey |
| Builder, each add-on's `photo` | `/img/…` | the WordPress media-library URLs |
| Builder, `LINKS` | sandbox slugs | the real WP slugs, if any differ |
| Intake project, `TURNSTILE_SECRET` | `1x00000…AA` | the real secret key |
| Intake project, `N8N_WEBHOOK_URL` | `…/webhook-test/…` | `…/webhook/…` (workflow Active) |
| Intake project, `ALLOWED_ORIGINS` | includes `pages.dev` | live origins only |

### 8d. Later split map — do not delete the practice Builder

The previous plan to delete the Cloudflare Builder is superseded. After the future split:

```text
KEEP IN STAFF/DASHBOARD REPO:
public/index.html
public/careplan-builder/index.html
functions/api/test/care-plan-request.js
functions/api/submissions/*
functions/api/pricing-admin.js
lib/admin/*
dashboard/practice tests
migrations/ and D1 schema management

MOVE/COPY TO PUBLIC REPO:
functions/api/care-plan-request.js
functions/api/pricing.js
shared lib/intake/* required by those public endpoints
public-facing intake/pricing tests

SHARED D1:
the same care-plan-builder database, including submissions.is_test

CONFIG THAT DIFFERS:
public CORS origins, public Turnstile sitekey/secret, public Pages project URL,
production n8n secrets, WordPress SUBMIT_ENDPOINT and PRICING_ENDPOINT
```

The staff practice Builder remains intentionally available and points to
`/api/test/care-plan-request`.

### 8e. Test-data inspection / optional cleanup

Do **not** infer test data from submission ids. Inspect by the durable server-controlled
classification:

```bash
npx wrangler d1 execute care-plan-builder --remote --command \
  "SELECT id, name, plan, submitted_at FROM submissions WHERE is_test = 1 ORDER BY id"
```

If you intentionally choose to remove practice data later, delete only rows you have
reviewed and confirmed as disposable, using `WHERE is_test = 1`. Child add-ons/notes
cascade automatically. Do not automatically delete test data as part of deployment.

## 9. Live/Test verification after 0007

After applying 0007 locally, submit one request to each route and query:

```sql
SELECT id, name, is_test, plan, total_price
FROM submissions
ORDER BY id DESC;
```

Expected: `/api/care-plan-request` writes `is_test=0`; `/api/test/care-plan-request`
writes `is_test=1`. Supplying `is_test`, `isTest`, `test`, or query-string variants
must not alter that result. The test route should save normally and appear in the
dashboard without calling the routine n8n office webhook.

## 9. Static catalog publishing — dashboard and future public project

Complete these settings before enabling the new Pages build command. No real token,
deploy hook, remote migration, production request or WordPress edit was made as part of
this implementation. Cloudflare UI wording may show **Environment variables** or
**Variables and Secrets** for the same settings panel.

### 9.1 Back up and apply approved 0008 and 0009 safely

The user approved including 0009 and pushing the completed implementation to main. Remote migration application remains a separate deployment step.
The commands below are manual operational instructions; they were not run remotely here.

1. In a clean local checkout, select `main`, verify it is the reviewed release commit `a565260384bbb8f7ef393132075085feab7a24ac`, then run `npm ci`.
2. Run `npx wrangler login` with the account holding `care-plan-builder`.
3. Run `npx wrangler d1 migrations list care-plan-builder --remote`.
4. Inspect the remote schema and row counts:

   ```bash
   npx wrangler d1 execute care-plan-builder --remote --command "PRAGMA table_info(pricing_items); PRAGMA table_info(pricing_audit); SELECT version FROM pricing_meta WHERE id=1; SELECT count(*) AS submissions FROM submissions; SELECT count(*) AS addons FROM submission_addons; SELECT count(*) AS notes FROM submission_notes;"
   ```

5. Stop if earlier migrations are pending unexpectedly, the binding points to another
   database, or 0008's new columns already exist without its migration record. Do not
   blindly apply all pending migrations in that situation.
6. Take a full export and verify that the resulting file is nonempty and contains the
   expected schema and rows; retain it securely outside the public repo:

   ```bash
   BACKUP_DIR="$HOME/care-plan-d1-backups/$(date -u +%Y%m%dT%H%M%SZ)"
   mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
   npx wrangler d1 export care-plan-builder --remote --output "$BACKUP_DIR/backup-before-0008-0009.sql"
   ```

7. With 0008/0009 confirmed as the only pending approved migrations (or just 0009 if 0008 is already applied), and after the schema review below, run:

   ```bash
   npx wrangler d1 migrations apply care-plan-builder --remote
   ```

8. Compare the same submission/add-on/note counts with step 4, confirm all 13 catalog
   items have populated descriptions and the four plans have short labels. Because
   `wrangler d1 migrations list` reports **unapplied** migrations, it should be empty after
   success; confirm 0008 and 0009 are recorded exactly once in `d1_migrations`. Catalog prices and historical submissions should
   be unchanged.

**Approved full-name constraint correction:** 0008 is additive and does not change
submissions. Approved `migrations/0009_submission_plan_names.sql` replaces the original
`plan IN (...)` CHECK, which otherwise rejects manager-defined full names. The user explicitly
authorized including 0009 and pushing the completed work to main on October 6, 2026.
No remote migration was authorized or run as part of that push.

0009 rebuilds `submissions` while preserving children, historical values, classification,
indexes, IDs and the AUTOINCREMENT high-water mark. Before running the migration command:

1. Compare `PRAGMA table_info(submissions)`, `PRAGMA table_info(submission_addons)`,
   `PRAGMA table_info(submission_notes)` and the relevant `sqlite_master` indexes/triggers
   with the repository. Stop and adapt 0009 if the remote has additional columns or
   auth-related schema that this repository does not contain.
2. Export the full database as in step 6; verify the backup and retain it securely.
3. Pause live/practice intake writes for the operation so the preservation/count checks
   have a stable baseline. Record complete historical/child data and row counts.
4. Apply the approved pending migrations with Wrangler's migration command, as in step 7.
   Never rewrite prior migrations or run the rebuild manually in fragmented commands.
5. Compare every original row/child value, flags, indexes and IDs, check
   `PRAGMA foreign_key_check`, confirm the migration list and resume intake.
6. Confirm full-name inputs are editable only after 0009 is applied, and test a renamed
   plan through the intended non-production intake/notification environment.

The editor rejects unsupported full-name changes before any catalog write until 0009's
schema is detected; this prevents a code deployment from enabling renames prematurely.

### 9.2 Create the minimum-permission D1 read token

1. Open the Cloudflare dashboard, choose your profile menu, then **My Profile → API Tokens**.
2. Click **Create Token**, then **Create Custom Token / Get started**.
3. Name it `Care Plan catalog build — D1 read`.
4. Under **Permissions**, select **Account → D1 → Read** only. Do not grant D1 Write,
   Pages Edit or account-wide Edit permissions.
5. Under **Account Resources**, select **Include → Specific account**, then choose the
   account holding the database. This token is scoped to that account's D1 read access;
   the token UI does not make it a single-database token.
6. Click **Continue to summary**, verify the single permission and account, then
   **Create Token**. Copy the token to your secure credential store; never paste it into git.
7. Record the **Account ID** from the account dashboard and the **Database ID** from
   **Workers & Pages / Storage & databases → D1 → care-plan-builder → Details/Settings**.
   The repository currently binds to `2c79b253-9f8d-4441-b2ca-6666ac23196a`; confirm it
   matches rather than assuming a newly split project uses the correct binding.

### 9.3 Set build variables on each catalog-serving Pages project

Repeat for the gated project and, after the split, the public project that serves catalog.json.
Use each project's **Production** and **Preview** settings intentionally; preview hooks
must build preview branches, and preview tests must not trigger production hooks.

1. **Workers & Pages → select the Pages project → Settings → Environment variables**
   (or **Variables and Secrets**).
2. Select the relevant **Production** or **Preview** environment and add these names
   to the environment available to the **Pages build process**:

   | Name | Value | Treatment |
   |---|---|---|
   | CLOUDFLARE_API_TOKEN | token from 9.2 | Encrypt/Secret |
   | CLOUDFLARE_ACCOUNT_ID | confirmed account ID | build value; encrypted is also acceptable |
   | D1_DATABASE_ID | confirmed D1 UUID | build value; encrypted is also acceptable |
   | NODE_VERSION | 22.13.1 or a supported newer Node 22/24 release | build runtime |

3. Save each setting. If Wrangler-managed runtime vars restrict dashboard plaintext
   entries, use encrypted values for the three D1 build variables. They must reach
   `process.env` during the Node build; `[vars]` and `.dev.vars` alone do not configure it.
4. **Settings → Builds → Build configurations → Edit**: choose no framework preset,
   set **Build command** to `node scripts/build-catalog.mjs`, **Build output directory**
   to `public`, and repository **Root directory** to the repository root. Save.
5. Repeat for the other intended environment/project. The generator itself supports
   Node 18+; dependencies and the local SQLite test suite need Node 22.13+.
6. Before using a hook, confirm that a reviewed deployment successfully generates
   `catalog.json`. A missing variable, D1 HTTP error or invalid catalog must fail the
   build and keep the previous successful deployment. Do not substitute seed data.

Build credentials belong only in the build environment; the public intake Function does
not need a Cloudflare API token. Preserve the D1 `DB` binding and existing intake secrets.

### 9.4 Create deploy hook(s) and the dashboard-only publishing secret

1. **Workers & Pages → gated Pages project → Settings → Builds → Deploy hooks**.
2. Click **Add deploy hook**. Name it `Catalog refresh — staff` and choose the branch
   that actually contains the reviewed catalog build. For this released implementation,
   use `main` for the production hook. Use a separate preview branch only when you are
   intentionally configuring a preview-only hook.
3. Save and copy the generated hook URL into your secure credential store. Possession
   of that URL authorizes a build; do not put it into docs, browser code or commit messages.
4. After the split, repeat on the **public Pages project** with a name such as
   `Catalog refresh — public`, selecting that project's correct branch.
5. Return to the **gated project → Settings → Variables and Secrets**, select the correct
   environment, and add an encrypted **Secret** named `CATALOG_DEPLOY_HOOK_URLS`.
6. Its value is the gated hook URL and public hook URL separated by a comma. Before the
   split, use only the gated hook if that is the only configured catalog build.
7. Never add this secret to the public project. Maintain distinct Preview/Production
   values if those environments build different branches. Save.
8. Set gated `wrangler.toml [vars] PUBLIC_CATALOG_URL` to
   `https://<public-host>/catalog.json` after the public project exists. It may stay empty
   before the split. If creating environment-specific `[vars]` blocks, restate all vars.
9. A hook failure still saves D1 and is shown to the manager. A successful hook means
   the build started, not that it finished. The editor polls the configured static
   URL until its version reaches the saved version; it reports a timeout after five minutes.

### 9.5 Public project and WordPress endpoints

1. The future public repo includes `scripts/build-catalog.mjs`, `lib/intake/*`,
   `package.json` with `type: module`, public `_headers` and `_routes.json`, the public
   assets and live intake wrapper. It must exclude `functions/api/pricing-admin.js`,
   `lib/admin/`, `public/pricing/`, staff dashboard APIs/pages, practice intake routes,
   and the deploy-hook/Access secrets. The staff project retains `/api/pricing`.
2. Preserve `_routes.json`'s `/catalog.json` exclusion; the current catch-all Function
   would otherwise intercept catalog requests. The static CORS header is `*` and uses
   no credentials. The public host must serve this file without a Cloudflare Access
   sign-in wall. The gated project may remain fully protected by Access.
3. Paste the fresh Builder block into WordPress and replace:

   ```js
   var CATALOG_ENDPOINT = 'https://<public-host>/catalog.json';
   var SUBMIT_ENDPOINT = 'https://<public-host>/api/care-plan-request';
   ```

4. In each of the four fresh plan-page blocks, set:

   ```js
   var CATALOG_URL = 'https://<public-host>/catalog.json';
   ```

5. Keep page navigation root-relative and retain paste-region wrappers. Install the
   actual Turnstile sitekey and preserve the exact origin allowlist, including both
   WordPress hostnames. The staff copy keeps `/api/pricing` and the test intake route.
6. After configuration/release, verify one small catalog save in the intended environment:
   D1 audit fields and version, deploy-hook build source, static version advance, Builder
   labels/prices, all four pages, and the office's stored/emailed names. Full plan renames
   remain blocked until approved 0009 is applied.

Official references checked for this guide:

- [D1 query API: accepts D1 Read and multiple SQL statements](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
- [Create API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [Pages deploy hooks](https://developers.cloudflare.com/pages/configuration/deploy-hooks/)
- [Pages build configuration and environment variables](https://developers.cloudflare.com/pages/configuration/build-configuration/)
- [Pages Functions invocation route exclusions](https://developers.cloudflare.com/pages/functions/routing/)
