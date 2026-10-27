# Care Plan Builder — D1 schema and migration contract

**Source of truth:** `migrations/*.sql`, the current `lib/intake/*` and `lib/submissions.js` queries, inspected from `jaycesuncity-code/Care-Plan-Builder` `main` at `1f313b5086684afa5f634349d49d86e1f7fdc4f7` (October 27, 2026).

Production D1 database **name:** `care-plan-builder`; Pages binding: `DB`. Current repository `wrangler.toml` includes a database ID; compare it against the actual Cloudflare account before any remote action. **This document describes the schema expected after migration `0009`; the actual remote production migration status was not inspected and must not be inferred from repository files.** Read-only verification is the next launch task in `LAUNCH-CHECKLIST.md`. Both `main` production and configured Preview bindings presently reference the same D1.

## Migration sequence — implemented versus deployed

| File | Repository behavior | Remote status |
| --- | --- | --- |
| `0001_init_schema.sql` | Initial submissions, add-ons, notes, and indexes | Not independently checked in this audit |
| `0002_seed_data.sql` | Four sample submission fixtures for development | Do not reapply to production; remote state unverified |
| `0003` | **No such migration in repository**; historical reserved number | Not applicable |
| `0004_best_time_and_addon_flags.sql` | Rebuild `submissions` to expand callback-time CHECK; preserve child rows; add `included_free`/`locked` | Not independently checked |
| `0005_intake_rate_limit.sql` | Salted-IP hash window table and indexes | Not independently checked |
| `0006_pricing.sql` | `pricing_items`, `pricing_audit`, `pricing_meta`, seeded catalog prices | Not independently checked |
| `0007_submission_is_test.sql` | Add server-controlled `is_test` with default 0; mark four **exact-matching** seed fixtures as practice and rename `addon:qbb` label | Not independently checked |
| `0008_catalog_text.sql` | Add `pricing_items.short_label`, `.description` and field-specific audit columns; backfill catalog descriptions/names | Not independently checked |
| `0009_submission_plan_names.sql` | Rebuild `submissions` so manager-approved full plan names no longer fail the legacy four-name CHECK; preserve children, indexes, classification, historical records and AUTOINCREMENT high-water mark | Not independently checked |

`0009` was approved for inclusion in the repository and is present in `main`. That is **not** evidence of remote application. Before applying any pending migration, compare the live schema, indexes and triggers with the migration's expectations; take and verify a restricted backup; pause writes for a rebuild; obtain separate approval; and verify post-application integrity. Never rewrite an already-applied migration or execute rebuild fragments piecemeal.

## Tables — expected post-0009 schema

### `submissions`

One row per submitted Care Plan request (live or practice). Prices and names are **saved snapshots**, not re-read from the current catalog when office staff view old requests.

| Column | SQLite type / constraint | Use |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Request ID |
| `name` | `TEXT NOT NULL` | Customer name |
| `phone` | `TEXT NOT NULL` | Contact phone |
| `address` | `TEXT NOT NULL` | Service address |
| `best_time` | `TEXT NOT NULL` with CHECK | `Morning`, `Midday`, `Afternoon`, `Evening`, `Anytime`, `No preference` |
| `plan` | `TEXT NOT NULL` | After `0009`, 1–60 characters, nonempty after trim, forbids `<` and `>`; previously only four literal plan names |
| `base_price` | `INTEGER NOT NULL` | Accepted annual plan price at submission time, in whole dollars |
| `addon_total` | `INTEGER NOT NULL DEFAULT 0` | Saved sum of billable add-on line totals, whole dollars |
| `total_price` | `INTEGER NOT NULL` | Saved accepted annual total |
| `status` | `TEXT NOT NULL DEFAULT 'New'` | CHECK: `New`, `Contacted`, `Signed Up`, `Other` |
| `submitted_at` | `TEXT NOT NULL DEFAULT datetime('now')` | Submission time; handler supplies server-side ISO timestamp |
| `updated_at` | `TEXT NOT NULL DEFAULT datetime('now')` | Status/note changes |
| `is_test` | `INTEGER NOT NULL DEFAULT 0` | CHECK `0` or `1`; **server-controlled**, added by `0007` |

