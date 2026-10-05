import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { authenticatePricingEditor } from "../lib/admin/access.js";
import { onRequestGet, onRequestPut } from "../functions/api/pricing-admin.js";

const MOCK_PORT = 8800;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
let mockProcess;

async function waitForMock() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(MOCK_BASE + "/access/jwks");
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("mock JWKS server did not start");
}

before(async () => {
  mockProcess = spawn("node", ["tests/mock-services.mjs", String(MOCK_PORT)], {
    stdio: "ignore",
    detached: true,
  });
  await waitForMock();
});

after(() => {
  try { process.kill(-mockProcess.pid, "SIGKILL"); } catch {}
});

const authEnv = {
  PRICING_EDITORS: "editor@example.com",
  ACCESS_TEAM_DOMAIN: "access.example.com",
  ACCESS_AUD: "pricing-aud",
  ACCESS_JWKS_URL: MOCK_BASE + "/access/jwks",
};

async function token(params = {}) {
  const url = new URL(MOCK_BASE + "/_mock/access-token");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return (await (await fetch(url)).json()).token;
}

function authRequest(jwt, url = "https://dashboard.example.com/api/pricing-admin") {
  return new Request(url, { headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {} });
}

test("admin auth fails closed for missing config and missing JWT", async () => {
  let result = await authenticatePricingEditor(authRequest(null), {});
  assert.equal(result.status, 503);
  result = await authenticatePricingEditor(authRequest(null), authEnv);
  assert.equal(result.status, 401);

  const domainOnlyEnv = { ...authEnv };
  delete domainOnlyEnv.PRICING_EDITORS;
  result = await authenticatePricingEditor(authRequest(null), domainOnlyEnv);
  assert.equal(result.status, 401);
});

test("admin auth rejects invalid algorithms, signatures, timing, aud and kid", async () => {
  assert.equal((await authenticatePricingEditor(authRequest(await token({ alg: "none" })), authEnv)).status, 401);
  assert.equal((await authenticatePricingEditor(authRequest(await token({ alg: "HS256" })), authEnv)).status, 401);

  const good = await token();
  const badSignature = good.slice(0, -2) + (good.endsWith("aa") ? "bb" : "aa");
  assert.equal((await authenticatePricingEditor(authRequest(badSignature), authEnv)).status, 401);
  assert.equal((await authenticatePricingEditor(authRequest(await token({ expOffset: -300 })), authEnv)).status, 401);
  assert.equal((await authenticatePricingEditor(authRequest(await token({ nbfOffset: 300 })), authEnv)).status, 401);
  assert.equal((await authenticatePricingEditor(authRequest(await token({ aud: "wrong-aud" })), authEnv)).status, 401);
  assert.equal((await authenticatePricingEditor(authRequest(await token({ kid: "unknown-key" })), authEnv)).status, 401);
});

test("admin auth distinguishes a valid non-editor from an editor", async () => {
  const nonEditor = await authenticatePricingEditor(authRequest(await token({ email: "other@example.com" })), authEnv);
  assert.equal(nonEditor.status, 403);
  const editor = await authenticatePricingEditor(authRequest(await token({ email: "EDITOR@example.com" })), authEnv);
  assert.equal(editor.ok, true);
  assert.equal(editor.email, "editor@example.com");
});

test("company-domain emails may edit without being on PRICING_EDITORS", async () => {
  const env = { ...authEnv };
  delete env.PRICING_EDITORS;
  const staff = await authenticatePricingEditor(authRequest(await token({ email: "Anyone.New@SunCityLC.com" })), env);
  assert.equal(staff.ok, true);
  assert.equal(staff.email, "anyone.new@suncitylc.com");
});

test("domain rule is an exact match and rejects lookalikes and subdomains", async () => {
  for (const email of [
    "x@evilsuncitylc.com",
    "x@suncitylc.com.evil.com",
    "x@mail.suncitylc.com",
    "x@suncitylc.co",
    "suncitylc.com@gmail.com",
    "a@b@suncitylc.com",
    "@suncitylc.com",
  ]) {
    const result = await authenticatePricingEditor(authRequest(await token({ email })), authEnv);
    assert.equal(result.ok, false, email);
    assert.equal(result.status, 403, email);
  }
});

