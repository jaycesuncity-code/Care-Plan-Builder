// GET /api/pricing — public, read-only price feed for the Care Plan Builder.
// Cache API entries are per Cloudflare data center and cannot be purged globally,
// so an admin edit can take up to this TTL to become visible at every edge.

import { classifyOrigin, errorResponse } from "../../lib/intake/http.js";
import { loadPricing } from "../../lib/intake/pricing.js";

export const PRICING_CACHE_SECONDS = 300;
const PRICING_CACHE_KEY = "https://pricing-cache.invalid/care-plan-pricing-v1";

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
      "cache-control": cacheControl || "public, max-age=60, s-maxage=300",
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
      JSON.stringify({ error: { code: "PRICING_UNAVAILABLE", message: "Pricing is temporarily unavailable." } }),
      originInfo,
      { status: 503, cacheControl: "no-store" }
    );
  }

  try {
    const cache = caches.default;
    const cacheKey = new Request(PRICING_CACHE_KEY);
    const cached = await cache.match(cacheKey);
    if (cached) {
      return pricingResponse(await cached.text(), originInfo);
    }

    const pricing = await loadPricing(env.DB);
    const body = JSON.stringify(pricing);
    const cacheable = pricingResponse(body, { kind: "none", origin: null });
    await cache.put(cacheKey, cacheable.clone());
    return pricingResponse(body, originInfo);
  } catch {
    return pricingResponse(
      JSON.stringify({ error: { code: "PRICING_UNAVAILABLE", message: "Pricing is temporarily unavailable." } }),
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
