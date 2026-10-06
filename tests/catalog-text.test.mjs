import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertCatalogText, validateCatalogString, priceSelection } from '../lib/intake/catalog.js';
import { loadCatalog, catalogFromRows } from '../lib/intake/pricing.js';
import { onRequestGet } from '../functions/api/pricing.js';
import { fixturePricing, fixtureRows } from './pricing-fixture.mjs';
import { SqliteD1 } from './sqlite-d1.mjs';
import { onRequestPost } from '../functions/api/care-plan-request.js';

for (const [kind,id,field,max] of [['plans','hvac','full',60],['plans','hvac','name',20],['plans','hvac','tagline',400],['addons','qfc','name',60],['addons','qfc','desc',600]]) {
  test(`catalog ${kind}.${field} enforces nonempty text and ${max}-character boundary`,()=>{
    const text=fixturePricing().text;
    text[kind][id][field]='x'.repeat(max);
    assert.equal(assertCatalogText(text)[kind][id][field].length,max);
    text[kind][id][field]='x'.repeat(max+1);assert.throws(()=>assertCatalogText(text));
    for(const bad of ['', '   ', null, 42, ['hi']]){text[kind][id][field]=bad;assert.throws(()=>assertCatalogText(text));}
  });
}

test('text rejects markup, every C0/C1 control and invisible/line controls before trimming',()=>{
  for(const bad of ['<','>', ...Array.from({length:32},(_,i)=>String.fromCharCode(i)), ...Array.from({length:33},(_,i)=>String.fromCharCode(i+127)), '\u200b','\u2028','\u2029']){
    assert.throws(()=>validateCatalogString(bad+'name',60),JSON.stringify(bad));
  }
  assert.equal(validateCatalogString('  Jayce & "Sun City"  ',60),'Jayce & "Sun City"');
  for(const bad of [undefined,{},[],{plans:[],addons:{}}, {plans:{},addons:{}}])assert.throws(()=>assertCatalogText(bad));
});

test('loadCatalog uses migrated text and rejects missing metadata/text rather than seeding gaps',async()=>{
  const db=new SqliteD1();
  try{
    const catalog=await loadCatalog(db);
    assert.deepEqual(catalog.text, fixturePricing().text);
    assert.equal(catalog.plans.hvac,260);
    db.sqlite.exec("UPDATE pricing_items SET description=NULL WHERE id='addon:qbb'");
    await assert.rejects(loadCatalog(db));
    assert.throws(()=>catalogFromRows({version:0},fixtureRows()));
    assert.throws(()=>catalogFromRows({version:1},[...fixtureRows(), fixtureRows()[0]]));
  }finally{db.close();}
});

test('live API and zero-dependency fixture build produce identical JSON bytes',async()=>{
  const db=new SqliteD1(), dir=mkdtempSync(join(tmpdir(),'catalog-test-'));
  try{
    const meta={version:7,updated_at:'2026-10-06 12:00:00'},items=fixtureRows();
    items[0].label='Renamed HVAC';
    db.sqlite.prepare('UPDATE pricing_items SET label=? WHERE id=?').run(items[0].label,items[0].id);
    db.sqlite.prepare('UPDATE pricing_meta SET version=?,updated_at=? WHERE id=1').run(meta.version,meta.updated_at);
    const path=join(dir,'fixture.json');writeFileSync(path,JSON.stringify({meta,items}));
    const run=spawnSync(process.execPath,['scripts/build-catalog.mjs','--fixture',path],{encoding:'utf8',timeout:10000});
    assert.equal(run.status,0,run.stderr);
    const staticBody=readFileSync(new URL('../public/catalog.json',import.meta.url),'utf8');
    const response=await onRequestGet({request:new Request('https://example.test/api/pricing'),env:{DB:db}});
    assert.equal(response.status,200);assert.equal(await response.text(),staticBody);
    items[0].description='';writeFileSync(path,JSON.stringify({meta,items}));
    assert.notEqual(spawnSync(process.execPath,['scripts/build-catalog.mjs','--fixture',path],{timeout:10000}).status,0);
    assert.equal(readFileSync(new URL('../public/catalog.json',import.meta.url),'utf8'),staticBody,'failed build leaves previous artifact intact');
    const missing=spawnSync(process.execPath,['scripts/build-catalog.mjs'],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});
    assert.notEqual(missing.status,0);
    assert.doesNotMatch(missing.stderr,/Bearer|undefined\/d1/);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});rmSync(new URL('../public/catalog.json',import.meta.url),{force:true});}
});

test('renames preserve price rules and included/locked stored-name suffixes',()=>{
  const pricing=fixturePricing();pricing.text.plans.premier.full='Jayce Premier';
  pricing.text.addons.wss.name='Salt renamed';pricing.text.addons.wsv.name='Service renamed';
  const result=priceSelection('premier',[{id:'wsv',quantity:2}],pricing);
  assert.equal(result.plan,'Jayce Premier');assert.equal(result.total,750);
  assert.equal(result.lines[1].storedName,'Salt renamed (included with plan)');
  const locked=priceSelection('hvac',[{id:'wsv',quantity:1}],pricing);
  assert.equal(locked.lines[0].storedName,'Service renamed (not covered by selected plan)');
});

