// GET /api/pricing — live D1 catalog for the gated staff Builder.
// WordPress uses static /catalog.json instead; intake always reads D1 directly.

import { classifyOrigin, errorResponse } from "../../lib/intake/http.js";
import { loadCatalog } from "../../lib/intake/pricing.js";

function publicCors(originInfo) {
  const headers = { Vary: "Origin" };
  if (originInfo.kind === "allowed") headers["Access-Control-Allow-Origin"] = originInfo.origin;
  return headers;
}

function pricingResponse(body, originInfo, { status = 200, cacheControl } = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": cacheControl || "no-store",
      ...publicCors(originInfo),
    },
  });
}

export async function onRequestOptions({ request, env }) {
  const originInfo = classifyOrigin(request, env);
  if (originInfo.kind === "denied") {
    return errorResponse({
      status: 403,
      code: "ORIGIN_NOT_ALLOWED",
      message: "This origin is not allowed to read pricing.",
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
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Max-Age": "86400",
          }
        : {}),
    },
  });
}

export async function onRequestGet({ request, env }) {
  const originInfo = classifyOrigin(request, env);
  if (originInfo.kind === "denied") {
    return errorResponse({
      status: 403,
      code: "ORIGIN_NOT_ALLOWED",
      message: "This origin is not allowed to read pricing.",
      originInfo,
    });
  }
  if (!env.DB) {
    return pricingResponse(
      JSON.stringify({ ok: false, code: "PRICING_UNAVAILABLE", error: "Current pricing is unavailable." }),
      originInfo,
      { status: 503, cacheControl: "no-store" }
    );
  }

  try {
    const catalog = await loadCatalog(env.DB);
    return pricingResponse(JSON.stringify(catalog), originInfo);
  } catch {
    return pricingResponse(
      JSON.stringify({ ok: false, code: "PRICING_UNAVAILABLE", error: "Current pricing is unavailable." }),
      originInfo,
      { status: 503, cacheControl: "no-store" }
    );
  }
}

export async function onRequest({ request, env, next }) {
  if (request.method === "GET" || request.method === "OPTIONS") return next();
  const originInfo = classifyOrigin(request, env);
  return errorResponse({
    status: 405,
    code: "METHOD_NOT_ALLOWED",
    message: "Use GET to read pricing.",
    originInfo,
    extraHeaders: { Allow: "GET, OPTIONS" },
  });
}
