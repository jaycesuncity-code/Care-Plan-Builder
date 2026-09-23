-- Migration: best_time_and_addon_flags
-- Prepares the schema for the public Care Plan Builder intake endpoint.
--
-- 1. WIDENS the best_time CHECK. The builder's <select> offers "No preference",
--    Morning, Midday and Afternoon. The original CHECK allowed only Morning,
--    Afternoon, Evening and Anytime — so there was no way to store Midday, and
--    no way to store "customer didn't say" without inventing an answer they
--    never gave. The dashboard prints best_time verbatim
--    (modalBestTime.textContent = row.bestTime), so widening the CHECK is all
--    that's needed for these to display correctly.
--    SQLite cannot ALTER a CHECK constraint, so the table is rebuilt.
--
-- 2. ADDS included_free / locked to submission_addons, so a $0 "included with
--    Premier" line and a leftover line from a previously-selected plan are
--    machine-distinguishable from a real charge. addon_total stays the billable
--    sum only.
--
-- ---------------------------------------------------------------------------
-- Why the rebuild is shaped like this (D1 enforces foreign keys by default):
-- DROP TABLE on a parent performs an implicit DELETE FROM, and that DOES fire
-- ON DELETE CASCADE on submission_addons and submission_notes. PRAGMA
-- defer_foreign_keys defers constraint *checking*; it does not stop a cascade
-- action. So the child rows are copied aside first and restored afterwards.
-- ---------------------------------------------------------------------------

PRAGMA defer_foreign_keys = on;

-- Hold the children somewhere with no FK of its own.
CREATE TABLE _addons_backup_0004 AS SELECT * FROM submission_addons;
CREATE TABLE _notes_backup_0004  AS SELECT * FROM submission_notes;

CREATE TABLE submissions_new_0004 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  address      TEXT NOT NULL,
  best_time    TEXT NOT NULL CHECK (best_time IN ('Morning', 'Midday', 'Afternoon', 'Evening', 'Anytime', 'No preference')),
  plan         TEXT NOT NULL CHECK (plan IN ('HVAC Care Plan', 'Plumbing Care Plan', 'Bundled Care Plan', 'Premier Care Plan')),
  base_price   INTEGER NOT NULL,
  addon_total  INTEGER NOT NULL DEFAULT 0,
  total_price  INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Contacted', 'Signed Up', 'Other')),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO submissions_new_0004
  (id, name, phone, address, best_time, plan, base_price, addon_total, total_price, status, submitted_at, updated_at)
SELECT
  id, name, phone, address, best_time, plan, base_price, addon_total, total_price, status, submitted_at, updated_at
FROM submissions;

DROP TABLE submissions;                            -- empties the two child tables via CASCADE
ALTER TABLE submissions_new_0004 RENAME TO submissions;

-- Indexes went with the old table.
CREATE INDEX idx_submissions_status ON submissions(status);
CREATE INDEX idx_submissions_submitted_at ON submissions(submitted_at);

-- Restore the children (parents exist again, so the FKs resolve).
DELETE FROM submission_addons;
DELETE FROM submission_notes;

INSERT INTO submission_addons (id, submission_id, addon_name, addon_price, quantity)
SELECT id, submission_id, addon_name, addon_price, quantity FROM _addons_backup_0004;

INSERT INTO submission_notes (id, submission_id, status, note_text, created_at)
SELECT id, submission_id, status, note_text, created_at FROM _notes_backup_0004;

DROP TABLE _addons_backup_0004;
DROP TABLE _notes_backup_0004;

-- New flags. 0 for every historical row, which is correct: everything recorded
-- before this migration was a billable line.
ALTER TABLE submission_addons ADD COLUMN included_free INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submission_addons ADD COLUMN locked        INTEGER NOT NULL DEFAULT 0;

PRAGMA defer_foreign_keys = off;