test('with 0009: intake persists D1 names, emails D1 names and leaves historical rows untouched',async()=>{
  const db=new SqliteD1(), savedFetch=globalThis.fetch, deferred=[];let notification;
  const before=db.sqlite.prepare('SELECT id,plan FROM submissions ORDER BY id').all().map(r=>({...r}));
  db.sqlite.exec("UPDATE pricing_items SET label='New HVAC Name' WHERE id='plan:hvac'; UPDATE pricing_items SET label='New Filter Name' WHERE id='addon:qfc'");
  globalThis.fetch=async(url,options)=>{
    if(String(url).includes('office.test')){notification=JSON.parse(options.body);return Response.json({ok:true});}
    return Response.json({success:true});
  };
  try{
    const res=await onRequestPost({request:new Request('https://example.test/api/care-plan-request',{method:'POST',body:JSON.stringify({customerName:'Local Test',phone:'5755550142',address:'1 Test',turnstileToken:'test',pricingVersion:1,planId:'hvac',addons:[{id:'qfc',quantity:1}],basePrice:260,total:380})}),
      env:{DB:db,TURNSTILE_SECRET:'local-test',IP_HASH_SALT:'local-test',N8N_WEBHOOK_URL:'https://office.test',N8N_WEBHOOK_SECRET:'mock-only'},waitUntil(p){deferred.push(p);}});
    assert.equal(res.status,201);const body=await res.json();await Promise.all(deferred);
    const row=db.sqlite.prepare('SELECT plan FROM submissions WHERE id=?').get(body.submissionId);
    assert.equal(row.plan,'New HVAC Name');assert.equal(notification.plan.name,row.plan);
    assert.equal(db.sqlite.prepare('SELECT addon_name FROM submission_addons WHERE submission_id=?').get(body.submissionId).addon_name,'New Filter Name');
    assert.equal(notification.addons[0].name,'New Filter Name');
    assert.deepEqual(db.sqlite.prepare('SELECT id,plan FROM submissions WHERE id<=4 ORDER BY id').all().map(r=>({...r})),before);
  }finally{globalThis.fetch=savedFetch;db.close();}
});

test('catalog is excluded from Functions and has public CORS/cache/security headers',()=>{
  const routes=JSON.parse(readFileSync(new URL('../public/_routes.json',import.meta.url)));
  assert.ok(routes.exclude.includes('/catalog.json'));
  const headers=readFileSync(new URL('../public/_headers',import.meta.url),'utf8');
  assert.match(headers,/\/\*\n  X-Robots-Tag: noindex, nofollow/);
  assert.match(headers,/\/catalog.json\n  Access-Control-Allow-Origin: \*\n  Cache-Control: public, max-age=60, must-revalidate/);
});

test('0009 preserves every historical value, child, constraint and deleted-ID high-water mark',()=>{
  const db=new SqliteD1({through:8});
  try{
    const snapshot=()=>Object.fromEntries(['submissions','submission_addons','submission_notes','pricing_items','pricing_audit','pricing_meta'].map(table=>[table,db.sqlite.prepare('SELECT * FROM '+table+' ORDER BY id').all().map(row=>({...row}))]));
    db.sqlite.exec("UPDATE sqlite_sequence SET seq=999 WHERE name='submissions'");
    const before=snapshot(),draft=readFileSync(new URL('../migrations/0009_submission_plan_names.sql',import.meta.url),'utf8');
    db.sqlite.exec('BEGIN');db.sqlite.exec(draft);db.sqlite.exec('COMMIT');
    assert.deepEqual(snapshot(),before);
    assert.equal(db.sqlite.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('submissions').seq,999);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM sqlite_sequence WHERE name='submissions'").get().n,1);
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
    db.sqlite.exec("INSERT INTO submissions (name,phone,address,best_time,plan,base_price,addon_total,total_price,status,is_test) VALUES ('Test','5755550142','1 St','Midday','Renamed plan',260,0,260,'New',1)");
    assert.equal(db.sqlite.prepare('SELECT max(id) AS n FROM submissions').get().n,1000);
    for(const sql of ["UPDATE submissions SET is_test=2 WHERE id=1000","UPDATE submissions SET status='Bad' WHERE id=1000","UPDATE submissions SET best_time='Bad' WHERE id=1000","UPDATE submissions SET plan='' WHERE id=1000","UPDATE submissions SET plan='<script>' WHERE id=1000"]){assert.throws(()=>db.sqlite.exec(sql));}
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%backup_0009'").get().n,0);
  }finally{db.close();}
});
