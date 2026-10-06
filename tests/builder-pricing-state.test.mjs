import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { fixturePricing } from './pricing-fixture.mjs';
const html = readFileSync(new URL('../public/careplan-builder/index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('var PLANS'));
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(fetchImpl) {
  const w = new Window({ url: 'https://care.example/careplan-builder/', settings: {
    disableCSSFileLoading: true, disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true,
  } });
  w.document.body.innerHTML = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  w.fetch = fetchImpl;
  w.turnstile = { render: () => 'test', reset() {}, getResponse: () => 'test-token' };
  // Execute the entire real Builder script against a DOM, not a copy of its handlers.
  w.eval(script);
  const q = selector => w.document.querySelector(selector);
  return { w, q, root: q('#sc-cpb'), cta: q('[data-cpb="cta"]'),
    modal: q('#cpbLeadModal'), submit: q('#cpbLeadSubmitBtn'), close: () => w.happyDOM.close() };
}
function unavailable(h) {
  assert.equal(h.root.getAttribute('data-pricing'), 'unavailable');
  assert.match(h.q('[data-cpb="pricing-status"]').textContent, /Current pricing is unavailable\./);
  assert.match(h.q('[data-cpb="pricing-status"]').textContent, /Please call our office at 575-526-9758 for current pricing and help choosing your Care Plan\./);
  assert.equal(h.q('[data-cpb="pricing-status"] a').getAttribute('href'), 'tel:5755269758');
  assert.equal(h.cta.disabled, true);
  assert.equal(h.submit.disabled, true);
  assert.equal(h.q('[data-cpb="total"]').textContent, '—');
  assert.equal(h.q('[data-cpb="monthly"]').textContent, '—');
  assert.equal(JSON.parse(h.root.getAttribute('data-selection')), null);
  for (const el of h.w.document.querySelectorAll('.cpb-plan-price,.cpb-addon-price,.cpb-addon-note,.cpb-line-price')) {
    assert.doesNotMatch(el.textContent, /\$\d/);
  }
}

test('initial pricing load renders no seed prices and cannot open or submit a request', async () => {
  const h = harness(() => new Promise(() => {}));
  try {
    assert.equal(h.root.getAttribute('data-pricing'), 'loading');
    assert.match(h.q('[data-cpb="pricing-status"]').textContent, /Loading current pricing/);
    assert.equal(h.cta.disabled, true);
    assert.equal(h.submit.disabled, true);
    assert.equal(h.q('[data-cpb="total"]').textContent, '—');
    assert.equal(h.q('[data-cpb="monthly"]').textContent, '—');
    h.cta.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
    assert.equal(h.modal.hidden, true);
    assert.equal(JSON.parse(h.root.getAttribute('data-selection')), null);
  } finally { await h.close(); }
});

for (const issue of ['network', 'http', 'json', 'malformed', 'missing-plan', 'missing-addon', 'invalid-addon', 'timeout', 'body-timeout']) {
  test(`${issue} produces unavailable prices and a phone link without automatic retries`, async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      if (issue === 'network') throw new Error('offline');
      if (issue === 'http') return { ok: false };
      if (issue === 'timeout') return new Promise(() => {});
      return { ok: true, json: async () => {
        if (issue === 'body-timeout') return new Promise(() => {});
        if (issue === 'json') throw new Error('invalid JSON');
        if (issue === 'malformed') return { plans: [] };
        const p = fixturePricing();
        if (issue === 'missing-plan') delete p.plans.bundled;
        if (issue === 'missing-addon') delete p.addons.qfc;
        if (issue === 'invalid-addon') p.addons.ros = null;
        return p;
      } };
    });
    try {
      if (issue.includes('timeout')) await new Promise(resolve => setTimeout(resolve, 1550));
      await tick(); await tick();
      unavailable(h);
      await tick();
      assert.equal(calls, 1);
    } finally { await h.close(); }
  });
}

for (const responseType of ['unavailable', 'invalid-conflict', 'valid-conflict']) {
  test(`intake ${responseType} response blocks acceptance or requires fresh review`, async () => {
    let posts = 0;
    const h = harness(async url => {
      if (!String(url).includes('care-plan-request')) return { ok: true, json: async () => fixturePricing() };
      posts++;
      const p = fixturePricing({ plans: { premier: 650 } }); p.version = 2;
      if (responseType === 'invalid-conflict') delete p.addons.qbb;
      return { ok: false, status: responseType === 'unavailable' ? 503 : 409, json: async () =>
        responseType === 'unavailable' ? { code: 'PRICING_UNAVAILABLE' } : { error: { code: 'PRICES_CHANGED' }, pricing: p } };
    });
    try {
      await tick(); await tick(); h.q('[data-plan="premier"]').click(); h.cta.click();
      h.q('#cpbLeadName').value = 'Test'; h.q('#cpbLeadPhone').value = '5755550142';
      h.q('#cpbLeadAddress').value = '1 Test St'; h.q('#cpbLeadAck').checked = true;
      h.q('#cpbLeadForm').dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
      await tick(); await tick();
      assert.equal(posts, 1);
      assert.equal(h.q('#cpbLeadConfirm').hidden, true);
      if (responseType === 'valid-conflict') {
        assert.equal(h.root.getAttribute('data-pricing'), 'ready');
        assert.match(h.q('#cpbLeadRecap').textContent, /\$650/);
        assert.match(h.q('#cpbLeadFormError').textContent, /review your updated total/);
        assert.equal(h.submit.disabled, false);
      } else unavailable(h);
    } finally { await h.close(); }
  });
}

test('409 refresh preserves the selected plan and quantities while requiring another review', async () => {
  let posts=0;
  const h=harness(async url=>{
    if(!String(url).includes('care-plan-request'))return {ok:true,json:async()=>fixturePricing()};
    posts++;const pricing=fixturePricing({plans:{premier:650}});pricing.version=2;
    return {ok:false,status:409,json:async()=>({error:{code:'PRICES_CHANGED'},pricing})};
  });
  try{
    await tick();await tick();h.q('[data-plan="premier"]').click();h.q('[data-addon="wsv"]').click();
    h.q('[data-coverage-qty="hvacSystems"] [data-qty-plus="hvacSystems"]').click();
    const before=JSON.parse(h.root.getAttribute('data-selection'));
    h.cta.click();h.q('#cpbLeadName').value='Test';h.q('#cpbLeadPhone').value='5755550142';h.q('#cpbLeadAddress').value='1 St';h.q('#cpbLeadAck').checked=true;
    h.q('#cpbLeadForm').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();
    const after=JSON.parse(h.root.getAttribute('data-selection'));
    assert.equal(posts,1);assert.equal(after.planId,before.planId);assert.deepEqual(after.addons,before.addons);assert.equal(after.total,before.total+50);
    assert.equal(h.q('#cpbLeadConfirm').hidden,true);assert.match(h.q('#cpbLeadFormError').textContent,/review your updated total/);
  }finally{await h.close();}
});
