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
| `best_time` | TEXT | CHECK in `Morning`, `Afternoon`, `Evening`, `Anytime` |
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
| `addon_price` | INTEGER | **price at time of submission**, not a live pricebook lookup — historical submissions never reprice when the pricebook changes |
| `quantity` | INTEGER | default `1`; not used by the current Builder, but the real intake flow will need it (e.g. multiple "Additional HVAC System" units) |

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
| `addons` | join on `submission_addons` where `submission_id` matches; API sends addon names only (see `functions/api/submissions/index.js`) |
| `notes` | join on `submission_notes` where `submission_id` matches, ordered by `created_at`; `timestamp` ← `created_at`, `text` ← `note_text` |

Implemented in `lib/submissions.js` (`shapeSubmission`), used by both
`GET /api/submissions` and `PATCH /api/submissions/:id`.

`addon_total` and `updated_at` exist in the DB but aren't currently surfaced in the
JSON contract — useful for internal queries/audit, not read by the UI today.
