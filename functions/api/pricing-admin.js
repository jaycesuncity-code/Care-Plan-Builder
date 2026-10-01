// Authenticated pricing editor API. This file belongs only in the gated dashboard
// project; the public intake project must never contain pricing write code.

import { authenticatePricingEditor } from "../../lib/admin/access.js";

export const PLAN_PRICE_MIN = 1;
export const PLAN_PRICE_MAX = 5000;
export const ADDON_PRICE_MIN = 0;
export const ADDON_PRICE_MAX = 2000;
export const MAX_CHANGES = 50;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function error(status, code, message, fieldErrors) {
  const body = { error: { code, message } };
  if (fieldErrors && Object.keys(fieldErrors).length) body.fieldErrors = fieldErrors;
  return json(body, status);
}

async function loadAdminData(db) {
  const [metaResult, itemsResult, auditResult] = await db.batch([
    db.prepare("SELECT version, updated_at FROM pricing_meta WHERE id = 1"),
    db.prepare(
      "SELECT id, kind, label, price, updated_at, updated_by FROM pricing_items ORDER BY kind DESC, label, id"
    ),
    db.prepare(
      "SELECT id, item_id, old_price, new_price, changed_by, changed_at FROM pricing_audit ORDER BY id DESC LIMIT 25"
    ),
  ]);
  const meta = (metaResult.results || [])[0];
  if (!meta) throw new Error("pricing metadata missing");
  return {
    version: Number(meta.version),
    updatedAt: meta.updated_at || null,
    items: itemsResult.results || [],
    audit: auditResult.results || [],
  };
}

async function authorize(request, env) {
  const auth = await authenticatePricingEditor(request, env);
  if (auth.ok) return auth;
  return { response: error(auth.status, auth.code, auth.message) };
}

function csrfAllowed(request) {
  if (request.headers.get("X-Requested-With") !== "pricing-admin") return false;
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

function validateChanges(body, data) {
  const fieldErrors = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, fieldErrors: { _form: "Malformed request body." } };
  }
  if (!Number.isInteger(body.expectedVersion)) fieldErrors.expectedVersion = "Expected version must be an integer.";

  const changes = body.changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    fieldErrors.changes = "Choose at least one price to change.";
    return { ok: false, fieldErrors };
  }
  if (changes.length > MAX_CHANGES) {
    fieldErrors.changes = `No more than ${MAX_CHANGES} prices can be changed at once.`;
    return { ok: false, fieldErrors };
  }

  const items = new Map(data.items.map((item) => [item.id, item]));
  const seen = new Set();
  const valid = [];
  changes.forEach((change, index) => {
    const prefix = `changes.${index}`;
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      fieldErrors[prefix] = "Malformed change.";
      return;
    }
    const id = typeof change.id === "string" ? change.id : "";
    if (!id || !items.has(id)) {
      fieldErrors[`${prefix}.id`] = "Unknown pricing item.";
      return;
    }
    if (seen.has(id)) {
      fieldErrors[`${prefix}.id`] = "Each pricing item can appear only once.";
      return;
    }
    seen.add(id);

    if (typeof change.price !== "number" || !Number.isInteger(change.price)) {
      fieldErrors[`${prefix}.price`] = "Price must be a whole-number dollar amount.";
      return;
    }

    const item = items.get(id);
    const min = item.kind === "plan" ? PLAN_PRICE_MIN : ADDON_PRICE_MIN;
    const max = item.kind === "plan" ? PLAN_PRICE_MAX : ADDON_PRICE_MAX;
    if (change.price < min || change.price > max) {
      fieldErrors[`${prefix}.price`] = `Price must be between $${min} and $${max}.`;
      return;
    }
    valid.push({ id, price: change.price, currentPrice: Number(item.price) });
  });

  return Object.keys(fieldErrors).length ? { ok: false, fieldErrors } : { ok: true, changes: valid };
}

async function currentConflict(db) {
  const current = await loadAdminData(db);
  return json(
    {
      error: { code: "VERSION_CONFLICT", message: "Someone else changed pricing. Reload the current values and review again." },
      ...current,
    },
    409
  );
}

export async function onRequestGet({ request, env }) {
  const auth = await authorize(request, env);
  if (auth.response) return auth.response;
  if (!env.DB) return error(503, "PRICING_UNAVAILABLE", "Pricing is temporarily unavailable.");

  try {
    return json(await loadAdminData(env.DB));
  } catch {
    return error(503, "PRICING_UNAVAILABLE", "Pricing is temporarily unavailable.");
  }
}

export async function onRequestPut({ request, env }) {
  const auth = await authorize(request, env);
  if (auth.response) return auth.response;
  if (!csrfAllowed(request)) return error(403, "REQUEST_NOT_ALLOWED", "This pricing request was not accepted.");
  if (!env.DB) return error(503, "PRICING_UNAVAILABLE", "Pricing is temporarily unavailable.");

  let body;
  try {
    body = await request.json();
  } catch {
    return error(400, "INVALID_JSON", "Could not read the pricing changes.");
  }

  let data;
  try {
    data = await loadAdminData(env.DB);
  } catch {
    return error(503, "PRICING_UNAVAILABLE", "Pricing is temporarily unavailable.");
  }

  const validated = validateChanges(body, data);
  if (!validated.ok) return error(400, "VALIDATION_FAILED", "Check the highlighted pricing changes.", validated.fieldErrors);
  if (body.expectedVersion !== data.version) return currentConflict(env.DB);

  const changed = validated.changes.filter((change) => change.price !== change.currentPrice);
  if (!changed.length) return json(data);

  const statements = [];
  for (const change of changed) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO pricing_audit (item_id, old_price, new_price, changed_by, changed_at)
         SELECT id, price, ?, ?, datetime('now') FROM pricing_items
          WHERE id = ? AND price <> ?
            AND (SELECT version FROM pricing_meta WHERE id = 1) = ?`
      ).bind(change.price, auth.email, change.id, change.price, body.expectedVersion)
    );
    statements.push(
      env.DB.prepare(
        `UPDATE pricing_items
            SET price = ?, updated_at = datetime('now'), updated_by = ?
          WHERE id = ? AND price <> ?
            AND (SELECT version FROM pricing_meta WHERE id = 1) = ?`
      ).bind(change.price, auth.email, change.id, change.price, body.expectedVersion)
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE pricing_meta
          SET version = version + 1, updated_at = datetime('now')
        WHERE id = 1 AND version = ?`
    ).bind(body.expectedVersion)
  );

  let results;
  try {
    results = await env.DB.batch(statements);
  } catch {
    return error(503, "PRICING_UNAVAILABLE", "Pricing could not be saved.");
  }

  const bump = results[results.length - 1];
  const bumpChanges = Number(bump && bump.meta && bump.meta.changes);
  if (!bumpChanges) {
    console.warn(`pricing-admin: lost race (count=${changed.length})`);
    return currentConflict(env.DB);
  }

  console.log(`pricing-admin: updated count=${changed.length} ids=${changed.map((change) => change.id).join(",")}`);
  try {
    return json(await loadAdminData(env.DB));
  } catch {
    return error(503, "PRICING_UNAVAILABLE", "Pricing was saved, but the latest values could not be reloaded.");
  }
}

export async function onRequest({ request, next }) {
  if (request.method === "GET" || request.method === "PUT") return next();
  return error(405, "METHOD_NOT_ALLOWED", "Use GET or PUT for pricing administration.");
}
