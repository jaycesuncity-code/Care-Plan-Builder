import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const builder = readFileSync(join(here, "..", "public", "careplan-builder", "index.html"), "utf8");

function extractArray(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `missing ${declaration}`);
  const open = source.indexOf("[", start);
  let depth = 0, quote = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "[") depth += 1;
    if (ch === "]" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error("unterminated array");
}

function extractFunction(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `missing function ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0, quote = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth += 1;
    if (ch === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("unterminated function");
}

const planLiteral = extractArray(builder, "var PLANS");
const groupLiteral = extractArray(builder, "var ADDON_GROUPS");
const applySource = extractFunction(builder, "applyPricingPayload");

function harness() {
  return new Function(`
    var PLANS = ${planLiteral};
    var ADDON_GROUPS = ${groupLiteral};
    var ADDON_INDEX = {};
    ADDON_GROUPS.forEach(function(g){ g.items.forEach(function(a){ ADDON_INDEX[a.id] = a; }); });
    var pricingVersion = null;
    ${applySource}
    return {
      plans: PLANS,
      groups: ADDON_GROUPS,
      apply: applyPricingPayload,
      version: function(){ return pricingVersion; }
    };
  `)();
}

function fullPayload(h, version = 9) {
  const plans = {}, addons = {};
  h.plans.forEach((plan) => { plans[plan.id] = plan.price + 10; });
  h.groups.forEach((group) => group.items.forEach((addon) => { addons[addon.id] = addon.price + 5; }));
  return { version, updatedAt: null, plans, addons };
}

function snapshotCatalog(h) {
  return {
    plans: Object.fromEntries(h.plans.map((plan) => [plan.id, plan.price])),
    addons: Object.fromEntries(
      h.groups.flatMap((group) => group.items.map((addon) => [addon.id, addon.price]))
    ),
    version: h.version(),
  };
}

function assertCatalogUnchanged(h, before) {
  assert.deepEqual(snapshotCatalog(h), before);
}

test("Builder applies a complete sane pricing payload atomically and ignores unknown extras", () => {
  const h = harness();
  const payload = fullPayload(h, 9);
  payload.plans.unknown = 9999;
  payload.addons.unknown = 9999;

  assert.equal(h.apply(payload), true);
  assert.equal(h.version(), 9);

  h.plans.forEach((plan) => {
    assert.equal(plan.price, payload.plans[plan.id], `plan ${plan.id} did not update`);
  });
  h.groups.forEach((group) => group.items.forEach((addon) => {
    assert.equal(addon.price, payload.addons[addon.id], `add-on ${addon.id} did not update`);
  }));
  assert.equal(h.plans.some((plan) => plan.id === "unknown"), false);
});

test("Builder rejects a malformed known plan without changing any prices or version", () => {
  const h = harness();
  const before = snapshotCatalog(h);
  const payload = fullPayload(h, 10);
  payload.plans.premier = null;

  assert.equal(h.apply(payload), false);
  assertCatalogUnchanged(h, before);
});

test("Builder rejects a malformed known add-on without changing any prices or version", () => {
  const h = harness();
  const before = snapshotCatalog(h);
  const payload = fullPayload(h, 10);
  payload.addons.qfc = "125";

  assert.equal(h.apply(payload), false);
  assertCatalogUnchanged(h, before);
});

test("Builder rejects a missing known plan without changing any prices or version", () => {
  const h = harness();
  const before = snapshotCatalog(h);
  const payload = fullPayload(h, 10);
  delete payload.plans.bundled;

  assert.equal(h.apply(payload), false);
  assertCatalogUnchanged(h, before);
});

test("Builder rejects a missing known add-on without changing any prices or version", () => {
  const h = harness();
  const before = snapshotCatalog(h);
  const payload = fullPayload(h, 10);
  delete payload.addons.mst;

  assert.equal(h.apply(payload), false);
  assertCatalogUnchanged(h, before);
});

test("Builder rejects out-of-range known prices atomically", () => {
  const cases = [
    { label: "plan below minimum", mutate: (payload) => { payload.plans.hvac = 0; } },
    { label: "plan above maximum", mutate: (payload) => { payload.plans.hvac = 5001; } },
    { label: "add-on below minimum", mutate: (payload) => { payload.addons.qfc = -1; } },
    { label: "add-on above maximum", mutate: (payload) => { payload.addons.qfc = 2001; } },
  ];

  for (const entry of cases) {
    const h = harness();
    const before = snapshotCatalog(h);
    const payload = fullPayload(h, 11);
    entry.mutate(payload);

    assert.equal(h.apply(payload), false, entry.label);
    assertCatalogUnchanged(h, before);
  }
});

test("Builder validates the full catalog before mutating earlier valid entries", () => {
  const h = harness();
  const before = snapshotCatalog(h);
  const payload = fullPayload(h, 12);
  const addons = h.groups.flatMap((group) => group.items);
  const lastAddon = addons[addons.length - 1];

  payload.addons[lastAddon.id] = "bad";

  assert.equal(h.apply(payload), false);
  assertCatalogUnchanged(h, before);
});

test("Builder keeps the previous pricing version and catalog when a later payload is invalid", () => {
  const h = harness();
  assert.equal(h.apply(fullPayload(h, 8)), true);
  const before = snapshotCatalog(h);

  const rejected = fullPayload(h, 9);
  rejected.addons.mst = "bad";

  assert.equal(h.apply(rejected), false);
  assertCatalogUnchanged(h, before);
  assert.equal(h.version(), 8);
});

test("Builder rejects structurally invalid plan/add-on collections", () => {
  for (const badKey of ["plans", "addons"]) {
    const h = harness();
    const before = snapshotCatalog(h);
    const payload = fullPayload(h, 13);
    payload[badKey] = [];

    assert.equal(h.apply(payload), false, `${badKey} array should be rejected`);
    assertCatalogUnchanged(h, before);
  }
});

test("Builder bounds pricing requests and fails closed", () => {
  assert.match(builder, /controller\.abort\(\); reject\(new Error\('pricing timeout'\)\)/);
  assert.match(builder, /setPricingState\('unavailable'\)/);
  assert.match(builder, /if \(!applyPricingPayload\(pricing\)\) throw/);
});

test("Builder carries pricingVersion and 409 refresh returns without submitting", () => {
  assert.match(builder, /pricingVersion: pricingVersion/);
  assert.match(builder, /pricingVersion: selection\.pricingVersion/);
  const conflict = builder.indexOf("data.error.code === 'PRICES_CHANGED'");
  const fields = builder.indexOf("// Field-level messages", conflict);
  assert.ok(conflict >= 0 && fields > conflict);
  const branch = builder.slice(conflict, fields);
  assert.match(branch, /applyPricingPayload\(data\.pricing\)/);
  assert.match(branch, /setPricingState\('ready'\)/);
  assert.match(branch, /renderRecap\(\)/);
  assert.match(branch, /return;/);
});
