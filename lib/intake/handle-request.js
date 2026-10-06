// Shared Care Plan intake pipeline for both server-classified submission modes.
// Route wrappers pass the trusted isTest boolean; request JSON/query/browser state never does.

import { classifyOrigin, errorResponse, json } from "./http.js";
import { MAX_BODY_BYTES, validateIntake } from "./validate.js";
import { priceSelection } from "./catalog.js";
import { loadPricing } from "./pricing.js";
import { checkRateLimit, getClientIp, hashIp, rateLimitConfig, recordHit } from "./ratelimit.js";
import { verifyTurnstile } from "./turnstile.js";
import { insertSubmission, submissionNumber } from "./persist.js";
import { buildNotificationPayload, notifyN8n } from "./notify.js";

export async function handleCarePlanOptions({ request, env }) {
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

export async function handleCarePlanRequest(context, { isTest }) {
  const { request, env } = context;

  // Trusted classification comes only from the route wrapper.
  const originInfo = classifyOrigin(request, env);
  if (typeof isTest !== "boolean") {
    console.error("care-plan-request: server classification missing");
    return errorResponse({
      status: 500,
      code: "SERVER_ERROR",
      message: "We could not process your request. Please try again or call us at 575-526-9758.",
      originInfo,
    });
  }

  // --- 1. CORS ---------------------------------------------------------------
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

  // A request without a successfully loaded pricing version must be reviewed first.
  if (!Number.isSafeInteger(input.pricingVersion) || input.pricingVersion < 1) {
    return errorResponse({
      status: 503,
      code: "PRICING_UNAVAILABLE",
      message: "Current pricing is unavailable.",
      originInfo,
    });
  }

  if (!env.DB) {
    console.error("care-plan-request: DB binding missing");
    return errorResponse({
      status: 503,
      code: "PRICING_UNAVAILABLE",
      message: "Current pricing is unavailable.",
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

  // --- 6. repricing (authoritative D1 prices; client prices are never trusted) --
  let pricing;
  let currentPricing;
  try {
    currentPricing = await loadPricing(env.DB);
    pricing = priceSelection(input.planId, input.addons, currentPricing);
  } catch (err) {
    console.error("care-plan-request: pricing load/reprice failed");
    return errorResponse({
      status: 503,
      code: "PRICING_UNAVAILABLE",
      message: "Current pricing is unavailable.",
      originInfo,
    });
  }

  // If the Builder priced against an older D1 version AND that actually changes
  // the displayed total, stop before writing anything so the customer can review
  // the new amount. A version change with an identical total is harmless.
  if (
    typeof input.pricingVersion === "number" &&
    input.pricingVersion !== currentPricing.version &&
    Number(body.total) !== pricing.total
  ) {
    return json(
      {
        error: {
          code: "PRICES_CHANGED",
          message: "Our prices were just updated. Please review your updated total, then send again.",
        },
        pricing: currentPricing,
      },
      { status: 409, originInfo }
    );
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
      isTest,
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
    `care-plan-request: saved id=${submissionId} mode=${isTest ? "test" : "live"} plan=${pricing.planId} addonLines=${pricing.lines.length} total=${pricing.total}`
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
    isTest,
  });

  const dispatch = notifyN8n({ env, payload: notification, isTest }).then((result) => {
    if (result.skipped) {
      console.log(`care-plan-request: office notification suppressed for test id=${submissionId}`);
      return;
    }
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
export async function handleCarePlanMethod({ request, env, next }) {
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
