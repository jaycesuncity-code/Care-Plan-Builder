import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { fixturePricing } from './pricing-fixture.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const scripts=html=>[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
function dom(html,url){
  const w=new Window({url,settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableJavaScriptEvaluation:true}});
  w.document.body.innerHTML=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');return w;
}
const builderHtml=readFileSync(new URL('../public/careplan-builder/index.html',import.meta.url),'utf8');

test('Builder renders D1 labels, descriptions and quote-safe accessible names',async()=>{
  const w=dom(builderHtml,'https://staff.test/careplan-builder/'),pricing=fixturePricing();
  pricing.text.plans.hvac={full:'Comfort & "Care"',name:'Jayce & HVAC',tagline:'A plan for "your" home & systems'};
  pricing.text.addons.qfc={name:'Filters " onclick="oops',desc:'Service for "your" filters & equipment'};
  w.fetch=async()=>({ok:true,json:async()=>pricing});
  w.turnstile={render:()=> 'test',reset(){},getResponse:()=> 'test'};
  try{
    w.eval(scripts(builderHtml).find(s=>s.includes('var PLANS')));await tick();await tick();
    assert.equal(w.document.querySelector('#sc-cpb').getAttribute('data-pricing'),'ready');
    assert.equal(w.document.querySelector('.cpb-detail-name').textContent,'Comfort & "Care"');
    assert.equal(w.document.querySelector('.cpb-detail-tagline').textContent,pricing.text.plans.hvac.tagline);
    assert.equal(w.document.querySelector('[data-plan="hvac"] .cpb-plan-name').textContent,'Jayce & HVAC');
    const info=w.document.querySelector('[data-addon-info="qfc"]');
    assert.equal(info.getAttribute('aria-label'),'More info about Filters " onclick="oops');assert.equal(info.hasAttribute('onclick'),false);
    info.click();assert.equal(w.document.querySelector('#cpb-modal-desc').textContent,pricing.text.addons.qfc.desc);
    w.document.querySelector('[data-cpb="cta"]').click();assert.match(w.document.querySelector('#cpbLeadRecap').textContent,/Comfort & "Care"/);
  }finally{await w.happyDOM.close();}
});

for(const issue of ['missing','missing-field','markup','newline','overlong','array']){
  test(`Builder ${issue} text makes the entire catalog unavailable`,async()=>{
    const w=dom(builderHtml,'https://staff.test/careplan-builder/'),p=fixturePricing();
    if(issue==='missing')delete p.text;
    if(issue==='missing-field')delete p.text.addons.qbb.desc;
    if(issue==='markup')p.text.plans.hvac.full='<bad>';
    if(issue==='newline')p.text.plans.hvac.tagline='\nhello';
    if(issue==='overlong')p.text.plans.hvac.name='x'.repeat(21);
    if(issue==='array')p.text.addons=[];
    w.fetch=async()=>({ok:true,json:async()=>p});
    try{w.eval(scripts(builderHtml).find(s=>s.includes('var PLANS')));await tick();await tick();assert.equal(w.document.querySelector('#sc-cpb').getAttribute('data-pricing'),'unavailable');assert.equal(w.document.querySelector('[data-cpb="cta"]').disabled,true);}
    finally{await w.happyDOM.close();}
  });
}

for(const plan of ['hvac','plumbing','bundled','premier']){
  const html=readFileSync(new URL(`../public/${plan}-care-plan/index.html`,import.meta.url),'utf8');
  const hydration=scripts(html).find(s=>s.includes('var CATALOG_URL'));
  test(`${plan} plan page hydrates names and prices, preserving price formatting and Premier inclusion`,async()=>{
    const w=dom(html,`https://public.test/${plan}-care-plan/`),p=fixturePricing();let calls=0;
    p.plans[plan]=777;p.addons.qfc=129;p.text.plans[plan].full='Updated "Care" & Plan';p.text.addons.qfc.name='Updated & Filter';p.text.addons.qbb.desc='Changed sediment service description';
    w.fetch=async(url,options)=>{calls++;assert.equal(url,'/catalog.json');assert.ok(options.signal);return {ok:true,json:async()=>p};};
    try{
      const oldPrice=w.document.querySelector('[data-cpb-price="plan:'+plan+'"]').textContent;
      w.eval(hydration);await tick();await tick();
      assert.equal(calls,1);assert.equal(w.document.querySelector('[data-cpb-full]').textContent,p.text.plans[plan].full);
      assert.equal(w.document.querySelector('[data-cpb-price="plan:'+plan+'"]').textContent,oldPrice.replace(/\$[\d,]+/,'$777'));
      if(plan!=='plumbing')assert.equal(w.document.querySelector('[data-cpb-price="addon:qfc"]').textContent,'+$129/yr');
      if(plan!=='hvac')assert.equal(w.document.querySelector('[data-cpb-desc="addon:qbb"]').textContent,p.text.addons.qbb.desc);
      if(plan==='premier'){assert.match(w.document.querySelector('.scp-care-addon-inc').textContent,/Included with paid service/);assert.equal(w.document.querySelector('[data-cpb-name="addon:wss"]').textContent,p.text.addons.wss.name);}
      assert.equal(w.document.querySelector('[onclick]'),null);
    }finally{await w.happyDOM.close();}
  });
  for(const issue of ['network','http','json','missing-text','invalid-price','control','timeout','body-timeout']){
    test(`${plan} ${issue} hydration leaves HTML byte-identical`,async()=>{
      const w=dom(html,`https://public.test/${plan}-care-plan/`),p=fixturePricing();
      if(issue==='missing-text')delete p.text.addons.qbb.desc;
      if(issue==='invalid-price')p.addons.qbb=2001;
      if(issue==='control')p.text.plans.premier.name='bad\u0000';
      w.fetch=async()=>{if(issue==='network')throw new Error('offline');if(issue==='timeout')return new Promise(()=>{});return {ok:issue!=='http',json:async()=>{if(issue==='json')throw new Error('bad JSON');if(issue==='body-timeout')return new Promise(()=>{});return p;}};};
      try{
        const before=w.document.body.innerHTML;w.eval(hydration);
        if(issue.includes('timeout'))await new Promise(resolve=>setTimeout(resolve,2050));
        await tick();await tick();assert.equal(w.document.body.innerHTML,before);
      }finally{await w.happyDOM.close();}
    });
  }
}

test('dashboard filter derives sorted distinct historical and renamed plan names without HTML injection',async()=>{
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const source=html.slice(html.indexOf('function refreshPlanOptions()'),html.indexOf('async function loadSubmissions'));
  const w=dom('<select id="planFilter"></select>','https://staff.test');
  try{
    const rows=[{plan:'Z Old Name'},{plan:'New & Name'},{plan:'New & Name'},{plan:'<img onerror=bad>'}];
    const harness=new Function('document','SUBMISSIONS','planFilter',source+'\nrefreshPlanOptions();return planFilter;');
    assert.equal(harness(w.document,rows,'Z Old Name'),'Z Old Name');
    assert.deepEqual([...w.document.querySelectorAll('option')].map(o=>o.textContent),['All plans','<img onerror=bad>','New & Name','Z Old Name']);
    assert.equal(w.document.querySelector('img'),null);assert.equal(harness(w.document,rows,'Removed Name'),'all');
    assert.match(html,/SUBMISSIONS = await res.json\(\);\s*refreshPlanOptions\(\);/);
  }finally{await w.happyDOM.close();}
});
