// Keeps builder-walkthrough.md honest.
//
// The walkthrough is a set of Find/Replace steps for the hand-maintained
// LiveCanvas copy of the Builder. If someone edits public/careplan-builder/index.html
// without updating the doc, the doc silently starts describing a version that no
// longer exists — and the WordPress copy drifts. This asserts that every
// "Replace with" block is present verbatim in the sandbox Builder, and that no
// "Find this" block still is (which would mean a step was never applied here).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const walkthrough = readFileSync(join(here, "..", "builder-walkthrough.md"), "utf8");
const builder = readFileSync(join(here, "..", "public", "careplan-builder", "index.html"), "utf8");

function parseSteps(md) {
  const blocks = [...md.matchAll(/\*\*(Find this|Replace with)\*\*\s*\n\s*```[a-z]*\n([\s\S]*?)\n```/g)].map((m) => ({
    kind: m[1],
    body: m[2],
  }));
  const steps = [];
  for (let i = 0; i < blocks.length; i += 2) {
    assert.equal(blocks[i].kind, "Find this", `step ${steps.length + 1}: expected a "Find this" block`);
    assert.equal(blocks[i + 1] && blocks[i + 1].kind, "Replace with", `step ${steps.length + 1}: missing "Replace with"`);
    steps.push({ number: steps.length + 1, find: blocks[i].body, replace: blocks[i + 1].body });
  }
  return steps;
}

const steps = parseSteps(walkthrough);

test("the walkthrough parses into the documented number of steps", () => {
  assert.equal(steps.length, 20, "builder-walkthrough.md should hold 20 Find/Replace steps");
});

test("every final replacement is present once unless a later step intentionally edits inside it", () => {
  for (const step of steps) {
    const laterSteps = steps.slice(step.number);
    const superseded = laterSteps.some((later) => step.replace.includes(later.find));
    if (superseded) continue;
    const count = builder.split(step.replace).length - 1;
    assert.equal(count, 1, `step ${step.number}: its final "Replace with" block appears ${count} times in the Builder, expected 1`);
  }
});

test("no step's original text is still in the sandbox Builder", () => {
  for (const step of steps) {
    // Steps whose replacement contains the original (an append rather than a
    // swap) are expected to still match — check those by replacement only.
    if (step.replace.includes(step.find)) continue;
    const count = builder.split(step.find).length - 1;
    assert.equal(count, 0, `step ${step.number}: the pre-edit text is still present in the Builder`);
  }
});

test("the launch constants the walkthrough promises are really there", () => {
  assert.match(builder, /var SUBMIT_ENDPOINT = '\/api\/test\/care-plan-request';/);
  assert.match(builder, /var PRICING_ENDPOINT = '\/api\/pricing';/);
  assert.match(builder, /var pricingVersion = null;/);
  assert.match(builder, /var TURNSTILE_SITEKEY = '1x00000000000000000000AA';/);
  // And they are adjacent, which is the whole point of step 5.
  const endpointAt = builder.indexOf("var SUBMIT_ENDPOINT");
  const sitekeyAt = builder.indexOf("var TURNSTILE_SITEKEY");
  assert.ok(sitekeyAt > endpointAt && sitekeyAt - endpointAt < 400, "the two launch constants should sit together");
});

test("the Builder posts the Turnstile token and the endpoint requires it", async () => {
  assert.match(builder, /turnstileToken: turnstileToken/, "the payload carries the token");
  assert.match(builder, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/, "explicit render");
  const { validateIntake } = await import("../lib/intake/validate.js");
  const result = validateIntake({
    customerName: "A",
    phone: "5755550142",
    address: "1 St",
    bestTime: "",
    planId: "hvac",
    addons: [],
  });
  assert.equal(result.ok, false, "the endpoint rejects a payload with no token");
});


test("the walkthrough documents the corrected Premier pairing markers in the Builder", () => {
  assert.match(walkthrough, /Premier \+ Water Softener Service ×2/);
  assert.match(walkthrough, /Water Softener Salt ×2/);
  assert.match(builder, /includedWith: 'wsv'/, "salt must be paired to Water Softener Service");
  assert.match(builder, /data-premier-pair/, "paired cards need the Premier visual grouping");
  assert.match(builder, /function premierSaltQty\(\)/, "salt quantity must be derived from service state");
  assert.doesNotMatch(
    builder,
    /id: 'ros'[^\n]*includedIn:\s*\['premier'\]/,
    "Reverse Osmosis Service must not be a free Premier add-on"
  );
  assert.match(
    builder,
    /Filters replaced during a Reverse Osmosis Service are included at no additional charge/,
    "Premier card copy must describe the current RO-filter benefit wording"
  );
});


test("the Builder carries pricing version and handles stale price refreshes", () => {
  assert.match(builder, /pricingVersion: pricingVersion/);
  assert.match(builder, /pricingVersion: selection\.pricingVersion/);
  assert.match(builder, /data\.error\.code === 'PRICES_CHANGED'/);
  assert.match(builder, /Our prices were just updated/);
  assert.match(builder, /controller\.abort\(\); reject\(new Error\('pricing timeout'\)\)/);
  assert.match(builder, /loadPricingThenRender\(\);/);
});

test("the Builder rejects malformed known pricing atomically and ignores unknown extras only on valid payloads", () => {
  const start = builder.indexOf("  function applyPricingPayload(pricing) {");
  const end = builder.indexOf("\n  function loadPricingThenRender()", start);
  assert.ok(start >= 0 && end > start, "could not isolate applyPricingPayload");

  const functionSource = builder.slice(start, end);
  const PLANS = [
    { id: "hvac", price: 260 },
    { id: "premier", price: 600 },
  ];
  const ADDON_GROUPS = [
    { items: [{ id: "qfc", price: 120 }, { id: "mst", price: 80 }] },
  ];
  const ADDON_INDEX = { qfc: ADDON_GROUPS[0].items[0], mst: ADDON_GROUPS[0].items[1] };

  // eslint-disable-next-line no-new-func -- exact Builder function isolated above.
  const harness = new Function(
    "PLANS",
    "ADDON_GROUPS",
    "ADDON_INDEX",
    "pricingVersion",
    functionSource + "\nreturn { applyPricingPayload, getVersion: function () { return pricingVersion; } };"
  )(PLANS, ADDON_GROUPS, ADDON_INDEX, null);

  const rejected = harness.applyPricingPayload({
    version: 9,
    plans: { hvac: 300, premier: "bad", unknownPlan: 999 },
    addons: { qfc: 135, mst: 95, unknownAddon: 777 },
  });

  assert.equal(rejected, false);
  assert.deepEqual(PLANS.map((plan) => plan.price), [260, 600], "no plan price may change");
  assert.deepEqual(
    ADDON_GROUPS[0].items.map((addon) => addon.price),
    [120, 80],
    "no add-on price may change"
  );
  assert.equal(harness.getVersion(), null, "version must not advance on rejection");

  const applied = harness.applyPricingPayload({
    version: 10,
    plans: { hvac: 300, premier: 650, unknownPlan: 9999 },
    addons: { qfc: 135, mst: 95, unknownAddon: 9999 },
  });

  assert.equal(applied, true);
  assert.deepEqual(PLANS.map((plan) => plan.price), [300, 650]);
  assert.deepEqual(ADDON_GROUPS[0].items.map((addon) => addon.price), [135, 95]);
  assert.equal(harness.getVersion(), 10);
});
