-- Pricing tables for the Care Plan Builder.
-- Additive only: this migration does not alter the existing intake tables.
-- Seed block generated from lib/intake/catalog.js by scripts/generate-pricing-seed.mjs.

CREATE TABLE pricing_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'addon')),
  label TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  updated_at TEXT,
  updated_by TEXT
);

CREATE TABLE pricing_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT,
  old_price INTEGER,
  new_price INTEGER,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pricing_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at TEXT
);

INSERT INTO pricing_meta (id, version, updated_at)
VALUES (1, 1, datetime('now'));

-- BEGIN GENERATED PRICING SEED
INSERT INTO pricing_items (id, kind, label, price, updated_at, updated_by) VALUES
  ('plan:hvac', 'plan', 'HVAC Care Plan', 260, NULL, NULL),
  ('plan:plumbing', 'plan', 'Plumbing Care Plan', 160, NULL, NULL),
  ('plan:bundled', 'plan', 'Bundled Care Plan', 400, NULL, NULL),
  ('plan:premier', 'plan', 'Premier Care Plan', 600, NULL, NULL),
  ('addon:hvacSystems', 'addon', '# of HVAC Systems', 125, NULL, NULL),
  ('addon:qfc', 'addon', 'Quarterly Filter Change', 120, NULL, NULL),
  ('addon:mst', 'addon', 'Mini-Split Tune-Up', 80, NULL, NULL),
  ('addon:waterHeaters', 'addon', '# of Water Heaters', 50, NULL, NULL),
  ('addon:wsv', 'addon', 'Water Softener Service', 75, NULL, NULL),
  ('addon:wss', 'addon', 'Water Softener Salt', 68, NULL, NULL),
  ('addon:ros', 'addon', 'Reverse Osmosis Service', 50, NULL, NULL),
  ('addon:twf', 'addon', 'Tankless Water Heater Flush', 40, NULL, NULL),
  ('addon:qbb', 'addon', 'Quarterly BigBlue Filter Change', 180, NULL, NULL);
-- END GENERATED PRICING SEED
