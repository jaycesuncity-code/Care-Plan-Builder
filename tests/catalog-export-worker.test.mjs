import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import worker from "../catalog-export-worker/index.js";
import { CATALOG_QUERIES, catalogFromRows } from "../lib/intake/pricing.js";
import { SqliteD1 } from "./sqlite-d1.mjs";

const TOKEN = "test-export-token";
const get = (headers = {}, method = "GET") => new Request("https://export.test/", { method, headers });
const authed = { Authorization: `Bearer ${TOKEN}` };
const snapshot = db => ({ version: db.version, items: db.items, audit: db.audit });

test("rejects missing, wrong, malformed and oversized credentials", async () => {
  const db = new SqliteD1();
  try {
    for (const headers of [{}, { Authorization: "Bearer nope" }, { Authorization: TOKEN },
      { Authorization: "Bearer " }, { Authorization: `Bearer ${"x".repeat(4097)}` }]) {
      const res = await worker.fetch(get(headers), { DB: db, CATALOG_EXPORT_TOKEN: TOKEN });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  } finally { db.close(); }
});

test("only GET is accepted", async () => {
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
    const res = await worker.fetch(get(authed, method), { CATALOG_EXPORT_TOKEN: TOKEN });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET");
  }
});

test("fails closed if secret or D1 binding is missing", async () => {
  assert.equal((await worker.fetch(get(authed), { DB: {} })).status, 503);
  assert.equal((await worker.fetch(get(authed), { CATALOG_EXPORT_TOKEN: TOKEN })).status, 503);
});

test("only two fixed SELECT statements run, producing a valid catalog with no writes", async () => {
  const db = new SqliteD1();
  try {
    const before = snapshot(db);
    const queries = [];
    const originalPrepare = db.prepare.bind(db);
    db.prepare = sql => { queries.push(sql); return originalPrepare(sql); };
    const res = await worker.fetch(get(authed), { DB: db, CATALOG_EXPORT_TOKEN: TOKEN });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(queries, CATALOG_QUERIES);
    assert.equal(queries.length, 2);
    assert.ok(queries.every(sql => /^\s*SELECT\b/i.test(sql)));
    const { meta, items } = await res.json();
    const catalog = catalogFromRows(meta, items);
    assert.equal(catalog.version, before.version);
    assert.ok(Object.keys(catalog.plans).length > 0);
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});

test("D1 failure and invalid result never leak database detail", async () => {
  for (const batch of [async () => { throw new Error("private database detail"); },
    async () => [{ success: true, results: [] }]]) {
    const db = { prepare: sql => ({ sql }), batch };
    const res = await worker.fetch(get(authed), { DB: db, CATALOG_EXPORT_TOKEN: TOKEN });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "catalog_unavailable" });
  }
});

test("build fails generically on missing config, HTTP and embedded credentials", () => {
  const run = env => spawnSync(process.execPath, ["scripts/build-catalog.mjs"], {
    encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH || "", ...env },
  });
  for (const values of [{},
    { CATALOG_EXPORT_URL: "http://export.test/", CATALOG_EXPORT_TOKEN: TOKEN },
    { CATALOG_EXPORT_URL: "https://user:pass@export.test/", CATALOG_EXPORT_TOKEN: TOKEN }]) {
    const result = run(values);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Catalog build failed/);
    assert.doesNotMatch(result.stderr, /test-export-token|user:pass|export\.test/);
  }
});
