import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { authenticatePricingEditor } from "../lib/admin/access.js";
import { SqliteD1 } from "./sqlite-d1.mjs";
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

class FakeDb extends SqliteD1 { constructor(){super();} }

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
  assert.equal(body.items.length, 13);
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

for (const [key,value] of [['label',''],['label','x'.repeat(61)],['shortLabel','x'.repeat(21)],['description','x'.repeat(401)],['description','\nhello'],['label','<bad>'],['description','hello\u0085world'],['description',null],['extra','oops']]) {
  test(`admin validates ${key}=${String(value).slice(0,12)} with per-field errors and no hooks/writes`,async()=>{
    const db=new FakeDb(),savedFetch=globalThis.fetch;let hooks=0;
    globalThis.fetch=async()=>{hooks++;return Response.json({ok:true});};
    try{
      const res=await onRequestPut({request:putRequest({expectedVersion:1,changes:[{id:'plan:hvac',[key]:value}]}),env:{...localEnv(db),CATALOG_DEPLOY_HOOK_URLS:'https://hooks.test/private'}});
      assert.equal(res.status,400);assert.ok((await res.json()).fieldErrors['changes.0.'+key]);
      assert.equal(db.version,1);assert.equal(db.audit.length,0);assert.equal(hooks,0);
    }finally{globalThis.fetch=savedFetch;db.close();}
  });
}

test('admin rejects empty fields and shortLabel on add-ons, allows 600-character add-on descriptions',async()=>{
  const db=new FakeDb();try{
    assert.equal((await put(db,{expectedVersion:1,changes:[{id:'addon:qfc'}]})).status,400);
    const bad=await put(db,{expectedVersion:1,changes:[{id:'addon:qfc',shortLabel:'Filter'}]});
    assert.equal(bad.status,400);assert.ok((await bad.json()).fieldErrors['changes.0.shortLabel']);
    assert.equal((await put(db,{expectedVersion:1,changes:[{id:'addon:qfc',description:'x'.repeat(600)}]})).status,200);
    assert.equal(db.version,2);assert.equal(db.audit[0].field,'description');
  }finally{db.close();}
});

test('text-only save bumps once and writes a real audit row per changed field',async()=>{
  const db=new FakeDb();try{
    const res=await put(db,{expectedVersion:1,changes:[{id:'plan:hvac',label:'  New Full Name  ',shortLabel:'New Tab',description:'New description'}]});
    assert.equal(res.status,200);const body=await res.json();assert.equal(body.version,2);
    assert.equal(body.publish.status,'not_configured');assert.equal(body.publishConfigured,false);assert.equal(body.publicCatalogUrl,'');
    assert.equal(db.audit.length,3);assert.deepEqual(db.audit.map(row=>row.field),['label','short_label','description']);
    assert.equal(db.audit[0].old_value,'HVAC Care Plan');assert.equal(db.audit[0].new_value,'New Full Name');
    for(const row of db.audit){assert.equal(row.old_price,null);assert.equal(row.new_price,null);}
    assert.equal(db.items.find(row=>row.id==='plan:hvac').price,260);
    const price=await put(db,{expectedVersion:2,changes:[{id:'plan:hvac',price:280}]});assert.equal(price.status,200);
    assert.equal(db.audit[3].field,'price');assert.equal(db.audit[3].old_value,'260');assert.equal(db.audit[3].new_value,'280');
    assert.equal(db.audit[3].old_price,260);assert.equal(db.audit[3].new_price,280);
  }finally{db.close();}
});

for(const outcome of ['success','http-failure','network-failure','write-failure','conflict','race']){
  test(`deploy hooks ${outcome}: awaited after commit, secrets stay private`,async()=>{
    const db=new FakeDb(),savedFetch=globalThis.fetch;let calls=[],committed=[];
    const hooks='https://hooks.test/secret-one, https://hooks.test/secret-two';
    if(outcome==='write-failure')db.failWrites=true;
    if(outcome==='conflict')db.version=2;
    if(outcome==='race')db.raceOnNextWriteBatch=true;
    globalThis.fetch=async(url,options)=>{
      calls.push(url);committed.push(db.version);assert.equal(options.method,'POST');assert.ok(options.signal);
      await new Promise(resolve=>setTimeout(resolve,5));
      if(outcome==='network-failure')throw new Error('includes private url '+url);
      return new Response('{}',{status:outcome==='http-failure'&&calls.length===2?500:200});
    };
    try{
      const res=await onRequestPut({request:putRequest({expectedVersion:1,changes:[{id:'plan:hvac',label:'New name'}]}),env:{...localEnv(db),CATALOG_DEPLOY_HOOK_URLS:hooks,PUBLIC_CATALOG_URL:'https://public.test/catalog.json'}});
      const raw=await res.text(),body=JSON.parse(raw);assert.doesNotMatch(raw,/secret-one|secret-two|hooks.test/);
      if(['conflict','race','write-failure'].includes(outcome)){assert.equal(res.status,outcome==='write-failure'?503:409);assert.equal(calls.length,0);}
      else{assert.equal(res.status,200);assert.equal(body.publish.status,outcome==='success'?'triggered':'failed');assert.equal(body.publishConfigured,true);assert.equal(body.publicCatalogUrl,'https://public.test/catalog.json');assert.equal(calls.length,2);assert.deepEqual(committed,[2,2]);assert.equal(db.version,2);}
    }finally{globalThis.fetch=savedFetch;db.close();}
  });
}

test('hanging deploy hook is bounded to five seconds without failing the save',async()=>{
  const db=new FakeDb(),savedFetch=globalThis.fetch,start=Date.now();
  globalThis.fetch=()=>new Promise(()=>{});
  try{
    const response=await onRequestPut({request:putRequest({expectedVersion:1,changes:[{id:'plan:hvac',price:275}]}),env:{...localEnv(db),CATALOG_DEPLOY_HOOK_URLS:'https://hooks.test/secret'}});
    assert.equal(response.status,200);assert.equal((await response.json()).publish.status,'failed');assert.equal(db.version,2);
    assert.ok(Date.now()-start<6500);
  }finally{globalThis.fetch=savedFetch;db.close();}
});

test('current submission CHECK blocks full-name changes before writes; other catalog fields remain editable',async()=>{
  const db=new SqliteD1({through:8}),savedFetch=globalThis.fetch;let hooks=0;globalThis.fetch=async()=>{hooks++;return Response.json({ok:true});};
  try{
    const get=await onRequestGet({request:new Request('http://localhost/api/pricing-admin'),env:localEnv(db)});
    assert.equal((await get.json()).planNamesEditable,false);
    const res=await onRequestPut({request:putRequest({expectedVersion:1,changes:[{id:'plan:hvac',label:'Would break intake',description:'Changed'}]}),env:{...localEnv(db),CATALOG_DEPLOY_HOOK_URLS:'https://hooks.test/private'}});
    assert.equal(res.status,400);assert.match((await res.json()).fieldErrors['changes.0.label'],/pending database schema update/);
    assert.equal(db.version,1);assert.equal(db.audit.length,0);assert.equal(hooks,0);
    const other=await put(db,{expectedVersion:1,changes:[{id:'plan:hvac',shortLabel:'Comfort',description:'New description'},{id:'addon:qfc',label:'New filter name'}]});
    assert.equal(other.status,200);assert.equal(db.version,2);assert.equal(db.audit.length,3);
  }finally{globalThis.fetch=savedFetch;db.close();}
});
