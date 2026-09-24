// Keeps builder-walkthrough.md honest.
//
// The walkthrough is a set of Find/Replace steps for the hand-maintained
// LiveCanvas copy of the Builder. If someone edits public/memberships/index.html
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
const builder = readFileSync(join(here, "..", "public", "memberships", "index.html"), "utf8");

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
  assert.equal(steps.length, 14, "builder-walkthrough.md should hold 14 Find/Replace steps");
});

test("every step's replacement is present exactly once in the sandbox Builder", () => {
  for (const step of steps) {
    const count = builder.split(step.replace).length - 1;
    assert.equal(count, 1, `step ${step.number}: its "Replace with" block appears ${count} times in the Builder, expected 1`);
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
  assert.match(builder, /var SUBMIT_ENDPOINT = '\/api\/care-plan-request';/);
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
    /RO Filters Included[^\n]*paid Reverse Osmosis Service/,
    "Premier card copy must describe free filters during a paid RO service"
  );
});
