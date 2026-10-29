import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { notifyN8n } from "../lib/intake/notify.js";
import { insertSubmission } from "../lib/intake/persist.js";
import { shapeSubmission } from "../lib/submissions.js";
import { getPlan, getAddon } from "../lib/intake/catalog.js";
import { authenticateDashboardStaff } from "../lib/admin/access.js";
import { onRequestGet } from "../functions/api/submissions/index.js";
import { onRequestPatch } from "../functions/api/submissions/[id].js";

function fakeDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            sql, values,
            async run() {
              calls.push({ sql, values });
              return { meta: { last_row_id: 77 } };
            },
          };
        },
      };
    },
    async batch() { return []; },
  };
}
const pricing = { planId:"hvac", plan:"HVAC Care Plan", basePrice:260, addonTotal:0, total:260, lines:[] };

test("persistence requires trusted classification and stores test as 1", async () => {
  const db=fakeDb();
  await assert.rejects(insertSubmission(db,{
    customer:{name:"Test",phone:"5755550142",address:"1 Test St",bestTime:"Morning"},
    pricing, submittedAt:"2026-10-06T18:00:00Z"
  }),/submission_classification_required/);
  await insertSubmission(db,{
    customer:{name:"Test",phone:"5755550142",address:"1 Test St",bestTime:"Morning"},
    pricing, submittedAt:"2026-10-06T18:00:00Z", isTest:true
  });
  const call=db.calls.find(c=>/INSERT INTO submissions/.test(c.sql));
  assert.ok(call); assert.match(call.sql,/is_test/); assert.equal(call.values[8],1);
});

test("dashboard shaping exposes boolean isTest",()=>{
  const row={id:1,name:"A",phone:"1",address:"A",best_time:"Morning",plan:"HVAC Care Plan",
    base_price:260,addon_total:0,total_price:260,status:"New",submitted_at:"2026-10-06T18:00:00Z"};
  assert.equal(shapeSubmission({...row,is_test:0},[],[]).isTest,false);
  assert.equal(shapeSubmission({...row,is_test:1},[],[]).isTest,true);
});

test("test notifications are suppressed before fetch while live notifications send",async()=>{
  let fetches=0;
  const fetchImpl=async()=>{fetches++;return new Response(null,{status:200})};
  const env={N8N_WEBHOOK_URL:"https://office.invalid",N8N_WEBHOOK_SECRET:"x"};
  const skipped=await notifyN8n({env,payload:{},fetchImpl,isTest:true});
  assert.equal(skipped.skipped,true); assert.equal(skipped.reason,"test_submission"); assert.equal(fetches,0);
  const live=await notifyN8n({env,payload:{},fetchImpl,isTest:false});
  assert.equal(live.ok,true); assert.equal(fetches,1);
});

test("0007 is additive and only exact seed fixtures are backfilled",()=>{
  const sql=readFileSync(new URL("../migrations/0007_submission_is_test.sql",import.meta.url),"utf8");
  assert.match(sql,/ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0 CHECK \(is_test IN \(0, 1\)\)/);
  assert.doesNotMatch(sql,/DROP TABLE submissions/i);
  for(const marker of ["Robert Martinez","Dana Whitfield","Alicia Nguyen","Marcus Ibarra"]) assert.match(sql,new RegExp(marker));
  assert.doesNotMatch(sql,/WHERE\s+id\s*>\s*4/i);
});

test("route wrappers hard-code classification and practice Builder cannot send it",()=>{
  const live=readFileSync(new URL("../functions/api/care-plan-request.js",import.meta.url),"utf8");
  const practice=readFileSync(new URL("../functions/api/test/care-plan-request.js",import.meta.url),"utf8");
  const builder=readFileSync(new URL("../public/careplan-builder/index.html",import.meta.url),"utf8");
  assert.match(live,/isTest: false/); assert.match(practice,/isTest: true/);
  assert.match(builder,/SUBMIT_ENDPOINT = '\/api\/test\/care-plan-request'/);
  assert.doesNotMatch(builder,/\bis_test\s*:/); assert.doesNotMatch(builder,/\bisTest\s*:/);
});

test("dashboard includes All Real Test filters and non-color TEST labels",()=>{
  const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  assert.match(html,/id="submissionTypeFilter"/);
  assert.match(html,/value="all">All/); assert.match(html,/value="live">Real/); assert.match(html,/value="test">Test/);
  assert.match(html,/>TEST<\/span>/); assert.match(html,/TEST SUBMISSION/);
  assert.match(html,/SUBMISSIONS\.filter\(r => !r\.isTest\)/);
});

// Independent audit regressions (October 2026).
test("prototype keys are invalid plan/addon ids", () => {
  for (const key of ["constructor", "__proto__", "toString"]) {
    assert.equal(getPlan(key), null);
    assert.equal(getAddon(key), null);
  }
});

test("submission APIs fail closed without dashboard Access configuration", async () => {
  const request = new Request("https://care-plan-builder.pages.dev/api/submissions");
  const result = await authenticateDashboardStaff(request, {});
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal((await onRequestGet({ request, env: {} })).status, 503);
  assert.equal((await onRequestPatch({request:new Request(request.url,{method:"PATCH"}),env:{},params:{id:"1"}})).status,503);
});

test("separate live and practice Turnstile secrets are enforced", () => {
  const source = readFileSync(new URL("../lib/intake/handle-request.js", import.meta.url), "utf8");
  assert.match(source, /isTest \? env\.TURNSTILE_TEST_SECRET : env\.TURNSTILE_SECRET/);
});
