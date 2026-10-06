// Explicit test-only price fixture; production never substitutes these seed prices.
import { PLANS, ADDON_INDEX, priceSelection as calculate } from '../lib/intake/catalog.js';
import { readBuilderSeed } from '../scripts/catalog-seed.mjs';
const seed = readBuilderSeed();
export function fixturePricing(overrides = {}) {
  return {
    version: 1,
    text: {
      plans: { ...Object.fromEntries(seed.plans.map(p => [p.id, { full: p.full, name: p.name, tagline: p.tagline }])), ...overrides.text?.plans },
      addons: { ...Object.fromEntries(seed.addons.map(a => [a.id, { name: a.name, desc: a.desc }])), ...overrides.text?.addons },
    },
    plans: { ...Object.fromEntries(PLANS.map(p => [p.id, p.price])), ...overrides.plans },
    addons: { ...Object.fromEntries(Object.values(ADDON_INDEX).map(a => [a.id, a.price])), ...overrides.addons },
  };
}
export function priceSelection(plan, addons, prices) {
  return calculate(plan, addons, fixturePricing(prices));
}

export function fixtureRows(prices = fixturePricing()) {
  return Object.entries(prices.plans).map(([id, price]) => ({ id: 'plan:' + id, kind: 'plan', price,
    label: prices.text.plans[id].full, short_label: prices.text.plans[id].name, description: prices.text.plans[id].tagline }))
    .concat(Object.entries(prices.addons).map(([id, price]) => ({ id: 'addon:' + id, kind: 'addon', price,
      label: prices.text.addons[id].name, short_label: null, description: prices.text.addons[id].desc })));
}
