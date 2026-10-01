import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const builder = readFileSync(join(here, "..", "public", "memberships", "index.html"), "utf8");

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

test("Builder applies a complete sane pricing payload and records its version", () => {
  const h = harness();
  const payload = fullPayload(h, 9);
  payload.plans.unknown = 9999;
  payload.addons.unknown = 9999;
  assert.equal(h.apply(payload), true);
  assert.equal(h.version(), 9);
  assert.equal(h.plans.find((plan) => plan.id === "hvac").price, 270);
  const qfc = h.groups.flatMap((group) => group.items).find((addon) => addon.id === "qfc");
  assert.equal(qfc.price, 125);
  assert.equal(h.plans.some((plan) => plan.id === "unknown"), false);
});

test("Builder rejects malformed known pricing without partially changing defaults", () => {
  const h = harness();
  const before = h.plans.map((plan) => plan.price);
  const payload = fullPayload(h, 10);
  payload.addons.qfc = "120";
  assert.equal(h.apply(payload), false);
  assert.equal(h.version(), null);
  assert.deepEqual(h.plans.map((plan) => plan.price), before);
});

test("Builder hardcodes a 1500ms timeout and fallback leaves pricingVersion null", () => {
  assert.match(builder, /setTimeout\(function \(\) \{ controller\.abort\(\); \}, 1500\)/);
  assert.match(builder, /\.catch\(function \(\) \{\s*pricingVersion = null;/);
});

test("Builder carries pricingVersion and 409 refresh returns without submitting", () => {
  assert.match(builder, /pricingVersion: pricingVersion/);
  assert.match(builder, /pricingVersion: selection\.pricingVersion/);
  const conflict = builder.indexOf("data.error.code === 'PRICES_CHANGED'");
  const fields = builder.indexOf("// Field-level messages", conflict);
  assert.ok(conflict >= 0 && fields > conflict);
  const branch = builder.slice(conflict, fields);
  assert.match(branch, /applyPricingPayload\(data\.pricing\)/);
  assert.match(branch, /renderCurrentPricing\(\)/);
  assert.match(branch, /renderRecap\(\)/);
  assert.match(branch, /return;/);
});
