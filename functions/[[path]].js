// Sandbox fallback: a page-to-page link that isn't mirrored in this project yet
// (e.g. /member-rewards-program/) is sent to the same path on the live site,
// so no link in the sandbox dead-ends. Anything that IS a file in /public is
// served as normal, and /api/* is never redirected.
//
// Delete this file (and public/404.html) at launch.

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
