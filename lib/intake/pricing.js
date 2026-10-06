import { assertPriceMap, assertCatalogText } from "./catalog.js";

// One shape shared by live D1 reads and the static Pages build.
export const CATALOG_QUERIES = [
  "SELECT version, updated_at FROM pricing_meta WHERE id = 1",
  "SELECT id, kind, label, short_label, description, price FROM pricing_items ORDER BY id",
];

export function catalogFromRows(meta, rows) {
  if (!meta || !Number.isSafeInteger(meta.version) || meta.version < 1) throw new Error("catalog metadata missing");
  const catalog = { version: meta.version, updatedAt: meta.updated_at || null,
    plans: {}, addons: {}, text: { plans: {}, addons: {} } };
  const seen = new Set();
  for (const row of [...(rows || [])].sort((a,b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)) {
    if (!["plan", "addon"].includes(row.kind) || typeof row.id !== "string" ||
        !row.id.startsWith(row.kind + ":") || seen.has(row.id)) throw new Error("invalid catalog row");
    seen.add(row.id);
    const id = row.id.slice(row.kind.length + 1);
    const key = row.kind === "plan" ? "plans" : "addons";
    catalog[key][id] = row.price;
    catalog.text[key][id] = row.kind === "plan"
      ? { full: row.label, name: row.short_label, tagline: row.description }
      : { name: row.label, desc: row.description };
  }
  assertPriceMap(catalog);
  catalog.text = assertCatalogText(catalog.text);
  return catalog;
}

export async function loadCatalog(db) {
  const results = await db.batch(CATALOG_QUERIES.map(sql => db.prepare(sql)));
  if (results.some(result => result.success === false)) throw new Error("catalog query failed");
  return catalogFromRows((results[0].results || [])[0], results[1].results || []);
}

// Intake still loads D1 directly; no static or embedded fallback.
export const loadPricing = loadCatalog;
