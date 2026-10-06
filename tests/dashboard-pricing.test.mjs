import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { shapeSubmission } from "../lib/submissions.js";
import { priceSelection } from "./pricing-fixture.mjs";
import { insertSubmission } from "../lib/intake/persist.js";

const dashboard = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const start = dashboard.indexOf("function formatSubmissionPrice(");
const end = dashboard.indexOf("function closeDetail(", start);
assert(start >= 0 && end > start, "submission detail renderer must exist");
const detailSource = dashboard.slice(start, end);

function renderDetail(row) {
  const elements = new Map();
  const context = createContext({
    SUBMISSIONS: [row],
    modalOpenId: null,
    modalBackdrop: { classList: { remove() {} } },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { addEventListener() {}, innerHTML: "" });
        return elements.get(id);
      },
    },
    statusClass: () => "new",
    statusOptionsHtml: () => "",
    formatDate: () => "",
    escapeHtml: (text) => String(text),
  });
  runInContext(detailSource + "\nopenDetail(SUBMISSIONS[0].id);", context);
  return elements.get("modalPriceTable").innerHTML;
}

// Capture the real persistence helper's bound values without connecting to D1.
async function saveSelection(pricing) {
  let submission;
  let addons = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            sql, values,
            async run() {
              assert.match(sql, /INSERT INTO submissions/);
              const [name, phone, address, best_time, plan, base_price, addon_total,
                total_price, is_test, submitted_at, updated_at] = values;
              submission = { id: 13, name, phone, address, best_time, plan, base_price,
                addon_total, total_price, is_test, submitted_at, updated_at, status: "New" };
              return { meta: { last_row_id: 13 } };
            },
          };
        },
      };
    },
    async batch(statements) {
      addons = statements.map(({ sql, values }) => {
        assert.match(sql, /INSERT INTO submission_addons/);
        const [submission_id, addon_name, addon_price, quantity, included_free, locked] = values;
        return { submission_id, addon_name, addon_price, quantity, included_free, locked };
      });
      return statements.map(() => ({ success: true }));
    },
  };
  await insertSubmission(db, {
    customer: { name: "Test", phone: "", address: "", bestTime: "Morning" },
    pricing,
    submittedAt: "2026-10-05T16:39:00Z",
    isTest: false,
  });
  return shapeSubmission(submission, addons, []);
}

test("a saved $415 Bundled submission shows $415 for both base and total after catalog changes", async () => {
  const prices = { plans: { bundled: 415 }, addons: {} };
  const row = await saveSelection(priceSelection("bundled", [], prices));
  const before = renderDetail(row);
  prices.plans.bundled = 500;
  assert.equal(priceSelection("bundled", [], prices).total, 500);
  assert.equal(renderDetail(row), before);
  assert.match(before, /Bundled Care Plan \(base\)<\/td><td>\$415<\/td>/);
  assert.match(before, /Total<\/td><td>\$415\/yr/);
  assert.match(before, /No add-ons selected/);
});

test("saved add-on line totals survive price changes and are not multiplied by quantity again", async () => {
  const selection = [{ id: "qfc", quantity: 2 }, { id: "hvacSystems", quantity: 3 }];
  const prices = { plans: { hvac: 275 }, addons: { qfc: 130, hvacSystems: 140 } };
  const row = await saveSelection(priceSelection("hvac", selection, prices));
  const before = renderDetail(row);
  prices.plans.hvac = 300;
  prices.addons.qfc = 200;
  prices.addons.hvacSystems = 180;
  assert.equal(priceSelection("hvac", selection, prices).total, 1060);
  assert.equal(renderDetail(row), before);
  assert.match(before, /HVAC Care Plan \(base\)<\/td><td>\$275/);
  assert.match(before, /Quarterly Filter Change &times; 2<\/td><td>\$260/);
  assert.match(before, /# of HVAC Systems &times; 3<\/td><td>\$280/);
  assert.match(before, /Total<\/td><td>\$815\/yr/);
});

test("saved zero-dollar, included, and locked lines retain their original meaning", async () => {
  const row = await saveSelection(priceSelection("premier", [{ id: "wsv", quantity: 3 }], {
    plans: { premier: 625 }, addons: { wsv: 85 },
  }));
  assert.match(renderDetail(row), /Water Softener Service &times; 3<\/td><td>\$255/);
  assert.match(renderDetail(row), /Water Softener Salt \(included with plan\) &times; 3<\/td><td>Included/);
  const locked = await saveSelection(priceSelection("hvac", [{ id: "twf", quantity: 1 }], {}));
  assert.match(renderDetail(locked), /Not charged/);
  const zero = await saveSelection({ ...priceSelection("hvac", []), basePrice: 0, total: 0 });
  assert.match(renderDetail(zero), /HVAC Care Plan \(base\)<\/td><td>\$0/);
});

test("legacy missing prices are labeled Not recorded instead of guessed from a catalog", () => {
  const html = renderDetail({
    id: 1, name: "Test", plan: "Retired Plan", total: 415, notes: [],
    addons: ["Quarterly Filter Change"],
  });
  assert.match(html, /Retired Plan \(base\)<\/td><td>Not recorded/);
  assert.match(html, /Quarterly Filter Change<\/td><td>Not recorded/);
  assert.match(html, /Total<\/td><td>\$415\/yr/);
});
