# Care Plan Submissions — D1 Schema

Database: `care-plan-builder` (D1, binding `DB`, id `2c79b253-9f8d-4441-b2ca-6666ac23196a`)

Backs the **Care Plan Submissions Dashboard** — internal office tool for tracking leads
from the public "Care Plan Builder" widget through to enrollment. Migrations live in
`/migrations`, managed with `wrangler d1 migrations`.

## Tables

### `submissions`
One row per lead.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `name` | TEXT | required |
| `phone` | TEXT | required |
| `address` | TEXT | required |
| `best_time` | TEXT | CHECK in `Morning`, `Midday`, `Afternoon`, `Evening`, `Anytime`, `No preference` — widened by migration 0004. The Builder's form offers *No preference / Morning / Midday / Afternoon*; the original CHECK had no `Midday` and no way to record "customer didn't say", so those two were added rather than mapping the customer's answer onto something they never picked. The dashboard prints this column verbatim. |
| `plan` | TEXT | CHECK in `HVAC Care Plan`, `Plumbing Care Plan`, `Bundled Care Plan`, `Premier Care Plan` |
| `base_price` | INTEGER | plan price at time of submission |
| `addon_total` | INTEGER | sum of selected add-on line totals at time of submission |
| `total_price` | INTEGER | `base_price + addon_total` |
| `status` | TEXT | CHECK in `New`, `Contacted`, `Signed Up`, `Other`; default `New`. `New`/`Contacted` = active, `Signed Up`/`Other` = archived |
| `submitted_at` | TEXT | ISO timestamp, set on insert |
| `updated_at` | TEXT | ISO timestamp, bump on any status/note change |

### `submission_addons`
One row per add-on selected on a submission. Many-to-one with `submissions`.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `submission_id` | INTEGER | FK → `submissions.id`, `ON DELETE CASCADE` |
| `addon_name` | TEXT | e.g. `Quarterly Filter Change` |
| `addon_price` | INTEGER | **the line total for this row at time of submission**, not a live pricebook lookup and not the unit price — so `SUM(addon_price) = submissions.addon_total` always holds, for a normal add-on (unit x qty) and for the equipment counts alike (only the units above the included count are charged). `0` for included/locked rows. Historical submissions never reprice when the pricebook changes. |
| `quantity` | INTEGER | default `1`. For a normal add-on this is how many the customer chose. For the two quantity-only equipment counts (`# of HVAC Systems`, `# of Water Heaters`) it is the **total** count at the property, of which `included` (1) comes with the plan. |
| `included_free` | INTEGER | added by 0004. `1` = complimentary with the selected plan (Premier's softener salt and reverse osmosis). Always `$0`, never counted in `addon_total`. |
| `locked` | INTEGER | added by 0004. `1` = the customer had selected this under a previous plan and the plan they submitted doesn't cover it. Recorded at `$0` so the office can see what they were interested in; never charged. |

Non-billable rows also carry a suffix in `addon_name` — `" (included with plan)"` or
`" (not covered by selected plan)"` — so a names-only read of the table (the
dashboard's `addons` array) can't mistake them for charges.

### `submission_notes`
One row per status note. Many-to-one with `submissions`. A submission can accumulate
many notes over its lifetime.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `submission_id` | INTEGER | FK → `submissions.id`, `ON DELETE CASCADE` |
| `status` | TEXT | the status this note was attached to when written; same CHECK set as `submissions.status` |
| `note_text` | TEXT | free text |
| `created_at` | TEXT | ISO timestamp |

### `intake_rate_limit`
Added by migration 0005. Backs the in-code rate limiter on
`POST /api/care-plan-request` — Pages Functions don't get the Workers rate-limit
binding, and WAF rate-limiting rules need a zone, which `youknowsuncity.com` doesn't
have.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `ip_hash` | TEXT | **salted SHA-256 of `CF-Connecting-IP`, hex** — no IP address is ever stored. Salt is the `IP_HASH_SALT` secret; rotating it just resets the counters. |
| `created_at_epoch` | INTEGER | Unix seconds. One row per *successful* submission, so a customer's own typos or a failed captcha can't push them toward a lockout. |

Rows older than 24h are purged lazily by the endpoint on the way past — no cron.

### Indexes
- `submissions.status`, `submissions.submitted_at`
- `submission_addons.submission_id`, `submission_notes.submission_id`

## Mapping to the dashboard's JSON shape

The front-end (`public/index.html`) expects one object per submission:

```json
{
  "id": 1,
  "name": "Robert Martinez",
  "phone": "(575) 312-4487",
  "address": "142 Sierra Vista Dr, Las Cruces, NM 88011",
  "bestTime": "Morning",
  "plan": "HVAC Care Plan",
  "addons": ["Quarterly Filter Change"],
  "basePrice": 260,
  "addonDetail": [
    { "name": "Quarterly Filter Change", "price": 120, "quantity": 1, "includedFree": false, "locked": false }
  ],
  "total": 380,
  "submittedAt": "2026-09-08T09:14:00",
  "status": "Signed Up",
  "notes": [
    { "status": "Signed Up", "text": "...", "timestamp": "2026-09-08T09:22:00" }
  ]
}
```

| JSON field | Source |
|---|---|
| `id`, `name`, `phone`, `address`, `basePrice`, `submittedAt`, `status` | `submissions` row, direct column mapping (`bestTime` ← `best_time`, `basePrice` ← `base_price`, `submittedAt` ← `submitted_at`) |
| `plan` | `submissions.plan` |
| `total` | `submissions.total_price` |
| `addons` | join on `submission_addons` where `submission_id` matches; addon names only, unchanged |
| `addonDetail` | same join, one object per row: `name`, `price` (line total), `quantity`, `includedFree`, `locked`. Added alongside `addons` (same spirit as `basePrice`) rather than changing it — a names-only list can't distinguish a `$0` complimentary or locked line from a charge, and the dashboard's price table used to throw on any name missing from its `ADDON_CATALOG`. The dashboard prefers `addonDetail` and falls back to `addons` for pre-0004 rows. |
| `notes` | join on `submission_notes` where `submission_id` matches, ordered by `created_at`; `timestamp` ← `created_at`, `text` ← `note_text` |

Implemented in `lib/submissions.js` (`shapeSubmission`), used by both
`GET /api/submissions` and `PATCH /api/submissions/:id`.

`addon_total` and `updated_at` exist in the DB but aren't currently surfaced in the
JSON contract — useful for internal queries/audit, not read by the UI today.

## Migrations

`0003` is deliberately skipped: `0003_add_auth_audit_columns.sql` belongs to the
Cloudflare Access work. The intake work starts at `0004`.

| Migration | What |
|---|---|
| `0001_init_schema.sql` | core schema |
| `0002_seed_data.sql` | 4 sample submissions (local dev only) |
| `0003_…` | **reserved** for the Access branch, not in this repo |
| `0004_best_time_and_addon_flags.sql` | widens the `best_time` CHECK (table rebuild), adds `included_free`/`locked` |
| `0005_intake_rate_limit.sql` | the rate-limit table |

`0004` rebuilds `submissions`, because SQLite cannot ALTER a CHECK constraint. Note
that `DROP TABLE` on a parent runs an implicit `DELETE FROM`, and that **does** fire
`ON DELETE CASCADE` on `submission_addons`/`submission_notes` — `PRAGMA
defer_foreign_keys` defers constraint *checking*, it does not stop a cascade action.
So the migration copies both child tables aside and restores them after the rebuild.
Verified locally: the 4 seed submissions kept all 5 add-on rows and all 4 notes.
