// Shared D1 pricing loader used by the public price feed and authoritative intake repricing.
// D1 stores prefixed ids; callers always receive maps keyed by the bare catalog ids.

function bareId(id, kind) {
  const prefix = kind + ":";
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

export async function loadPricing(db) {
  const [metaResult, itemsResult] = await db.batch([
    db.prepare("SELECT version, updated_at FROM pricing_meta WHERE id = 1"),
    db.prepare("SELECT id, kind, price FROM pricing_items ORDER BY id"),
  ]);

  const meta = (metaResult.results || [])[0];
  if (!meta || !Number.isInteger(Number(meta.version))) throw new Error("pricing metadata missing");

  const plans = {};
  const addons = {};
  for (const row of itemsResult.results || []) {
    const price = Number(row.price);
    if (!Number.isInteger(price) || price < 0) continue;
    if (row.kind === "plan") plans[bareId(String(row.id), "plan")] = price;
    else if (row.kind === "addon") addons[bareId(String(row.id), "addon")] = price;
  }

  return {
    version: Number(meta.version),
    updatedAt: meta.updated_at || null,
    plans,
    addons,
  };
}
