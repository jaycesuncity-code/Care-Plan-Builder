// Shared helpers for the /api/submissions Pages Functions.
// Lives outside /functions so it is never picked up as a route itself.

export const STATUSES = ["New", "Contacted", "Signed Up", "Other"];

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function groupBy(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row[key];
    if (!out[k]) out[k] = [];
    out[k].push(row);
  }
  return out;
}

// Shapes one D1 submission row (+ its joined addon/note rows) into the
// exact JSON contract the frontend expects.
export function shapeSubmission(row, addonRows, noteRows) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    bestTime: row.best_time,
    plan: row.plan,
    addons: addonRows.map((a) => a.addon_name),
    basePrice: row.base_price,
    total: row.total_price,
    submittedAt: row.submitted_at,
    status: row.status,
    notes: noteRows.map((n) => ({
      status: n.status,
      text: n.note_text,
      timestamp: n.created_at,
    })),
  };
}

export const SUBMISSION_COLUMNS =
  "id, name, phone, address, best_time, plan, base_price, addon_total, total_price, status, submitted_at, updated_at";
