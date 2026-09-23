// POST /api/care-plan-request   — public Care Plan Builder intake
// OPTIONS /api/care-plan-request — CORS preflight
//
// SELF-CONTAINED ON PURPOSE. At launch this file and lib/intake/* move to a
// separate PUBLIC Pages project (no Cloudflare Access) bound to the same D1
// database, while the staff dashboard stays behind Access + Entra ID. So:
//   - nothing here imports the Access middleware
//   - nothing here reads context.data.staffEmail
//   - every knob comes from env
//
// ORDER OF CHECKS — cheapest and most private first, so a bot or a fat-fingered
// form never costs a D1 query, an outbound round-trip, or a rate-limit slot:
//   1. method + CORS origin        (no I/O; a denied origin stops here, 403)
//   2. body size + JSON parse      (no I/O; 413 / 400)
//   3. field validation            (no I/O; 400 with fieldErrors)
//   4. rate limit, read-only       (1 D1 read; 429 + Retry-After)
//   5. Turnstile siteverify        (1 outbound fetch; 403)
//   6. server-side repricing       (catalog only; client prices are ignored)
//   7. INSERT submission + add-ons (D1 write; 500 on failure)
//   8. record the rate-limit hit   (only successful submissions count)
//   9. 201, then n8n notify via waitUntil (never affects the response)
//
// Logging rule: no names, phones or addresses, ever. Logs carry the submission
// id, counts and failure reasons — enough to debug, nothing to leak.

import { classifyOrigin, errorResponse, json } from "../../lib/intake/http.js";
import { MAX_BODY_BYTES, validateIntake } from "../../lib/intake/validate.js";
import { priceSelection } from "../../lib/intake/catalog.js";
import { checkRateLimit, getClientIp, hashIp, rateLimitConfig, recordHit } from "../../lib/intake/ratelimit.js";
import { verifyTurnstile } from "../../lib/intake/turnstile.js";
import { insertSubmission, submissionNumber } from "../../lib/intake/persist.js";
import { buildNotificationPayload, notifyN8n } from "../../lib/intake/notify.js";

