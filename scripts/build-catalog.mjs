// Node 18+, zero dependencies. No production defaults or embedded catalog fallback.
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CATALOG_QUERIES, catalogFromRows } from "../lib/intake/pricing.js";

async function build() {
  const args = process.argv.slice(2);
  let meta, items;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--fixture") throw new Error("Usage: build-catalog.mjs [--fixture <path>]");
    ({ meta, items } = JSON.parse(await readFile(args[1], "utf8")));
  } else {
    const names = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID"];
    if (names.some(name => !process.env[name]?.trim())) throw new Error("Missing required build environment variables");
    const account = encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID);
    const database = encodeURIComponent(process.env.D1_DATABASE_ID);
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
      method: "POST", headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      // Both SELECTs execute in one request, preserving a consistent version and item snapshot.
      body: JSON.stringify({ sql: CATALOG_QUERIES.join("; ") + ";", params: [] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("D1 HTTP query failed");
    const data = await response.json();
    if (!data.success || !Array.isArray(data.result) || data.result.length !== 2 || data.result.some(r => !r.success)) throw new Error("D1 query failed");
    meta = data.result[0].results[0]; items = data.result[1].results;
  }
  const catalog = catalogFromRows(meta, items);
  const dir = fileURLToPath(new URL("../public/", import.meta.url));
  const path = dir + "catalog.json", temporary = path + ".tmp";
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(catalog));
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  console.log(`Catalog version ${catalog.version}: ${Object.keys(catalog.plans).length} plans, ${Object.keys(catalog.addons).length} add-ons`);
}

build().catch(() => { console.error("Catalog build failed. Check build configuration, D1 access and catalog validity."); process.exitCode = 1; });
