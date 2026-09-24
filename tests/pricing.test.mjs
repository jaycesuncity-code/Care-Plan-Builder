// Unit tests for the server-side repricing and validation — the two things
// standing between a tampered payload and the office's numbers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { INCLUDED_SUFFIX, LOCKED_SUFFIX, MAX_ADDON_QTY, priceSelection } from "../lib/intake/catalog.js";
import { BEST_TIME_MAP, validateIntake } from "../lib/intake/validate.js";

const here = dirname(fileURLToPath(import.meta.url));

function billable(pricing) {
  return pricing.lines.filter((l) => l.billable);
}

test("plan base prices are taken from the catalog, not the payload", () => {
  assert.equal(priceSelection("hvac", []).basePrice, 260);
  assert.equal(priceSelection("plumbing", []).basePrice, 160);
  assert.equal(priceSelection("bundled", []).basePrice, 400);
  assert.equal(priceSelection("premier", []).basePrice, 600);
});

test("addon_total + base = total, with a simple HVAC add-on", () => {
  const pricing = priceSelection("hvac", [{ id: "qfc", quantity: 1 }]);
  assert.equal(pricing.addonTotal, 120);
  assert.equal(pricing.total, 380);
  assert.equal(pricing.basePrice + pricing.addonTotal, pricing.total);
});

test("quantity multiplies a normal add-on", () => {
  const pricing = priceSelection("hvac", [{ id: "mst", quantity: 3 }]);
  assert.equal(pricing.addonTotal, 240); // 80 x 3
  assert.equal(pricing.total, 500);
});

test("quantity-only add-ons bill only the units above the included count", () => {
  // 1 HVAC system is included; 3 total = 2 additional x $125.
  const three = priceSelection("hvac", [{ id: "hvacSystems", quantity: 3 }]);
  assert.equal(three.addonTotal, 250);
  const line = three.lines.find((l) => l.id === "hvacSystems");
  assert.equal(line.quantity, 3, "the stored quantity is the total count, matching the builder's payload");
  assert.equal(line.lineTotal, 250);

  // At the included count there is no charge and no line at all.
  const one = priceSelection("plumbing", [{ id: "waterHeaters", quantity: 1 }]);
  assert.equal(one.addonTotal, 0);
  assert.equal(one.lines.length, 0);
});

test("Premier with no Water Softener Service creates no phantom salt line", () => {
  const pricing = priceSelection("premier", []);
  assert.equal(pricing.lines.some((l) => l.id === "wss"), false);
  assert.equal(pricing.lines.some((l) => l.id === "ros"), false);
  assert.equal(pricing.addonTotal, 0);
  assert.equal(pricing.total, 600);
});

test("Premier Water Softener Service x1 stays paid and creates matching included salt", () => {
  const pricing = priceSelection("premier", [{ id: "wsv", quantity: 1 }]);
  const service = pricing.lines.find((l) => l.id === "wsv");
  const salt = pricing.lines.find((l) => l.id === "wss");

  assert.equal(service.quantity, 1);
  assert.equal(service.lineTotal, 75);
  assert.equal(service.billable, true);
  assert.equal(service.includedFree, false);

  assert.equal(salt.quantity, 1);
  assert.equal(salt.lineTotal, 0);
  assert.equal(salt.includedFree, true);
  assert.equal(salt.billable, false);
  assert.ok(salt.storedName.endsWith(INCLUDED_SUFFIX));

  assert.equal(pricing.addonTotal, 75);
  assert.equal(pricing.total, 675);
});

test("Premier Water Softener Service x2 bills $150 and creates included salt x2", () => {
  const pricing = priceSelection("premier", [{ id: "wsv", quantity: 2 }]);
  const service = pricing.lines.find((l) => l.id === "wsv");
  const salt = pricing.lines.find((l) => l.id === "wss");

  assert.equal(service.quantity, 2);
  assert.equal(service.lineTotal, 150);
  assert.equal(salt.quantity, 2);
  assert.equal(salt.lineTotal, 0);
  assert.equal(pricing.addonTotal, 150);
  assert.equal(pricing.total, 750);
});

