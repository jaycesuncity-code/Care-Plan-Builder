import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { onRequestGet, onRequestOptions } from "../functions/api/pricing.js";

import { fixturePricing } from "./pricing-fixture.mjs";

class FakeStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; }
}
class FakeDb {
  constructor({ fail = false } = {}) {
    this.fail = fail;
    this.version = 3;
    const prices = fixturePricing();
    this.items = Object.entries(prices.plans).map(([id, price]) => ({ id: 'plan:' + id, kind: 'plan', price }))
      .concat(Object.entries(prices.addons).map(([id, price]) => ({ id: 'addon:' + id, kind: 'addon', price })));
  }
  prepare(sql) { return new FakeStatement(this, sql); }
  async batch(statements) {
    if (this.fail) throw new Error("D1 down");
    return statements.map((statement) =>
      statement.sql.includes("pricing_meta")
        ? { results: [{ version: this.version, updated_at: "2026-10-01 12:00:00" }] }
        : { results: this.items }
    );
  }
}

function makeCache() {
  const map = new Map();
  return {
    async match(request) {
      const cached = map.get(request.url);
      return cached ? cached.clone() : undefined;
    },
    async put(request, response) {
      map.set(request.url, response.clone());
    },
    size() { return map.size; },
  };
}

let cache;
beforeEach(() => {
  cache = makeCache();
  globalThis.caches = { default: cache };
});

const env = { ALLOWED_ORIGINS: "https://one.example,https://two.example" };

test("public pricing returns ids + integer prices only", async () => {
  const res = await onRequestGet({
    request: new Request("https://intake.example/api/pricing?ignored=1", { headers: { Origin: "https://one.example" } }),
    env: { ...env, DB: new FakeDb() },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://one.example");
  assert.equal(res.headers.get("cache-control"), "public, max-age=60, s-maxage=300");
  assert.deepEqual(await res.json(), {
    version: 3,
    updatedAt: "2026-10-01 12:00:00",
    plans: fixturePricing().plans,
    addons: fixturePricing().addons,
  });
});

test("one fixed cached body serves different query strings and allowed origins", async () => {
  const db = new FakeDb();
  const first = await onRequestGet({
    request: new Request("https://intake.example/api/pricing?a=1", { headers: { Origin: "https://one.example" } }),
    env: { ...env, DB: db },
  });
  assert.equal((await first.json()).plans.hvac, 260);
  db.items[0].price = 999;

  const second = await onRequestGet({
    request: new Request("https://intake.example/api/pricing?b=2", { headers: { Origin: "https://two.example" } }),
    env: { ...env, DB: db },
  });
  assert.equal((await second.json()).plans.hvac, 260);
  assert.equal(second.headers.get("access-control-allow-origin"), "https://two.example");
  assert.equal(cache.size(), 1);
});

test("denied pricing origin is rejected for GET and OPTIONS", async () => {
  const args = { request: new Request("https://intake.example/api/pricing", { headers: { Origin: "https://evil.example" } }), env: { ...env, DB: new FakeDb() } };
  const get = await onRequestGet(args);
  const preflight = await onRequestOptions({ ...args, request: new Request("https://intake.example/api/pricing", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }) });
  assert.equal(get.status, 403);
  assert.equal(preflight.status, 403);
  assert.equal(get.headers.get("access-control-allow-origin"), null);
});

test("D1 failure returns 503 no-store and is never cached", async () => {
  const res = await onRequestGet({
    request: new Request("https://intake.example/api/pricing"),
    env: { ...env, DB: new FakeDb({ fail: true }) },
  });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(cache.size(), 0);
});

for (const issue of ['missing-plan', 'missing-addon', 'invalid-plan', 'invalid-addon', 'invalid-version']) {
  test(`public pricing rejects ${issue} without caching`, async () => {
    const db = new FakeDb();
    if (issue === 'invalid-version') db.version = null;
    else {
      const kind = issue.endsWith('plan') ? 'plan' : 'addon';
      const index = db.items.findIndex(row => row.kind === kind);
      if (issue.startsWith('missing')) db.items.splice(index, 1);
      else db.items[index].price = null;
    }
    const res = await onRequestGet({ request: new Request('https://intake.example/api/pricing'), env: { ...env, DB: db } });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'PRICING_UNAVAILABLE');
    assert.equal(cache.size(), 0);
  });
}
