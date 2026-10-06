// Drift guard: the server catalog vs. the Care Plan Builder's own arrays.
//
// The builder is hand-maintained in two places (the sandbox page in this repo
// and the LiveCanvas block in WordPress), and lib/intake/catalog.js is a copy
// of its pricing tables. A price edited in one place and not the other would
// silently bill customers one number and record another, so this test parses
// PLANS / ADDON_GROUPS / MAX_ADDON_QTY straight out of the builder HTML and
// compares them field by field.
//
// The arrays are pure literals (no function calls), so they are read by
// balancing brackets and evaluating the literal — no bundler, no JSDOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ADDON_GROUPS, MAX_ADDON_QTY, PLANS } from "../lib/intake/catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const BUILDER_PATH = join(here, "..", "public", "careplan-builder", "index.html");

function extractArrayLiteral(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `could not find "${declaration}" in the builder HTML`);
  const open = source.indexOf("[", start);
  let depth = 0;
  let inString = null;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === "'" || char === '"') {
      inString = char;
      continue;
    }
    if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced array literal for ${declaration}`);
}

function readBuilderCatalog() {
  const html = readFileSync(BUILDER_PATH, "utf8");

  const qtyMatch = html.match(/var\s+MAX_ADDON_QTY\s*=\s*(\d+)\s*;/);
  assert.ok(qtyMatch, "could not find MAX_ADDON_QTY in the builder HTML");

  // eslint-disable-next-line no-new-func -- literal-only source, extracted above
  const plans = new Function(`return ${extractArrayLiteral(html, "var PLANS")};`)();
  // eslint-disable-next-line no-new-func
  const addonGroups = new Function(`return ${extractArrayLiteral(html, "var ADDON_GROUPS")};`)();

  return { maxAddonQty: Number(qtyMatch[1]), plans, addonGroups };
}

const builder = readBuilderCatalog();

test("MAX_ADDON_QTY matches the builder", () => {
  assert.equal(MAX_ADDON_QTY, builder.maxAddonQty);
});

test("plans match the builder: id, full name, price, covered systems", () => {
  assert.equal(PLANS.length, builder.plans.length, "plan count differs");

  for (const builderPlan of builder.plans) {
    const serverPlan = PLANS.find((p) => p.id === builderPlan.id);
    assert.ok(serverPlan, `server catalog is missing plan "${builderPlan.id}"`);
    assert.equal(serverPlan.full, builderPlan.full, `plan ${builderPlan.id}: full name differs`);
    assert.equal(serverPlan.price, builderPlan.price, `plan ${builderPlan.id}: price differs`);
    assert.deepEqual(
      [...serverPlan.covers].sort(),
      [...builderPlan.covers].sort(),
      `plan ${builderPlan.id}: covered systems differ`
    );
  }
});

test("add-ons match the builder: id, name, price, system, quantityOnly, included, includedIn, includedWith", () => {
  const builderItems = [];
  for (const group of builder.addonGroups) {
    for (const item of group.items) builderItems.push({ ...item, system: group.system });
  }
  const serverItems = [];
  for (const group of ADDON_GROUPS) {
    for (const item of group.items) serverItems.push({ ...item, system: group.system });
  }

  assert.equal(serverItems.length, builderItems.length, "add-on count differs");

  for (const builderItem of builderItems) {
    const serverItem = serverItems.find((i) => i.id === builderItem.id);
    assert.ok(serverItem, `server catalog is missing add-on "${builderItem.id}"`);
    assert.equal(serverItem.name, builderItem.name, `${builderItem.id}: name differs`);
    assert.equal(serverItem.price, builderItem.price, `${builderItem.id}: price differs`);
    assert.equal(serverItem.system, builderItem.system, `${builderItem.id}: system differs`);
    assert.equal(
      !!serverItem.quantityOnly,
      !!builderItem.quantityOnly,
      `${builderItem.id}: quantityOnly differs`
    );
    assert.equal(
      serverItem.included ?? null,
      builderItem.included ?? null,
      `${builderItem.id}: included count differs`
    );
    assert.deepEqual(
      [...(serverItem.includedIn || [])].sort(),
      [...(builderItem.includedIn || [])].sort(),
      `${builderItem.id}: includedIn differs`
    );
    assert.equal(
      serverItem.includedWith ?? null,
      builderItem.includedWith ?? null,
      `${builderItem.id}: includedWith differs`
    );
  }
});

test("every add-on's system is covered by at least one plan", () => {
  for (const group of ADDON_GROUPS) {
    assert.ok(
      PLANS.some((p) => p.covers.includes(group.system)),
      `no plan covers system "${group.system}"`
    );
  }
});

test("the builder's bestTime <select> only offers values the server accepts", async () => {
  const html = readFileSync(BUILDER_PATH, "utf8");
  const selectMatch = html.match(/<select id="cpbLeadBestTime"[\s\S]*?<\/select>/);
  assert.ok(selectMatch, "could not find the bestTime select");
  const values = [...selectMatch[0].matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
  const { BEST_TIME_MAP } = await import("../lib/intake/validate.js");
  for (const value of values) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(BEST_TIME_MAP, value),
      `the form can send bestTime="${value}" but the server does not map it`
    );
  }
});


test("pricing migrations resolve to every catalog id, label and default price", () => {
  const sql = readFileSync(join(here, "..", "migrations", "0006_pricing.sql"), "utf8");
  const migration0007 = readFileSync(join(here, "..", "migrations", "0007_submission_is_test.sql"), "utf8");
  const rows = [...sql.matchAll(/\('(plan|addon):([^']+)',\s*'(plan|addon)',\s*'((?:''|[^'])*)',\s*(\d+),\s*NULL,\s*NULL\)/g)]
    .map((match) => ({
      id: `${match[1]}:${match[2]}`,
      kind: match[3],
      label: match[4].replace(/''/g, "'"),
      price: Number(match[5]),
    }));

  const labelUpdates = Object.fromEntries(
    [...migration0007.matchAll(/UPDATE pricing_items\s+SET label = '([^']+)'\s+WHERE id = '([^']+)'/g)]
      .map((match) => [match[2], match[1]])
  );
  const finalRows = rows.map((row) => ({ ...row, label: labelUpdates[row.id] || row.label }));

  const expected = [
    ...PLANS.map((plan) => ({ id: `plan:${plan.id}`, kind: "plan", label: plan.full, price: plan.price })),
    ...ADDON_GROUPS.flatMap((group) =>
      group.items.map((item) => ({ id: `addon:${item.id}`, kind: "addon", label: item.name, price: item.price }))
    ),
  ];

  assert.deepEqual(finalRows, expected);
  assert.equal(finalRows.length, 13, "4 plans + 9 add-ons, including the two counts and Water Softener Salt");
});

test('0008 backfilled catalog text exactly matches current Builder literals and is additive',async()=>{
  const {SqliteD1}=await import('./sqlite-d1.mjs');const db=new SqliteD1();
  try{
    const rows=db.items;
    for(const p of builder.plans){const row=rows.find(r=>r.id==='plan:'+p.id);assert.equal(row.label,p.full);assert.equal(row.short_label,p.name);assert.equal(row.description,p.tagline);}
    for(const group of builder.addonGroups)for(const a of group.items){const row=rows.find(r=>r.id==='addon:'+a.id);assert.equal(row.label,a.name);assert.equal(row.short_label,null);assert.equal(row.description,a.desc);}
    const sql=readFileSync(join(here,'..','migrations','0008_catalog_text.sql'),'utf8');
    assert.doesNotMatch(sql,/DROP TABLE|CREATE TABLE|UPDATE submissions|ALTER TABLE submissions/i);
    assert.match(sql,/-- BEGIN GENERATED CATALOG TEXT/);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM submission_addons').get().n,5,'existing seed children survive');
  }finally{db.close();}
});