test("PRICING_EDITORS still allows named outside emails", async () => {
  const outside = await authenticatePricingEditor(authRequest(await token({ email: "editor@example.com" })), authEnv);
  assert.equal(outside.ok, true);
});

test("DEV_ADMIN_EMAIL bypass works only on localhost", async () => {
  const local = await authenticatePricingEditor(
    authRequest(null, "http://localhost/api/pricing-admin"),
    { DEV_ADMIN_EMAIL: "local@example.com" }
  );
  assert.equal(local.ok, true);
  const remote = await authenticatePricingEditor(
    authRequest(null, "https://dashboard.example.com/api/pricing-admin"),
    { DEV_ADMIN_EMAIL: "local@example.com" }
  );
  assert.equal(remote.status, 503);
});

class Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.db, this.sql, args); }
}

class FakeDb {
  constructor() {
    this.version = 1;
    this.updatedAt = null;
    this.items = [
      { id: "plan:hvac", kind: "plan", label: "HVAC Care Plan", price: 260, updated_at: null, updated_by: null },
      { id: "plan:premier", kind: "plan", label: "Premier Care Plan", price: 600, updated_at: null, updated_by: null },
      { id: "addon:qfc", kind: "addon", label: "Quarterly Filter Change", price: 120, updated_at: null, updated_by: null },
    ];
    this.audit = [];
    this.raceOnNextWriteBatch = false;
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    const readsOnly = statements.every((statement) => /^\s*SELECT/i.test(statement.sql));
    if (!readsOnly && this.raceOnNextWriteBatch) {
      this.version += 1; // another editor wins after the endpoint pre-check
      this.raceOnNextWriteBatch = false;
    }
    const results = [];
    for (const statement of statements) {
      const sql = statement.sql.trim();
      if (/^SELECT version/i.test(sql)) {
        results.push({ results: [{ version: this.version, updated_at: this.updatedAt }] });
      } else if (/^SELECT id, kind, label/i.test(sql)) {
        results.push({ results: this.items.map((item) => ({ ...item })) });
      } else if (/^SELECT id, item_id/i.test(sql)) {
        results.push({ results: this.audit.slice().reverse().slice(0, 25) });
      } else if (/^INSERT INTO pricing_audit/i.test(sql)) {
        const [newPrice, changedBy, id, sameNewPrice, expectedVersion] = statement.args;
        const item = this.items.find((row) => row.id === id);
        let changes = 0;
        if (item && this.version === expectedVersion && item.price !== sameNewPrice) {
          this.audit.push({
            id: this.audit.length + 1,
            item_id: id,
            old_price: item.price,
            new_price: newPrice,
            changed_by: changedBy,
            changed_at: "2026-10-01 12:00:00",
          });
          changes = 1;
        }
        results.push({ results: [], meta: { changes } });
      } else if (/^UPDATE pricing_items/i.test(sql)) {
        const [newPrice, changedBy, id, sameNewPrice, expectedVersion] = statement.args;
        const item = this.items.find((row) => row.id === id);
        let changes = 0;
        if (item && this.version === expectedVersion && item.price !== sameNewPrice) {
          item.price = newPrice;
          item.updated_by = changedBy;
          item.updated_at = "2026-10-01 12:00:00";
          changes = 1;
        }
        results.push({ results: [], meta: { changes } });
      } else if (/^UPDATE pricing_meta/i.test(sql)) {
        const [expectedVersion] = statement.args;
        let changes = 0;
        if (this.version === expectedVersion) {
          this.version += 1;
          this.updatedAt = "2026-10-01 12:00:00";
          changes = 1;
        }
        results.push({ results: [], meta: { changes } });
      } else {
        throw new Error("Unhandled fake SQL: " + sql);
      }
    }
    return results;
  }
}

const localEnv = (db) => ({ DB: db, DEV_ADMIN_EMAIL: "editor@example.com" });
function putRequest(body, headers = {}) {
  return new Request("http://localhost/api/pricing-admin", {
    method: "PUT",
    headers: { "content-type": "application/json", "X-Requested-With": "pricing-admin", ...headers },
    body: JSON.stringify(body),
  });
}
async function put(db, body, headers) {
  return onRequestPut({ request: putRequest(body, headers), env: localEnv(db) });
}