`0009` rebuild explicitly preserves all these columns and their historical contents. After migration `0009`, arbitrary names are still **not** accepted merely because the SQL CHECK is more flexible: the intake runtime derives validated names from the authoritative D1 catalog, and the admin API checks catalog constraints before saving. Check actual remote schema before claiming plan-name editing is enabled.

### `submission_addons`

One-to-many with `submissions`, `ON DELETE CASCADE` foreign key on `submission_id`.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Line ID |
| `submission_id` | `INTEGER NOT NULL` | Parent FK |
| `addon_name` | `TEXT NOT NULL` | Accepted name; may carry a literal included/locked suffix for historical office readability |
| `addon_price` | `INTEGER NOT NULL` | **Saved LINE total**, not current unit price; $0 when nonbillable |
| `quantity` | `INTEGER NOT NULL DEFAULT 1` | Quantity; for equipment counts, total installed count, including one base-included unit |
| `included_free` | `INTEGER NOT NULL DEFAULT 0` | Complimentary benefit marker from `0004` |
| `locked` | `INTEGER NOT NULL DEFAULT 0` | Plan-ineligible carryover selection marker from `0004`; not billed |

The server's intended invariant for accepted submissions is `total_price = base_price + addon_total` and `addon_total = SUM(submission_addons.addon_price)` (with zero for no lines). Equipment-count lines charge only units above the included one; normal add-ons multiply price by quantity. A `locked` row can record an abandoned selection at zero; office staff must distinguish these from customer-reviewed billable items. The Premier implementation currently grants salt top-off with paid Water Softener Service, whereas RO **Service** remains paid; complimentary RO filters are a plan benefit, not a free RO Service catalog line. Verify these policies with the approved business catalog before public launch.

### `submission_notes`

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Note ID |
| `submission_id` | `INTEGER NOT NULL` | Parent FK with cascade deletion |
| `status` | `TEXT NOT NULL` | Same status CHECK as submissions |
| `note_text` | `TEXT NOT NULL` | Staff-entered note |
| `created_at` | `TEXT NOT NULL DEFAULT datetime('now')` | Saved time |

### `intake_rate_limit`

Added in `0005`. `id INTEGER PRIMARY KEY AUTOINCREMENT`, `ip_hash TEXT NOT NULL`, `created_at_epoch INTEGER NOT NULL`. `ip_hash` is a salted SHA-256 hash of connecting IP, not a stored raw address. The implementation counts **successful** requests within the configured window, performs lazy cleanup of rows older than 24 hours, and uses indexes on `(ip_hash, created_at_epoch)` and `(created_at_epoch)`. Public and practice routes share the intake handler and same database; check configured behavior before conducting load tests. CORS and rate limits are not staff authentication.

### `pricing_items`

Added in `0006`, expanded in `0008`.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | Stable `plan:<catalogId>` / `addon:<catalogId>` |
| `kind` | `TEXT NOT NULL` | CHECK `plan`, `addon` |
| `label` | `TEXT NOT NULL` | Manager-editable full plan name or add-on name |
| `price` | `INTEGER NOT NULL` | Whole-dollar price, CHECK `>= 0` |
| `updated_at` | `TEXT` | Last change time, nullable |
| `updated_by` | `TEXT` | Authenticated editor email, nullable |
| `short_label` | `TEXT` | Added in `0008`; used for plan tab/short name, NULL for add-ons |
| `description` | `TEXT` | Added in `0008`; plan tagline or add-on description |

`pricing_items` is the D1 source used by the staff pricing endpoint, live intake and build-time public static catalog. Current seed amounts in `0006` are historical initial values, **not** evidence of current production prices. Current display labels/descriptions are seeded/backfilled by migrations and can subsequently be edited by authorized staff; do not hardcode them as permanent expectations.

### `pricing_audit`