test("Premier ignores independently sent or stale salt and derives it only from softener service", () => {
  const noService = priceSelection("premier", [
    { id: "wss", quantity: 9 },
    { id: "wss", quantity: 1 },
  ]);
  assert.equal(noService.lines.some((l) => l.id === "wss"), false);
  assert.equal(noService.total, 600);

  const withService = priceSelection("premier", [
    { id: "wss", quantity: 9 },
    { id: "wsv", quantity: 2 },
  ]);
  const salt = withService.lines.find((l) => l.id === "wss");
  assert.equal(salt.quantity, 2, "salt quantity follows the paid service, not the client-sent salt quantity");
  assert.equal(salt.lineTotal, 0);
  assert.equal(withService.total, 750);
});

test("Plumbing and Bundled Water Softener Salt remain normal paid add-ons", () => {
  const plumbing = priceSelection("plumbing", [{ id: "wss", quantity: 2 }]);
  assert.equal(plumbing.addonTotal, 136);
  assert.equal(plumbing.lines[0].includedFree, false);
  assert.equal(plumbing.total, 296);

  const bundled = priceSelection("bundled", [{ id: "wss", quantity: 2 }]);
  assert.equal(bundled.addonTotal, 136);
  assert.equal(bundled.lines[0].includedFree, false);
  assert.equal(bundled.total, 536);
});

test("Premier Reverse Osmosis Service is paid and never creates a separate free line", () => {
  const pricing = priceSelection("premier", [{ id: "ros", quantity: 2 }]);
  const roLines = pricing.lines.filter((l) => l.id === "ros");

  assert.equal(roLines.length, 1);
  assert.equal(roLines[0].quantity, 2);
  assert.equal(roLines[0].lineTotal, 100);
  assert.equal(roLines[0].includedFree, false);
  assert.equal(pricing.addonTotal, 100);
  assert.equal(pricing.total, 700);
  assert.equal(pricing.lines.some((l) => /filter/i.test(l.id)), false, "no independent RO-filter add-on exists");
});

test("canonical Premier selection still totals $930 with no phantom water-treatment lines", () => {
  const pricing = priceSelection("premier", [
    { id: "mst", quantity: 1 },
    { id: "hvacSystems", quantity: 3 },
  ]);
  assert.equal(pricing.addonTotal, 330);
  assert.equal(pricing.total, 930);
  assert.equal(pricing.lines.some((l) => l.id === "wss"), false);
  assert.equal(pricing.lines.some((l) => l.id === "ros"), false);
});

test("add-ons a plan doesn't cover are kept but never billed", () => {
  // Plumbing add-on left over from a previous plan, now on an HVAC plan.
  const pricing = priceSelection("hvac", [
    { id: "qfc", quantity: 1 },
    { id: "twf", quantity: 2 },
  ]);
  const locked = pricing.lines.find((l) => l.id === "twf");
  assert.equal(locked.locked, true);
  assert.equal(locked.lineTotal, 0);
  assert.equal(locked.billable, false);
  assert.ok(locked.storedName.endsWith(LOCKED_SUFFIX));
  assert.equal(locked.quantity, 2, "quantity is preserved so the office sees what they wanted");
  assert.equal(pricing.addonTotal, 120, "only the covered add-on is billed");
});

test("bundled covers both systems", () => {
  const pricing = priceSelection("bundled", [
    { id: "qfc", quantity: 1 },
    { id: "twf", quantity: 1 },
    { id: "hvacSystems", quantity: 2 },
    { id: "waterHeaters", quantity: 2 },
  ]);
  assert.equal(pricing.lines.filter((l) => l.locked).length, 0);
  assert.equal(pricing.addonTotal, 120 + 40 + 125 + 50);
  assert.equal(pricing.total, 400 + 335);
});

test("monthlyEquivalent matches the builder's rounding", () => {
  const pricing = priceSelection("hvac", [{ id: "qfc", quantity: 1 }]);
  assert.equal(pricing.monthlyEquivalent, Math.round((380 / 12) * 100) / 100);
  assert.equal(pricing.monthlyEquivalent, 31.67);
});

test("unknown plan and unknown add-on are rejected", () => {
  assert.throws(() => priceSelection("platinum", []), /Unknown planId/);
  assert.throws(() => priceSelection("hvac", [{ id: "free-boiler", quantity: 1 }]), /Unknown addon id/);
});

// --- validation -------------------------------------------------------------