export async function onRequestOptions({ request, env }) {
  const originInfo = classifyOrigin(request, env);
  if (originInfo.kind === "denied") {
    // No CORS headers on a denied preflight — the browser must not proceed.
    return errorResponse({
      status: 403,
      code: "ORIGIN_NOT_ALLOWED",
      message: "This origin is not allowed to submit requests.",
      originInfo,
    });
  }
  return new Response(null, {
    status: 204,
    headers: {
      Vary: "Origin",
      ...(originInfo.kind === "allowed"
        ? {
            "Access-Control-Allow-Origin": originInfo.origin,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
          }
        : {}),
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // --- 1. CORS ---------------------------------------------------------------
  const originInfo = classifyOrigin(request, env);
  if (originInfo.kind === "denied") {
    return errorResponse({
      status: 403,
      code: "ORIGIN_NOT_ALLOWED",
      message: "This origin is not allowed to submit requests.",
      originInfo,
    });
  }

  // --- 2. body ---------------------------------------------------------------
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return errorResponse({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "That request was too large.",
      originInfo,
    });
  }

  let raw;
  try {
    raw = await request.text();
  } catch {
    return errorResponse({ status: 400, code: "BAD_REQUEST", message: "Could not read the request.", originInfo });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return errorResponse({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "That request was too large.",
      originInfo,
    });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return errorResponse({ status: 400, code: "INVALID_JSON", message: "Could not read the request.", originInfo });
  }

  // --- 3. field validation ---------------------------------------------------
  const validated = validateIntake(body);
  if (!validated.ok) {
    return errorResponse({
      status: 400,
      code: "VALIDATION_FAILED",
      message: "Please check the highlighted fields and try again.",
      fieldErrors: validated.fieldErrors,
      originInfo,
    });
  }
  const input = validated.value;

  if (!env.DB) {
    console.error("care-plan-request: DB binding missing");
    return errorResponse({
      status: 500,
      code: "SERVER_ERROR",
      message: "We could not save your request. Please try again or call us.",
      originInfo,
    });
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  const clientIp = getClientIp(request);
  const limits = rateLimitConfig(env);

  // --- 4. rate limit (read-only; the hit is recorded after success) ----------
  let ipHash = null;
  try {
    ipHash = await hashIp(clientIp, env.IP_HASH_SALT);
    const verdict = await checkRateLimit(env.DB, ipHash, nowEpoch, limits);
    if (!verdict.allowed) {
      console.warn(`care-plan-request: rate limited (hits=${verdict.hits})`);
      return errorResponse({
        status: 429,
        code: "RATE_LIMITED",
        message: "You have sent several requests already. Please wait a few minutes, or call our office at 575-526-9758.",
        originInfo,
        extraHeaders: { "Retry-After": String(verdict.retryAfterSeconds) },
      });
    }
  } catch (err) {
    // A rate-limit table problem must not take the form down; a lead is worth
    // more than a counter. Logged and allowed through.
    console.error("care-plan-request: rate limit check failed:", err && err.message);
  }

  // --- 5. Turnstile ----------------------------------------------------------
  const turnstile = await verifyTurnstile({
    token: input.turnstileToken,
    secret: env.TURNSTILE_SECRET,
    remoteIp: clientIp || undefined,
    endpoint: env.TURNSTILE_VERIFY_URL, // test-only override; unset in production
  });
  if (!turnstile.success) {
    console.warn(`care-plan-request: turnstile rejected (${turnstile.reason} ${turnstile.codes.join(",")})`);
    return errorResponse({
      status: 403,
      code: "TURNSTILE_FAILED",
      message: "The verification check did not pass. Please try it again.",
      fieldErrors: { turnstileToken: "Please complete the verification check again." },
      originInfo,
    });
  }

  // --- 6. repricing (the client's basePrice/total/unitPrice are never read) --
  let pricing;
  try {
    pricing = priceSelection(input.planId, input.addons);
  } catch (err) {
    console.warn("care-plan-request: pricing rejected:", err && err.message);
    return errorResponse({
      status: 400,
      code: "VALIDATION_FAILED",
      message: "Please check the highlighted fields and try again.",
      fieldErrors: { addons: "One of the selected add-ons is no longer available." },
      originInfo,
    });
  }

  // Drift detector. The server's numbers win regardless; a mismatch means the
  // builder and lib/intake/catalog.js disagree (or someone edited the payload),
  // and it is worth seeing in the logs. No PII.
  if (Number(body.total) !== pricing.total || Number(body.basePrice) !== pricing.basePrice) {
    console.warn(
      `care-plan-request: client/server price mismatch (client=${Number(body.total) || 0}/${Number(body.basePrice) || 0} server=${pricing.total}/${pricing.basePrice} plan=${pricing.planId})`
    );
  }

  // --- 7. persist ------------------------------------------------------------
  const submittedAt = new Date().toISOString(); // the client's submittedAt is ignored
  let submissionId;
  try {
    submissionId = await insertSubmission(env.DB, {
      customer: { name: input.name, phone: input.phone, address: input.address, bestTime: input.bestTime },
      pricing,
      submittedAt,
    });
  } catch (err) {
    console.error("care-plan-request: insert failed:", err && err.message);
    return errorResponse({
      status: 500,
      code: "SERVER_ERROR",
      message: "We could not save your request. Please try again or call us at 575-526-9758.",
      originInfo,
    });
  }

  const number = submissionNumber(submissionId);
  console.log(
    `care-plan-request: saved id=${submissionId} plan=${pricing.planId} addonLines=${pricing.lines.length} total=${pricing.total}`
  );

  // --- 8. count this successful submission toward the window ----------------
  if (ipHash) {
    try {
      await recordHit(env.DB, ipHash, nowEpoch);
    } catch (err) {
      console.error("care-plan-request: rate limit record failed:", err && err.message);
    }
  }

  // --- 9. notify the office, out of band ------------------------------------
  const notification = buildNotificationPayload({
    submissionId,
    submissionNumber: number,
    customer: { name: input.name, phone: input.phone, address: input.address, bestTime: input.bestTime },
    pricing,
    submittedAt,
    dashboardUrl: env.DASHBOARD_URL,
  });

  const dispatch = notifyN8n({ env, payload: notification }).then((result) => {
    if (!result.ok) {
      console.error(`care-plan-request: office notification failed for id=${submissionId} (${result.reason || result.status})`);
    }
  });
  if (context.waitUntil) context.waitUntil(dispatch);

  return json(
    {
      ok: true,
      submissionId,
      submissionNumber: number,
      plan: pricing.plan,
      basePrice: pricing.basePrice,
      addonTotal: pricing.addonTotal,
      total: pricing.total,
      submittedAt,
    },
    { status: 201, originInfo }
  );
}

// Anything other than POST/OPTIONS on this route.
export async function onRequest({ request, env, next }) {
  if (request.method === "POST" || request.method === "OPTIONS") return next();
  const originInfo = classifyOrigin(request, env);
  return errorResponse({
    status: 405,
    code: "METHOD_NOT_ALLOWED",
    message: "Use POST to submit a Care Plan request.",
    originInfo,
    extraHeaders: { Allow: "POST, OPTIONS" },
  });
}