Append-only per-field history written by Pricing Editor updates.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | Audit ID |
| `item_id` | `TEXT` | Catalog row ID |
| `old_price`, `new_price` | `INTEGER` nullable | Populated for price changes; NULL for text changes |
| `changed_by` | `TEXT NOT NULL` | Authorized editor identity |
| `changed_at` | `TEXT NOT NULL DEFAULT datetime('now')` | Audit timestamp |
| `field` | `TEXT NOT NULL DEFAULT 'price'` | Added in `0008`: `price`, `label`, `short_label`, `description` |
| `old_value`, `new_value` | `TEXT` nullable | Added in `0008`; field-level before/after value |

The editor uses D1 batches and SQL version guards to avoid silent overwrites and increments the catalog version once per accepted changed save. A no-op save can retrigger catalog publishing without incrementing version/audit.

### `pricing_meta`

Single row, `id INTEGER PRIMARY KEY CHECK(id = 1)`, `version INTEGER NOT NULL`, `updated_at TEXT`. Seeded at version 1 in `0006`; current version increments when accepted real edits occur. Owner-confirmed published **version 17 on October 27, 2026** is a historical checkpoint, not the required current value. Public `catalog.json` and D1 `pricing_meta.version` may briefly differ during publication; compare when investigating a stuck deploy.

## Relevant indexes

- `idx_submissions_status`, `idx_submissions_submitted_at` (recreated by `0004` and `0009` rebuilds).
- `idx_submission_addons_submission_id`, `idx_submission_notes_submission_id` (initial schema).
- `idx_intake_rate_limit_hash_time`, `idx_intake_rate_limit_created_at` (`0005`).

No additional indexes, columns, or database triggers should be assumed without inspecting the current remote schema.

## Dashboard JSON contract

`GET /api/submissions` and `PATCH /api/submissions/:id` use `shapeSubmission()` in `lib/submissions.js`, supplying data derived from a submission row plus its child add-on and note rows. Representative **shape only** (example values are illustrative, not real customer data):

```json
{
  "id": 42,
  "name": "Example Customer",
  "phone": "(575) 555-0101",
  "address": "Example Service Address",
  "bestTime": "Midday",
  "plan": "Premier Care Plan",
  "addons": ["Water Softener Service", "Water Softener Salt (included with plan)"],
  "addonDetail": [
    {"name": "Water Softener Service", "price": 75, "quantity": 1, "includedFree": false, "locked": false},
    {"name": "Water Softener Salt (included with plan)", "price": 0, "quantity": 1, "includedFree": true, "locked": false}
  ],
  "basePrice": 600,
  "total": 675,
  "isTest": true,
  "submittedAt": "2026-10-27T12:00:00.000Z",
  "status": "New",
  "notes": []
}
```

`addons` remains a names-only string array for compatibility; `addonDetail` adds recorded line price (total), quantity and included/locked flags. The shape also exposes `id`, `name`, `phone`, `address`, `bestTime`, `plan`, `basePrice`, `total`, `isTest`, `submittedAt`, `status`, and `notes` (`status`, `text`, `timestamp`). `addon_total` and `updated_at` are queried internally but are not fields in this JSON contract. The dashboard should use saved snapshot totals, not reprice historical rows.

## Routes and classification

- `POST /api/care-plan-request` forces `is_test=0` and normally notifies the office.
- `POST /api/test/care-plan-request` forces `is_test=1` and suppresses routine notifications; keep behind Cloudflare Access.
- `GET /api/pricing` provides live D1 catalog for the protected practice Builder; never expose as the required public WordPress pricing feed.
- `GET /catalog.json` is a **static build artifact** produced from the same catalog shape via `scripts/build-catalog.mjs`; WordPress Builder and all four plan pages fetch this static URL without staff authentication.
- `GET/PUT /api/pricing-admin` is protected by its own JWT validation in application code **as well as** required edge Access.
- `GET /api/submissions`, `PATCH /api/submissions/:id` rely on required Cloudflare Access policy at the edge; these handlers do not independently validate JWTs.

**Cloudflare Access path coverage, actual production schema/application of migrations, and deployed notification/Turnstile state must be checked operationally.** None is provable merely from migration or source files.
