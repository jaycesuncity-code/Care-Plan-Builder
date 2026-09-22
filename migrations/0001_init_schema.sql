-- Migration: init_schema
-- Care Plan Submissions Dashboard — core schema

CREATE TABLE submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  address      TEXT NOT NULL,
  best_time    TEXT NOT NULL CHECK (best_time IN ('Morning', 'Afternoon', 'Evening', 'Anytime')),
  plan         TEXT NOT NULL CHECK (plan IN ('HVAC Care Plan', 'Plumbing Care Plan', 'Bundled Care Plan', 'Premier Care Plan')),
  base_price   INTEGER NOT NULL,
  addon_total  INTEGER NOT NULL DEFAULT 0,
  total_price  INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Contacted', 'Signed Up', 'Other')),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE submission_addons (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  addon_name    TEXT NOT NULL,
  addon_price   INTEGER NOT NULL,
  quantity      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE submission_notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('New', 'Contacted', 'Signed Up', 'Other')),
  note_text     TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_submissions_status ON submissions(status);
CREATE INDEX idx_submissions_submitted_at ON submissions(submitted_at);
CREATE INDEX idx_submission_addons_submission_id ON submission_addons(submission_id);
CREATE INDEX idx_submission_notes_submission_id ON submission_notes(submission_id);
