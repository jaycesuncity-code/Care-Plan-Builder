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
| `TURNSTILE_SECRET`, `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_SECRET`, `IP_HASH_SALT` | **Dashboard → Secrets (encrypted)** | secrets must never be in a public repo |
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

```bash
npm install
cp .dev.vars.example .dev.vars     # already points at the local mocks
npm run db:migrate:local           # applies 0001, 0002, 0004, 0005
```

Two terminals:

```bash
npm run mock:n8n                   # webhook + Turnstile siteverify mock, port 8799
npm run dev                        # dashboard + both APIs, port 8788
```

Then:

- dashboard → <http://localhost:8788/>
- the Builder → <http://localhost:8788/memberships/>

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
npx wrangler d1 migrations list care-plan-builder --remote   # see what's pending
npx wrangler d1 migrations apply care-plan-builder --remote  # applies 0004 and 0005
```

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

For **each** of Production and Preview, add these four as **Secret** (encrypted):

| Name | Sandbox value | Notes |
|---|---|---|
| `TURNSTILE_SECRET` | `1x0000000000000000000000000000000AA` | real secret key at launch |
| `N8N_WEBHOOK_URL` | `https://suncityautomation.app.n8n.cloud/webhook/care-plan-request` | see step 6 about test vs production URLs |
| `N8N_WEBHOOK_SECRET` | any long random string | must match the n8n Header Auth credential exactly |
| `IP_HASH_SALT` | any long random string | salts the stored IP hashes; rotating it just resets the rate-limit counters |

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

## 5. Deploy and verify the binding

Push the branch and let the Pages build run, or deploy by hand:

```bash
npm run deploy
```

Then confirm the Function is live and its config arrived. This should return **400 with
field errors** (not 404, not 500):

```bash
curl -i -X POST https://care-plan-builder.pages.dev/api/care-plan-request \
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

1. Open <https://care-plan-builder.pages.dev/memberships/>.
2. Pick **Premier**, tick **Mini-Split Tune-Up**, raise **# of HVAC Systems** to 3.
   Sidebar total should read **$930/yr** (600 + 80 + 2 × 125).
3. Click the CTA. The recap should show the plan, the add-ons, and both of Premier's
   complimentary add-ons as **Included**. The Turnstile box should appear and
   self-solve (test key).
4. Fill in a clearly fake name, a real-format phone, an address, pick **Midday**, tick
   the acknowledgement, send.
5. Expect the confirmation panel, and the form to disappear.
6. Check the dashboard at <https://care-plan-builder.pages.dev/> — the lead should be
   at the top of the queue. Open it: **Best time to call** = `Midday`, base $600, the
   $0 **Included** lines, `# of HVAC Systems × 3` at $250, total **$930**.
7. Check `service@suncitylc.com` for the email: subject
   `New Care Plan request: Premier Care Plan - <name>`.
8. Verify the numbers in the database are the server's, not the browser's:

   ```bash
   npx wrangler d1 execute care-plan-builder --remote --command \
     "SELECT id, plan, best_time, base_price, addon_total, total_price FROM submissions ORDER BY id DESC LIMIT 3"
   ```

9. Submit six leads in a row. The sixth should be refused with the wait-time message
   (default limit: 5 per 10 minutes per IP).
10. Delete the test rows when you're done — see part 8.

---

## 8. Launch move

The dashboard goes behind Cloudflare Access + Entra ID; the intake endpoint cannot,
because customers have no Entra accounts. So the endpoint moves to its own **public**
Pages project bound to the **same** D1 database. The code is already written for this:
nothing in `functions/api/care-plan-request.js` or `lib/intake/*` imports the Access
middleware or reads `context.data.staffEmail`.

> Note on the Access middleware: the `add-cloudflare-access-auth` branch **does not
> exist** on `jaycesuncity-code/Care-Plan-Builder` — `main` is the only branch, at
> `8ce0142`. So there is nothing to merge yet, and nothing in this work depends on it.

### 8a. Create the public intake project

