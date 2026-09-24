// Response helpers + CORS for the public intake endpoint.
//
// At launch the Care Plan Builder runs on youknowsuncity.com (WordPress, NOT
// on Cloudflare) and posts cross-origin to this endpoint on *.pages.dev, so
// CORS is part of the contract, not an afterthought:
//   - ALLOWED_ORIGINS is a comma-separated allowlist (exact origin match)
//   - a request with no Origin header (same-origin form post, curl, the
//     sandbox itself) is allowed through
//   - an Origin that isn't on the list gets 403 and NO CORS headers, so the
//     browser blocks it too
//   - Vary: Origin is always sent, so a cached response for one origin is
//     never reused for another

export const CORS_MAX_AGE_SECONDS = 86400;

export function parseAllowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Classifies the request's Origin.
 * Returns { kind: "none" | "allowed" | "denied", origin }
 */
export function classifyOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return { kind: "none", origin: null };
  const allowed = parseAllowedOrigins(env);
  if (allowed.includes(origin)) return { kind: "allowed", origin };
  return { kind: "denied", origin };
}

export function corsHeaders(originInfo) {
  const headers = { Vary: "Origin" };
  if (originInfo.kind === "allowed") {
    headers["Access-Control-Allow-Origin"] = originInfo.origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = String(CORS_MAX_AGE_SECONDS);
  }
  return headers;
}

export function json(data, { status = 200, originInfo, extraHeaders } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(originInfo ? corsHeaders(originInfo) : {}),
      ...(extraHeaders || {}),
    },
  });
}

/**
 * One error shape for every failure, so the builder can branch on `code`
 * and show `fieldErrors` next to the right input. Never carries internals.
 */
export function errorResponse({ status, code, message, fieldErrors, originInfo, extraHeaders }) {
  const body = { ok: false, code, error: message };
  if (fieldErrors && Object.keys(fieldErrors).length) body.fieldErrors = fieldErrors;
  return json(body, { status, originInfo, extraHeaders });
}
