-- Server-controlled Live vs Test classification.
-- Additive only: existing unknown rows remain live (0). Only the four exact 0002 seed fixtures are backfilled to test.
-- Also carries forward preview-testing's qbb label rename without rewriting already-applied 0006.

ALTER TABLE submissions
  ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1));

UPDATE submissions
SET is_test = 1
WHERE
  (id = 1 AND name = 'Robert Martinez' AND phone = '(575) 312-4487') OR
  (id = 2 AND name = 'Dana Whitfield' AND phone = '(575) 555-2093') OR
  (id = 3 AND name = 'Alicia Nguyen' AND phone = '(575) 555-7714') OR
  (id = 4 AND name = 'Marcus Ibarra' AND phone = '(575) 555-3361');

UPDATE pricing_items
SET label = 'Quarterly Sediment Filter Change'
WHERE id = 'addon:qbb'
  AND label = 'Quarterly BigBlue Filter Change';
