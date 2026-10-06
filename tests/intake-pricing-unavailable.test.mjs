import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/care-plan-request.js';
import { fixturePricing, fixtureRows } from './pricing-fixture.mjs';

const lead = { planId: 'premier', addons: [{ id: 'wsv', quantity: 2 }, { id: 'ros', quantity: 1 }],
  customerName: 'Test', phone: '5755550142', address: '1 Test St', turnstileToken: 'test',
  pricingVersion: 1, basePrice: 600, total: 800 };

function database(issue) {
  const prices = fixturePricing();
  if (issue === 'missing-plan') delete prices.plans.hvac;
  if (issue === 'missing-addon') delete prices.addons.qbb;
  if (issue === 'invalid-plan') prices.plans.premier = 0;
  if (issue === 'invalid-addon') prices.addons.ros = '50';
  const db = { writes: 0,
    prepare(sql) {
      return { sql, bind() { return this; }, async first() { return { hits: 0 }; },
        async run() { if (/INSERT INTO (submissions|submission_addons|intake_rate_limit)/.test(sql)) db.writes++; return { meta: { last_row_id: 15 } }; } };
    },
    async batch(statements) {
      if (issue === 'down') throw new Error('D1 unavailable');
      if (statements.some(s => /INSERT/.test(s.sql))) { db.writes++; return []; }
      return [{ results: [{ version: issue === 'invalid-version' ? null : 2 }] }, {
        results: fixtureRows(prices)
      }];
    }
  };
  return db;
}

for (const issue of ['down', 'missing-plan', 'missing-addon', 'invalid-plan', 'invalid-addon', 'invalid-version', 'no-binding', 'no-client-version']) {
  test(`intake ${issue} saves nothing and sends no office notification`, async () => {
    const db = database(issue);
    const savedFetch = globalThis.fetch;
    let notifications = 0, deferred = 0;
    globalThis.fetch = async url => {
      if (String(url).includes('office')) { notifications++; return new Response('{}'); }
      return Response.json({ success: true });
    };
    try {
      const body = { ...lead, ...(issue === 'no-client-version' ? { pricingVersion: null } : {}) };
      const res = await onRequestPost({ request: new Request('https://example.test/api/care-plan-request', {
        method: 'POST', body: JSON.stringify(body) }),
        env: { DB: issue === 'no-binding' ? undefined : db, TURNSTILE_SECRET: 'test', N8N_WEBHOOK_URL: 'https://office.test' },
        waitUntil() { deferred++; } });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).code, 'PRICING_UNAVAILABLE');
      assert.equal(db.writes, 0);
      assert.equal(notifications, 0);
      assert.equal(deferred, 0);
    } finally { globalThis.fetch = savedFetch; }
  });
}

test('valid stale pricing returns fresh complete prices for review without writing or notifying', async () => {
  const db = database();
  const savedFetch = globalThis.fetch;
  let notifications = 0;
  globalThis.fetch = async url => { if (String(url).includes('office')) notifications++; return Response.json({ success: true }); };
  try {
    const res = await onRequestPost({ request: new Request('https://example.test/api/care-plan-request', {
      method: 'POST', body: JSON.stringify({ ...lead, total: 700 }) }),
      env: { DB: db, TURNSTILE_SECRET: 'test', N8N_WEBHOOK_URL: 'https://office.test' }, waitUntil() {} });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'PRICES_CHANGED');
    assert.equal(body.pricing.version, 2);
    assert.equal(body.pricing.addons.ros, 50);
    assert.equal(db.writes, 0);
    assert.equal(notifications, 0);
  } finally { globalThis.fetch = savedFetch; }
});

test('Premier detail copy distinguishes paid services, conditional salt, filters, and fee waiver', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(new URL('../public/premier-care-plan/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /2 free after-hours calls|no add-on required|Two of them are already included/);
  assert.match(page, /Service calls, repairs, and other applicable charges still apply/);
  assert.match(page, /salt quantity matches the service quantity/);
  assert.match(page, /Reverse Osmosis Service is a paid add-on/);
  assert.match(page, /replacement RO filters provided during that service/);
  assert.match(page, /After-hours fee waived on up to 2 calls per year/);
});
