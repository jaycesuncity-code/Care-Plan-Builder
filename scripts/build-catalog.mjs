// Node 18+, zero dependencies. No production defaults or embedded catalog fallback.
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { catalogFromRows } from "../lib/intake/pricing.js";

async function build() {
  const args = process.argv.slice(2);
  let meta, items;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--fixture") throw new Error("Usage: build-catalog.mjs [--fixture <path>]");
    ({ meta, items } = JSON.parse(await readFile(args[1], "utf8")));
  } else {
    const names = ["CATALOG_EXPORT_URL", "CATALOG_EXPORT_TOKEN"];
    if (names.some(name => !process.env[name]?.trim())) throw new Error("Missing required build environment variables");
    const url = new URL(process.env.CATALOG_EXPORT_URL.trim());
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password)
      throw new Error("Catalog export URL must be HTTPS without embedded credentials");
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${process.env.CATALOG_EXPORT_TOKEN.trim()}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Catalog export request failed");
    ({ meta, items } = await response.json());
    if (!Array.isArray(items)) throw new Error("Catalog export response invalid");
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

build().catch(() => { console.error("Catalog build failed. Check build configuration, export Worker access and catalog validity."); process.exitCode = 1; });
