// Cloudflare Turnstile server-side verification.
//
// A token is single-use and expires in about 5 minutes, so the only sane place
// to spend it is right here, once, per submission. The builder renders the
// widget explicitly when the lead modal opens (the modal starts hidden, so an
// implicit render would run against a display:none container) and resets it
// whenever this call fails.
//
// Sandbox keys (always pass / always fail / already spent) are documented at
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const SITEVERIFY_TIMEOUT_MS = 5000;

/**
 * Returns { success: true } or { success: false, reason, codes }.
 * `reason` is for logs only — the customer gets a generic message.
 */
export async function verifyTurnstile({ token, secret, remoteIp, endpoint, fetchImpl }) {
  if (!secret) return { success: false, reason: "missing_secret", codes: [] };

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteIp) form.append("remoteip", remoteIp);

  const doFetch = fetchImpl || fetch;
  let response;
  try {
    response = await doFetch(endpoint || SITEVERIFY_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
  } catch {
    // Network error or timeout talking to Cloudflare. Fail closed: this is the
    // only thing standing between the office inbox and a bot.
    return { success: false, reason: "siteverify_unreachable", codes: [] };
  }

  if (!response.ok) return { success: false, reason: `siteverify_http_${response.status}`, codes: [] };

  let result;
  try {
    result = await response.json();
  } catch {
    return { success: false, reason: "siteverify_bad_json", codes: [] };
  }

  if (result && result.success === true) return { success: true, codes: [] };

  const codes = Array.isArray(result && result["error-codes"]) ? result["error-codes"] : [];
  return { success: false, reason: "rejected", codes };
}
