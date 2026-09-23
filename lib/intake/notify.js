// Outbound notification to n8n, which sends the office email through
// Microsoft Outlook (Exchange Online). Cloudflare Email Service isn't an
// option here because youknowsuncity.com isn't on Cloudflare.
//
// The customer's submission is already committed to D1 before this runs. It is
// dispatched with context.waitUntil() and a short timeout, so an n8n outage,
// a paused workflow or a slow Microsoft Graph call can delay the office email
// but can never fail the customer's request.
//
// Payload contract is documented in n8n/care-plan-request-notification.json
// and SETUP.md. Auth is a shared secret in the X-Webhook-Secret header
// (n8n Header Auth credential).

export const NOTIFY_TIMEOUT_MS = 4000;

export function buildNotificationPayload({ submissionId, submissionNumber, customer, pricing, submittedAt, dashboardUrl }) {
  return {
    submissionId,
    submissionNumber,
    submittedAt,
    dashboardUrl: dashboardUrl || null,
    customer: {
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      bestTime: customer.bestTime,
    },
    plan: {
      id: pricing.planId,
      name: pricing.plan,
      basePrice: pricing.basePrice,
    },
    addons: pricing.lines.map((line) => ({
      id: line.id,
      name: line.name,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      lineTotal: line.lineTotal,
      includedFree: line.includedFree,
      locked: line.locked,
      billable: line.billable,
    })),
    totals: {
      basePrice: pricing.basePrice,
      addonTotal: pricing.addonTotal,
      total: pricing.total,
      monthlyEquivalent: pricing.monthlyEquivalent,
    },
  };
}

/**
 * Never throws and never rejects — the caller hands this to waitUntil().
 * Returns { ok, status? , reason? } for logging only.
 */
export async function notifyN8n({ env, payload, fetchImpl }) {
  const url = env.N8N_WEBHOOK_URL;
  if (!url) return { ok: false, reason: "no_webhook_url" };

  const doFetch = fetchImpl || fetch;
  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.N8N_WEBHOOK_SECRET ? { "X-Webhook-Secret": env.N8N_WEBHOOK_SECRET } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, status: response.status, reason: "webhook_http_error" };
    return { ok: true, status: response.status };
  } catch (err) {
    return { ok: false, reason: err && err.name === "TimeoutError" ? "webhook_timeout" : "webhook_unreachable" };
  }
}
