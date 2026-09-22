-- Migration: seed_data
-- 4 realistic test submissions with addons and notes, for API/dashboard development

INSERT INTO submissions (id, name, phone, address, best_time, plan, base_price, addon_total, total_price, status, submitted_at, updated_at) VALUES
  (1, 'Robert Martinez', '(575) 312-4487', '142 Sierra Vista Dr, Las Cruces, NM 88011', 'Morning', 'HVAC Care Plan', 260, 120, 380, 'Signed Up', '2026-09-08T09:14:00', '2026-09-08T09:22:00'),
  (2, 'Dana Whitfield', '(575) 555-2093', '2210 El Paseo Rd, Las Cruces, NM 88001', 'Afternoon', 'Plumbing Care Plan', 160, 68, 228, 'Contacted', '2026-09-10T13:05:00', '2026-09-11T10:40:00'),
  (3, 'Alicia Nguyen', '(575) 555-7714', '905 Telshor Blvd, Las Cruces, NM 88005', 'Evening', 'Bundled Care Plan', 400, 0, 400, 'New', '2026-09-14T17:48:00', '2026-09-14T17:48:00'),
  (4, 'Marcus Ibarra', '(575) 555-3361', '3317 Missouri Ave, Las Cruces, NM 88011', 'Anytime', 'Premier Care Plan', 600, 175, 775, 'Other', '2026-09-16T08:30:00', '2026-09-17T14:02:00');

INSERT INTO submission_addons (submission_id, addon_name, addon_price, quantity) VALUES
  (1, 'Quarterly Filter Change', 120, 1),
  (2, 'Water Softener Salt', 68, 1),
  (4, 'Mini-Split Tune-Up', 80, 1),
  (4, 'Additional Water Heater', 50, 1),
  (4, 'Reverse Osmosis Service', 45, 1);

INSERT INTO submission_notes (submission_id, status, note_text, created_at) VALUES
  (1, 'Signed Up', 'Confirmed payment info on file over the phone; scheduled first HVAC visit for 9/25.', '2026-09-08T09:22:00'),
  (2, 'Contacted', 'Left voicemail, called back same day — wants to think it over, follow up next week.', '2026-09-11T10:40:00'),
  (4, 'Contacted', 'Interested but asked about bundling with a second property; pending quote.', '2026-09-16T15:10:00'),
  (4, 'Other', 'Went with a competitor. Keep on file for renewal outreach next year.', '2026-09-17T14:02:00');