const VALID = {
  planId: "hvac",
  plan: "HVAC Care Plan",
  basePrice: 260,
  addons: [{ id: "qfc", quantity: 1, unitPrice: 120, lineTotal: 120 }],
  total: 380,
  customerName: "Test Customer",
  phone: "(575) 555-0142",
  address: "100 Test St, Las Cruces, NM 88001",
  bestTime: "morning",
  turnstileToken: "dummy-token",
};

test("a well-formed payload validates, and bestTime is mapped", () => {
  const result = validateIntake(VALID);
  assert.equal(result.ok, true);
  assert.equal(result.value.bestTime, "Morning");
  assert.equal(result.value.name, "Test Customer");
});

test('an empty bestTime becomes "No preference" rather than an invented answer', () => {
  const result = validateIntake({ ...VALID, bestTime: "" });
  assert.equal(result.ok, true);
  assert.equal(result.value.bestTime, "No preference");
});

test('"midday" survives as Midday', () => {
  assert.equal(validateIntake({ ...VALID, bestTime: "midday" }).value.bestTime, "Midday");
});

test("missing required fields come back as field-level errors", () => {
  const result = validateIntake({ ...VALID, customerName: "   ", address: "", phone: "" });
  assert.equal(result.ok, false);
  assert.equal(result.fieldErrors.customerName, "Name is required.");
  assert.equal(result.fieldErrors.address, "Service address is required.");
  assert.equal(result.fieldErrors.phone, "Phone number is required.");
});

test("phone needs 10-15 digits", () => {
  assert.equal(validateIntake({ ...VALID, phone: "555-0142" }).ok, false, "8 digits is rejected");
  assert.equal(validateIntake({ ...VALID, phone: "575 555 0142" }).ok, true);
  assert.equal(validateIntake({ ...VALID, phone: "+1 (575) 555-0142" }).ok, true);
  assert.equal(validateIntake({ ...VALID, phone: "5755550142555555" }).ok, false, "16 digits is rejected");
  assert.equal(validateIntake({ ...VALID, phone: "call me maybe" }).ok, false, "letters are rejected");
});

test("quantity above MAX_ADDON_QTY is rejected with the office's phone number", () => {
  const result = validateIntake({ ...VALID, addons: [{ id: "qfc", quantity: MAX_ADDON_QTY + 1 }] });
  assert.equal(result.ok, false);
  assert.match(result.fieldErrors.addons, /limited to 9/);
});

test("non-integer and negative quantities are rejected", () => {
  assert.equal(validateIntake({ ...VALID, addons: [{ id: "qfc", quantity: 1.5 }] }).ok, false);
  assert.equal(validateIntake({ ...VALID, addons: [{ id: "qfc", quantity: -3 }] }).ok, false);
});

test("unknown planId and unknown add-on id are rejected before any I/O", () => {
  assert.match(validateIntake({ ...VALID, planId: "platinum" }).fieldErrors.planId, /not available/);
  assert.match(validateIntake({ ...VALID, addons: [{ id: "<script>" }] }).fieldErrors.addons, /Unknown add-on/);
});

test("a hostile add-on id is not echoed back verbatim", () => {
  const result = validateIntake({ ...VALID, addons: [{ id: '<img src=x onerror="alert(1)">' }] });
  assert.equal(result.ok, false);
  assert.ok(!result.fieldErrors.addons.includes("<"), "angle brackets stripped from the echo");
});

test("a missing Turnstile token is a field error, not a silent pass", () => {
  const result = validateIntake({ ...VALID, turnstileToken: "" });
  assert.equal(result.ok, false);
  assert.match(result.fieldErrors.turnstileToken, /verification/i);
});

test("every value BEST_TIME_MAP can produce is allowed by the 0004 CHECK", () => {
  const sql = readFileSync(join(here, "..", "migrations", "0004_best_time_and_addon_flags.sql"), "utf8");
  const checkMatch = sql.match(/best_time\s+TEXT NOT NULL CHECK \(best_time IN \(([^)]*)\)\)/);
  assert.ok(checkMatch, "could not find the best_time CHECK in migration 0004");
  const allowed = [...checkMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const stored of new Set(Object.values(BEST_TIME_MAP))) {
    assert.ok(allowed.includes(stored), `the server can produce best_time="${stored}" but the CHECK forbids it`);
  }
});
