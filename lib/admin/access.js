// Cloudflare Access JWT verification for the pricing editor.
// No runtime JWT dependency: RS256 is verified with Web Crypto against the team JWKS.

const CLOCK_SKEW_SECONDS = 60;
const JWKS_CACHE_MS = 5 * 60 * 1000;
const jwksCache = new Map();
const COMPANY_EDITOR_DOMAIN = "suncitylc.com";

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJsonPart(value) {
  const bytes = decodeBase64Url(value);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchJwks(url, force = false) {
  const cached = jwksCache.get(url);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.keys;

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("jwks unavailable");
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.keys)) throw new Error("jwks invalid");
  jwksCache.set(url, { keys: payload.keys, expiresAt: Date.now() + JWKS_CACHE_MS });
  return payload.keys;
}

function audienceMatches(aud, expected) {
  return typeof aud === "string" ? aud === expected : Array.isArray(aud) && aud.includes(expected);
}

function isLocalHost(request) {
  const host = new URL(request.url).hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1";
}

function configured(env) {
  return !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

function editorSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

// Exact company-domain match: subdomains, lookalikes and malformed addresses do not match.
// PRICING_EDITORS remains an optional list of named exceptions outside the company domain.
function isPricingEditor(email, env) {
  if (editorSet(env.PRICING_EDITORS).has(email)) return true;
  const parts = email.split("@");
  return parts.length === 2 && parts[0].length > 0 && parts[1] === COMPANY_EDITOR_DOMAIN;
}

function authFailure(status, code, message) {
  return { ok: false, status, code, message };
}

export async function authenticatePricingEditor(request, env) {
  if (env.DEV_ADMIN_EMAIL && isLocalHost(request)) {
    return { ok: true, email: String(env.DEV_ADMIN_EMAIL).trim().toLowerCase(), local: true };
  }

  if (!configured(env)) {
    return authFailure(503, "AUTH_NOT_CONFIGURED", "Pricing access is temporarily unavailable.");
  }

  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) return authFailure(401, "AUTH_REQUIRED", "Sign in to edit pricing.");

  const parts = assertion.split(".");
  if (parts.length !== 3) return authFailure(401, "INVALID_TOKEN", "Your sign-in could not be verified.");

  let header;
  let claims;
  try {
    header = decodeJsonPart(parts[0]);
    claims = decodeJsonPart(parts[1]);
  } catch {
    return authFailure(401, "INVALID_TOKEN", "Your sign-in could not be verified.");
  }

  if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    return authFailure(401, "INVALID_TOKEN", "Your sign-in could not be verified.");
  }

  const teamDomain = String(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//i, "").replace(/\/$/, "");
  const issuer = `https://${teamDomain}`;
  const jwksUrl = env.ACCESS_JWKS_URL || `${issuer}/cdn-cgi/access/certs`;

  let keys;
  try {
    keys = await fetchJwks(jwksUrl);
    if (!keys.some((key) => key.kid === header.kid)) keys = await fetchJwks(jwksUrl, true);
  } catch {
    return authFailure(503, "AUTH_UNAVAILABLE", "Pricing access is temporarily unavailable.");
  }

  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) return authFailure(401, "INVALID_TOKEN", "Your sign-in could not be verified.");

  let validSignature = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1])
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) return authFailure(401, "INVALID_TOKEN", "Your sign-in could not be verified.");

  const now = Math.floor(Date.now() / 1000);
  const exp = Number(claims.exp);
  const nbf = claims.nbf == null ? null : Number(claims.nbf);
  if (!Number.isFinite(exp) || exp < now - CLOCK_SKEW_SECONDS) {
    return authFailure(401, "INVALID_TOKEN", "Your sign-in has expired.");
  }
  if (nbf != null && (!Number.isFinite(nbf) || nbf > now + CLOCK_SKEW_SECONDS)) {
    return authFailure(401, "INVALID_TOKEN", "Your sign-in could not be verified.");
  }
  if (claims.iss !== issuer || !audienceMatches(claims.aud, env.ACCESS_AUD)) {
    return authFailure(401, "INVALID_TOKEN", "Your sign-in could not be verified.");
  }

  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email) return authFailure(401, "INVALID_TOKEN", "Your sign-in could not be verified.");
  if (!isPricingEditor(email, env)) {
    return authFailure(403, "NOT_PRICING_EDITOR", "You don't have permission to edit prices.");
  }

  return { ok: true, email, local: false };
}
