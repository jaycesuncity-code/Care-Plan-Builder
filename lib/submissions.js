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
    // Additive (same spirit as basePrice): the existing `addons` string array is
    // untouched, and this carries what a names-only list cannot — per-line total,
    // quantity, and whether the line is a real charge. The intake endpoint records
    // $0 lines for a plan's complimentary add-ons (included_free) and for add-ons
    // left over from a plan the customer switched away from (locked), so a
    // names-only list would read them as charges.
    addonDetail: addonRows.map((a) => ({
      name: a.addon_name,
      price: a.addon_price,
      quantity: a.quantity,
      includedFree: !!a.included_free,
      locked: !!a.locked,
    })),
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