test("admin GET returns items, version and at most recent audit data", async () => {
  const db = new FakeDb();
  const res = await onRequestGet({ request: new Request("http://localhost/api/pricing-admin"), env: localEnv(db) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version, 1);
  assert.equal(body.items.length, 3);
  assert.deepEqual(body.audit, []);
});

test("admin PUT rejects malformed and out-of-bounds changes without writes", async () => {
  const invalidBodies = [
    { expectedVersion: 1, changes: [] },
    { expectedVersion: 1, changes: [{ id: "addon:qfc", price: 1.5 }] },
    { expectedVersion: 1, changes: [{ id: "addon:qfc", price: -1 }] },
    { expectedVersion: 1, changes: [{ id: "addon:qfc", price: 2001 }] },
    { expectedVersion: 1, changes: [{ id: "plan:hvac", price: 0 }] },
    { expectedVersion: 1, changes: [{ id: "plan:hvac", price: 5001 }] },
    { expectedVersion: 1, changes: [{ id: "missing", price: 10 }] },
    { expectedVersion: 1, changes: [{ id: "addon:qfc", price: 121 }, { id: "addon:qfc", price: 122 }] },
    { expectedVersion: 1, changes: Array.from({ length: 51 }, (_, i) => ({ id: "addon:qfc", price: 120 + i })) },
  ];
  for (const body of invalidBodies) {
    const db = new FakeDb();
    const res = await put(db, body);
    assert.equal(res.status, 400);
    assert.equal(db.version, 1);
    assert.equal(db.items.find((item) => item.id === "addon:qfc").price, 120);
    assert.equal(db.audit.length, 0);
  }
});

test("admin PUT enforces CSRF header and same-origin Origin", async () => {
  let db = new FakeDb();
  let req = new Request("http://localhost/api/pricing-admin", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: 1, changes: [{ id: "addon:qfc", price: 130 }] }),
  });
  assert.equal((await onRequestPut({ request: req, env: localEnv(db) })).status, 403);

  db = new FakeDb();
  const foreign = await put(db, { expectedVersion: 1, changes: [{ id: "addon:qfc", price: 130 }] }, { Origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  assert.equal(db.version, 1);
});

test("stale pre-check returns 409 and writes nothing", async () => {
  const db = new FakeDb();
  db.version = 2;
  const res = await put(db, { expectedVersion: 1, changes: [{ id: "addon:qfc", price: 130 }] });
  assert.equal(res.status, 409);
  assert.equal(db.items.find((item) => item.id === "addon:qfc").price, 120);
  assert.equal(db.audit.length, 0);
});

test("successful PUT writes audit old price, item and one version bump", async () => {
  const db = new FakeDb();
  const res = await put(db, { expectedVersion: 1, changes: [{ id: "addon:qfc", price: 135 }] });
  assert.equal(res.status, 200);
  assert.equal(db.version, 2);
  assert.equal(db.items.find((item) => item.id === "addon:qfc").price, 135);
  assert.equal(db.audit.length, 1);
  assert.equal(db.audit[0].old_price, 120);
  assert.equal(db.audit[0].new_price, 135);
});

test("no-op PUT does not bump version or write audit", async () => {
  const db = new FakeDb();
  const res = await put(db, { expectedVersion: 1, changes: [{ id: "addon:qfc", price: 120 }] });
  assert.equal(res.status, 200);
  assert.equal(db.version, 1);
  assert.equal(db.audit.length, 0);
});

test("lost race returns 409 with guarded item and audit writes untouched", async () => {
  const db = new FakeDb();
  db.raceOnNextWriteBatch = true;
  const res = await put(db, { expectedVersion: 1, changes: [{ id: "addon:qfc", price: 135 }] });
  assert.equal(res.status, 409);
  assert.equal(db.version, 2);
  assert.equal(db.items.find((item) => item.id === "addon:qfc").price, 120);
  assert.equal(db.audit.length, 0);
});
