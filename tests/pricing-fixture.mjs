// Explicit test-only price fixture; production never substitutes these seed prices.
import { PLANS, ADDON_INDEX, priceSelection as calculate } from '../lib/intake/catalog.js';
export function fixturePricing(overrides = {}) {
  return {
    version: 1,
    plans: { ...Object.fromEntries(PLANS.map(p => [p.id, p.price])), ...overrides.plans },
    addons: { ...Object.fromEntries(Object.values(ADDON_INDEX).map(a => [a.id, a.price])), ...overrides.addons },
  };
}
export function priceSelection(plan, addons, prices) {
  return calculate(plan, addons, fixturePricing(prices));
}
