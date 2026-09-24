// Rate limiting in code, backed by D1.
//
// Why not a binding or a WAF rule: Pages Functions don't get the Workers
// rate-limit binding, and Cloudflare WAF rate-limiting rules need a zone —
// youknowsuncity.com isn't on Cloudflare. So this is a counted window in D1.
//
// Privacy: the client IP (CF-Connecting-IP) is never stored. What goes in the
// table is a salted SHA-256 of it, hex-encoded, with IP_HASH_SALT from env.
// That is enough to count repeat submitters and useless as a lookup table
// without the salt.
//
// Old rows are purged lazily on the way past — one cheap indexed DELETE per
// request, no cron needed.

export const DEFAULT_LIMIT = 5;
export const DEFAULT_WINDOW_SECONDS = 600;
export const PURGE_AFTER_SECONDS = 86400;

export function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "";
}

export async function hashIp(ip, salt) {
  const data = new TextEncoder().encode(`${salt || ""}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function intFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function rateLimitConfig(env) {
  return {
    limit: intFromEnv(env.RATE_LIMIT_MAX, DEFAULT_LIMIT),
    windowSeconds: intFromEnv(env.RATE_LIMIT_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS),
  };
}

/**
 * Counts this IP's submissions inside the window WITHOUT recording anything.
 * Recording happens only after a submission actually succeeds (recordHit),
 * so a customer who fails validation or the captcha isn't pushed toward a
 * lockout by their own typos.
 *
 * Returns { allowed: true } or { allowed: false, retryAfterSeconds }.
 */
export async function checkRateLimit(db, ipHash, nowEpoch, { limit, windowSeconds }) {
  const windowStart = nowEpoch - windowSeconds;

  // Lazy purge first: keeps the table small, and keeps the COUNT below honest
  // even if a clock or a long-idle period left ancient rows behind.
  await db
    .prepare(`DELETE FROM intake_rate_limit WHERE created_at_epoch < ?`)
    .bind(nowEpoch - PURGE_AFTER_SECONDS)
    .run();

  const row = await db
    .prepare(
      `SELECT COUNT(*) AS hits, MIN(created_at_epoch) AS oldest
         FROM intake_rate_limit
        WHERE ip_hash = ? AND created_at_epoch >= ?`
    )
    .bind(ipHash, windowStart)
    .first();

  const hits = row ? Number(row.hits) || 0 : 0;
  if (hits < limit) return { allowed: true, hits };

  const oldest = row && row.oldest != null ? Number(row.oldest) : nowEpoch;
  // Once the oldest hit in the window ages out, there is room again.
  const retryAfterSeconds = Math.max(1, oldest + windowSeconds - nowEpoch);
  return { allowed: false, hits, retryAfterSeconds };
}

export async function recordHit(db, ipHash, nowEpoch) {
  await db
    .prepare(`INSERT INTO intake_rate_limit (ip_hash, created_at_epoch) VALUES (?, ?)`)
    .bind(ipHash, nowEpoch)
    .run();
}
