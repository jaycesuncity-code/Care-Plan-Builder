// Same-project fallback for missing static pages: GET/HEAD requests whose paths
// are not present in /public redirect to the equivalent public WordPress path.
// API routes are never redirected. This is not an authentication control.
// Retain the current behavior unless a separate routing change is approved.

const PRODUCTION_ORIGIN = "https://youknowsuncity.com";

export async function onRequest(context) {
  const res = await context.next();
  if (res.status !== 404) return res;

  const { request } = context;
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/")) return res;
  if (request.method !== "GET" && request.method !== "HEAD") return res;

  return Response.redirect(PRODUCTION_ORIGIN + url.pathname + url.search, 302);
}