1. A new repo (or a subdirectory build) containing only:
   ```
   functions/api/care-plan-request.js
   lib/intake/          (catalog.js, validate.js, http.js, ratelimit.js,
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

   Same D1 id — both projects read and write one database. `ALLOWED_ORIGINS` drops the
   `pages.dev` entry once the sandbox is gone.
6. Add the same four **secrets** (step 4) to this project, Production and Preview.
7. Deploy, then re-run the step 5 curl against
   `https://care-plan-intake.pages.dev/api/care-plan-request`.

### 8b. Point the Builder at it

In the LiveCanvas copy of the Builder (`builder-walkthrough.md` step 5 put both
constants together for exactly this moment):

```js
var SUBMIT_ENDPOINT = 'https://care-plan-intake.pages.dev/api/care-plan-request';
var TURNSTILE_SITEKEY = '<real sitekey from step 3>';
```

Because WordPress isn't on Cloudflare, this is now a **cross-origin** POST. It works
only if the page's origin is in that project's `ALLOWED_ORIGINS`. Both
`https://youknowsuncity.com` and `https://www.youknowsuncity.com` are listed above —
keep whichever the site actually serves, and remember the scheme and any `www.` must
match exactly. No trailing slash.

Apply all 14 walkthrough steps to the LiveCanvas block if you haven't already.

### 8c. Constants and values to swap, in one list

| Where | From | To |
|---|---|---|
| Builder, `SUBMIT_ENDPOINT` | `/api/care-plan-request` | `https://care-plan-intake.pages.dev/api/care-plan-request` |
| Builder, `TURNSTILE_SITEKEY` | `1x00000000000000000000AA` | the real sitekey |
| Builder, each add-on's `photo` | `/img/…` | the WordPress media-library URLs |
| Builder, `LINKS` | sandbox slugs | the real WP slugs, if any differ |
| Intake project, `TURNSTILE_SECRET` | `1x00000…AA` | the real secret key |
| Intake project, `N8N_WEBHOOK_URL` | `…/webhook-test/…` | `…/webhook/…` (workflow Active) |
| Intake project, `ALLOWED_ORIGINS` | includes `pages.dev` | live origins only |

### 8d. Sandbox files to delete

Once the WordPress pages are the real thing, delete from the dashboard project:

```
public/memberships/index.html
public/hvac-care-plan/index.html
public/plumbing-care-plan/index.html
public/bundled-care-plan/index.html
public/premier-care-plan/index.html
public/404.html
public/_headers                     (only existed to keep the sandbox out of search)
functions/[[path]].js               (the 404 → live-site redirect)
LAUNCH-CHECKLIST.md
tests/run-e2e.mjs                   (optional — it drives the sandbox Builder page)
```

Keep `functions/api/care-plan-request.js` and `lib/intake/*` in the dashboard project
only if you want a second copy of the endpoint; otherwise they live in the intake
project and can be deleted here too. Keep `migrations/`, `tests/` (except the e2e
suite), `n8n/` and the docs.

`tests/catalog-parity.test.mjs` and `tests/walkthrough.test.mjs` read
`public/memberships/index.html`. If you delete the sandbox Builder, either point them
at a copy of the LiveCanvas block or drop them — but then nothing stops the WordPress
Builder's prices from drifting away from `lib/intake/catalog.js`, which is the one
piece of drift that quietly mis-bills customers. Keeping a copy of the block in the
repo purely as a parity fixture is the cheaper option.

### 8e. Test rows to delete

Everything the sandbox and the tests created has an id above 4. The four seed rows are
ids 1–4.

```bash
# Look first
npx wrangler d1 execute care-plan-builder --remote --command \
  "SELECT id, name, plan, submitted_at FROM submissions WHERE id > 4 ORDER BY id"

# Then delete. submission_addons/submission_notes cascade automatically.
npx wrangler d1 execute care-plan-builder --remote --command \
  "DELETE FROM submissions WHERE id > 4"

# Clear the rate-limit counters too
npx wrangler d1 execute care-plan-builder --remote --command \
  "DELETE FROM intake_rate_limit"
```

If you want the seed rows gone as well (they are obviously fake names), change `> 4` to
`> 0`. New submissions keep counting up from the highest id ever used, so the first real
lead won't be `#0001` — that's cosmetic only.
