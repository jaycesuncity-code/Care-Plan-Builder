-- Approved follow-up migration: permit editor-managed full plan names.
-- Current submissions.plan CHECK rejects every manager-defined full plan name.
-- Preserve historical rows, child rows, classification, IDs and AUTOINCREMENT high-water mark.
-- Before remote application compare columns/indexes/triggers with this repository.
-- Never rewrite already-applied 0001/0004/0007. Back up before this table rebuild.
PRAGMA defer_foreign_keys = on;
CREATE TABLE _addons_backup_0009 AS SELECT * FROM submission_addons;
CREATE TABLE _notes_backup_0009 AS SELECT * FROM submission_notes;
CREATE TABLE _sequence_backup_0009 AS SELECT seq FROM sqlite_sequence WHERE name = 'submissions';

CREATE TABLE submissions_new_0009 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  best_time TEXT NOT NULL CHECK (best_time IN ('Morning', 'Midday', 'Afternoon', 'Evening', 'Anytime', 'No preference')),
  plan TEXT NOT NULL CHECK (length(plan) BETWEEN 1 AND 60 AND length(trim(plan)) > 0 AND instr(plan, '<') = 0 AND instr(plan, '>') = 0),
  base_price INTEGER NOT NULL,
  addon_total INTEGER NOT NULL DEFAULT 0,
  total_price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Contacted', 'Signed Up', 'Other')),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1))
);
INSERT INTO submissions_new_0009 (id, name, phone, address, best_time, plan, base_price, addon_total, total_price, status, submitted_at, updated_at, is_test)
SELECT id, name, phone, address, best_time, plan, base_price, addon_total, total_price, status, submitted_at, updated_at, is_test FROM submissions;
DROP TABLE submissions;
ALTER TABLE submissions_new_0009 RENAME TO submissions;
CREATE INDEX idx_submissions_status ON submissions(status);
CREATE INDEX idx_submissions_submitted_at ON submissions(submitted_at);
INSERT INTO submission_addons (id, submission_id, addon_name, addon_price, quantity, included_free, locked)
SELECT id, submission_id, addon_name, addon_price, quantity, included_free, locked FROM _addons_backup_0009;
INSERT INTO submission_notes (id, submission_id, status, note_text, created_at)
SELECT id, submission_id, status, note_text, created_at FROM _notes_backup_0009;
UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT max(seq) FROM _sequence_backup_0009), 0)) WHERE name = 'submissions';
INSERT INTO sqlite_sequence (name, seq)
SELECT 'submissions', coalesce((SELECT max(seq) FROM _sequence_backup_0009), 0)
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'submissions');
DROP TABLE _addons_backup_0009;
DROP TABLE _notes_backup_0009;
DROP TABLE _sequence_backup_0009;
PRAGMA defer_foreign_keys = off;
