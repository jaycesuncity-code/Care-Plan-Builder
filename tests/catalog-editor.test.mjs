import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { SqliteD1 } from './sqlite-d1.mjs';
import { onRequestGet, onRequestPut } from '../functions/api/pricing-admin.js';
const html=readFileSync(new URL('../public/pricing/index.html',import.meta.url),'utf8');
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(publish='not_configured',url=''){
  const db=new SqliteD1(),w=new Window({url:'http://localhost/pricing/',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableJavaScriptEvaluation:true}}),pending=[];
  w.document.body.innerHTML=html.replace(/<script>[\s\S]*?<\/script>/g,'');
  w.sessionStorage.setItem('pricingPassphraseOk','1');
  const env={DB:db,DEV_ADMIN_EMAIL:'local@example.com',PUBLIC_CATALOG_URL:url};
  w.fetch=async(endpoint,options={})=>{
    if(endpoint===url && url)return Response.json({version:db.version});
    const request=new Request('http://localhost'+endpoint,options);
    const response=options.method==='PUT'?await onRequestPut({request,env}):await onRequestGet({request,env});
    const data=await response.json();if(options.method==='PUT'){data.publish={status:publish};data.publicCatalogUrl=url;}
    return Response.json(data,{status:response.status});
  };
  const timeout=w.setTimeout.bind(w);
  w.setTimeout=(fn,ms,...args)=>{if(ms>=5000){pending.push({fn,ms,args});return pending.length+10000;}return timeout(fn,ms,...args);};
  w.eval(script);await tick();await tick();
  const q=s=>w.document.querySelector(s);
  function edit(id,key,value){const input=[...w.document.querySelectorAll('[data-field]')].find(el=>el.dataset.item===id && el.dataset.field===key);input.value=value;input.dispatchEvent(new w.Event('input',{bubbles:true}));return input;}
  async function save(){q('#topReviewBtn').click();q('#saveBtn').click();await tick();await tick();}
  return {w,db,q,edit,save,pending,close:async()=>{await w.happyDOM.close();db.close();}};
}

test('editor reviews every text field and price, counts characters, preserves big-price confirmation and audits escaped names',async()=>{
  const h=await harness();try{
    assert.equal(h.q('#editor').hidden,false);
    h.edit('plan:hvac','label','Jayce & "Care"');h.edit('plan:hvac','shortLabel','Comfort');
    const desc=h.edit('plan:hvac','description','Updated & clear description');
    assert.equal(desc.closest('label').querySelector('.counter').textContent,'27 / 400');
    h.edit('plan:hvac','price','400');h.q('#topReviewBtn').click();
    assert.equal(h.q('#reviewList').children.length,4);
    assert.match(h.q('#reviewList').textContent,/HVAC Care Plan → Jayce & "Care"/);
    assert.equal(h.q('#largeWarning').hidden,false);h.q('#saveBtn').click();assert.equal(h.db.version,1);
    h.q('#largeConfirm').checked=true;h.q('#saveBtn').click();await tick();await tick();
    assert.equal(h.db.version,2);assert.equal(h.db.audit.length,4);assert.match(h.q('#statusNotice').textContent,/publishing isn't set up/);
    assert.match(h.q('#audit').textContent,/Description updated/);assert.match(h.q('#audit').textContent,/Name: HVAC Care Plan → Jayce & "Care"/);
    assert.equal(h.q('#audit [onclick]'),null);
  }finally{await h.close();}
});

test('editor maps server validation errors to text fields and retains the proposed value',async()=>{
  const h=await harness();try{
    h.edit('addon:qfc','description','\ninvalid newline');await h.save();
    const input=h.q('[data-item="addon:qfc"][data-field="description"]');
    assert.equal(input.getAttribute('aria-invalid'),'true');assert.match(input.closest('label').querySelector('.field-error').textContent,/control characters/);
    assert.equal(h.db.version,1);assert.equal(input.value,'\ninvalid newline');
  }finally{await h.close();}
});

test('editor retains proposed changes and shows new old-values after version conflict',async()=>{
  const h=await harness();try{
    h.edit('plan:hvac','label','My rename');h.db.sqlite.exec("UPDATE pricing_items SET label='Other rename' WHERE id='plan:hvac'");h.db.version=2;
    await h.save();assert.equal(h.q('#reviewModal').hidden,false);assert.equal(h.q('#conflictNotice').hidden,false);
    assert.match(h.q('#reviewList').textContent,/Other rename → My rename/);assert.equal(h.db.version,2);
  }finally{await h.close();}
});

for(const [publish,url,expected] of [['failed','https://public.test/catalog.json','website update could not be started'],['triggered','','publishing isn\'t set up'],['not_configured','https://public.test/catalog.json','publishing isn\'t set up']]){
  test(`editor publishes ${publish} with ${url?'a URL':'no URL'} status`,async()=>{
    const h=await harness(publish,url);try{h.edit('plan:hvac','label','New name');await h.save();assert.ok(h.q('#statusNotice').textContent.includes(expected));}finally{await h.close();}
  });
}

test('editor polls the static public version with no-store and shows live confirmation',async()=>{
  const h=await harness('triggered','https://public.test/catalog.json');try{
    h.edit('plan:hvac','label','New name');await h.save();assert.match(h.q('#statusNotice').textContent,/about 2 minutes/);
    const saved=h.w.fetch;let calls=0;
    h.w.fetch=async(url,options)=>{if(url.startsWith('https://public')){calls++;assert.equal(options.cache,'no-store');return Response.json({version:2});}return saved(url,options);};
    await h.pending.find(p=>p.ms===10000).fn();await tick();assert.equal(calls,1);assert.equal(h.q('#statusNotice').textContent,'Live on the website ✓');
  }finally{await h.close();}
});

test('editor publication timeout keeps the saved catalog and explains the missing update',async()=>{
  const h=await harness('triggered','https://public.test/catalog.json'),originalNow=h.w.Date.now;try{
    h.edit('plan:hvac','label','New name');await h.save();
    h.w.fetch=async()=>Response.json({version:1});
    const future=originalNow()+300001;h.w.Date.now=()=>future;
    await h.pending.find(p=>p.ms===10000).fn();await tick();assert.match(h.q('#statusNotice').textContent,/hasn't updated yet/);assert.equal(h.db.version,2);
  }finally{h.w.Date.now=originalNow;await h.close();}
});

test('editor makes full-name inputs read-only when the approved schema still restricts submissions.plan',async()=>{
  const db=new SqliteD1({through:8}),w=new Window({url:'http://localhost/pricing/',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableJavaScriptEvaluation:true}});
  w.document.body.innerHTML=html.replace(/<script>[\s\S]*?<\/script>/g,'');w.sessionStorage.setItem('pricingPassphraseOk','1');
  w.fetch=async()=>onRequestGet({request:new Request('http://localhost/api/pricing-admin'),env:{DB:db,DEV_ADMIN_EMAIL:'local@example.com'}});
  try{
    w.eval(script);await tick();await tick();const name=w.document.querySelector('[data-item="plan:hvac"][data-field="label"]');
    assert.equal(name.readOnly,true);assert.match(name.closest('label').textContent,/schema update pending/);
    assert.equal(w.document.querySelector('[data-item="addon:qfc"][data-field="label"]').readOnly,false);
  }finally{await w.happyDOM.close();db.close();}
});
