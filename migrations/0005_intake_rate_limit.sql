-- Migration: intake_rate_limit
-- Backs the in-code rate limiter for POST /api/care-plan-request.
--
-- Pages Functions don't get the Workers rate-limit binding, and Cloudflare WAF
-- rate-limiting rules need a zone (youknowsuncity.com isn't on Cloudflare), so
-- the window is counted here.
--
-- PRIVACY: no IP addresses. ip_hash is a salted SHA-256 of CF-Connecting-IP,
-- hex-encoded, salted with the IP_HASH_SALT secret. Rotating that salt resets
-- every counter, which is harmless.
--
-- One row per SUCCESSFUL submission. Rows older than 24h are purged lazily by
-- the endpoint on the way past — no cron, no queue.

CREATE TABLE intake_rate_limit (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash          TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);

-- Covers the windowed COUNT/MIN lookup for one hash.
CREATE INDEX idx_intake_rate_limit_hash_time ON intake_rate_limit(ip_hash, created_at_epoch);
-- Covers the lazy purge.
CREATE INDEX idx_intake_rate_limit_created_at ON intake_rate_limit(created_at_epoch);
