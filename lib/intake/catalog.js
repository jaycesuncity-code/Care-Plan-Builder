// Server-side price catalog for the public Care Plan intake endpoint.
//
// This is a deliberate MIRROR of the arrays inside the Care Plan Builder
// (public/memberships/index.html in the sandbox, the LiveCanvas block in
// WordPress): PLANS, ADDON_GROUPS and MAX_ADDON_QTY. The client's prices are
// never trusted — every number recorded in D1 and emailed to the office is
// recomputed here from these tables.
//
// Drift protection: tests/catalog-parity.test.mjs parses the arrays straight
// out of the builder HTML and fails if anything below disagrees. If you change
// a price in the builder, change it here too and the test will confirm it.
//
// Pricing rules mirrored from the builder's renderTotal():
//   - a plan covers one or more systems ("hvac" / "plumbing"); an add-on whose
//     system isn't covered is "locked" — kept for the office, never billed
//   - `quantityOnly` add-ons (the two equipment counts) include `included`
//     units in the base plan and bill `price` per unit ABOVE that count
//   - Premier's Water Softener Salt is conditional: each paid Water Softener
//     Service creates one $0 salt line; without that service there is no salt line
//   - Reverse Osmosis Service is always a normal paid add-on; Premier's free RO
//     filters are a plan perk, not a separate priced/catalog line
//   - no add-on quantity may exceed MAX_ADDON_QTY

export const MAX_ADDON_QTY = 9;

export const PLANS = [
  { id: "hvac", full: "HVAC Care Plan", price: 260, covers: ["hvac"] },
  { id: "plumbing", full: "Plumbing Care Plan", price: 160, covers: ["plumbing"] },
  { id: "bundled", full: "Bundled Care Plan", price: 400, covers: ["hvac", "plumbing"] },
  { id: "premier", full: "Premier Care Plan", price: 600, covers: ["hvac", "plumbing"] },
];

export const ADDON_GROUPS = [
  {
    system: "hvac",
    items: [
      { id: "hvacSystems", name: "# of HVAC Systems", price: 125, quantityOnly: true, included: 1 },
      { id: "qfc", name: "Quarterly Filter Change", price: 120 },
      { id: "mst", name: "Mini-Split Tune-Up", price: 80 },
    ],
  },
  {
    system: "plumbing",
    items: [
      { id: "waterHeaters", name: "# of Water Heaters", price: 50, quantityOnly: true, included: 1 },
      { id: "wsv", name: "Water Softener Service", price: 75 },
      { id: "wss", name: "Water Softener Salt", price: 68, includedIn: ["premier"], includedWith: "wsv" },
      { id: "ros", name: "Reverse Osmosis Service", price: 50 },
      { id: "twf", name: "Tankless Water Heater Flush", price: 40 },
      { id: "qbb", name: "Quarterly BigBlue Filter Change", price: 180 },
    ],
  },
];

// id -> item (with `system` attached, same as the builder's ADDON_INDEX)
export const ADDON_INDEX = (() => {
  const index = {};
  for (const group of ADDON_GROUPS) {
    for (const item of group.items) {
      index[item.id] = { ...item, system: group.system };
    }
  }
  return index;
})();

export const PLAN_INDEX = (() => {
  const index = {};
  for (const plan of PLANS) index[plan.id] = plan;
  return index;
})();

export function getPlan(planId) {
  return PLAN_INDEX[planId] || null;
}

export function getAddon(addonId) {
  return ADDON_INDEX[addonId] || null;
}

// Labels used for the non-billable rows we still record, so office staff can
// see what the customer had on screen without reading it as a charge.
export const INCLUDED_SUFFIX = " (included with plan)";
export const LOCKED_SUFFIX = " (not covered by selected plan)";

/**
 * Recompute the whole selection from the catalog.
 *
 * Input: planId and a list of { id, quantity } (everything else the client
 * sends about pricing is ignored on purpose). Duplicate ids are collapsed,
 * taking the highest quantity. Premier salt is never priced from a client-sent
 * salt quantity; it is derived independently from the selected Water Softener
 * Service quantity.
 *
 * Output: { planId, plan, basePrice, lines[], addonTotal, total,
 *           monthlyEquivalent }
 * where each line is { id, name, storedName, unitPrice, quantity, lineTotal,
 *                      includedFree, locked, billable }
 */
export function priceSelection(planId, requestedAddons) {
  const plan = getPlan(planId);
  if (!plan) throw new Error(`Unknown planId: ${planId}`);

  // Collapse duplicates by id, keeping the largest quantity seen.
  const wanted = new Map();
  for (const entry of requestedAddons || []) {
    const item = getAddon(entry.id);
    if (!item) throw new Error(`Unknown addon id: ${entry.id}`);
    const quantity = Number(entry.quantity);
    const previous = wanted.get(item.id);
    if (previous == null || quantity > previous) wanted.set(item.id, quantity);
  }

  const lines = [];
  let addonTotal = 0;

  // Iterate the catalog (not the request) so line order is stable and
  // independent of whatever order the client happened to send.
  for (const group of ADDON_GROUPS) {
    for (const base of group.items) {
      const item = ADDON_INDEX[base.id];
      const covered = plan.covers.includes(item.system);
      const isIncludedFree = !!(item.includedIn && item.includedIn.includes(plan.id));

      if (item.quantityOnly) {
        if (!wanted.has(item.id)) continue;
        const quantity = wanted.get(item.id);
        const extra = Math.max(0, quantity - item.included);
        const lineTotal = covered ? extra * item.price : 0;
        // A quantity at or below the included count is not a charge and not
        // worth a row of its own — the builder does not send one either.
        if (extra <= 0) continue;
        const billable = covered && lineTotal > 0;
        if (billable) addonTotal += lineTotal;
        lines.push(makeLine(item, quantity, lineTotal, false, !covered, billable));
        continue;
      }

      if (covered && isIncludedFree && item.includedWith) {
        // Conditional Premier benefit: the complimentary salt quantity is
        // authoritative server-side and always matches the paid softener
        // service quantity. Ignore any independent salt quantity the client
        // sends (including stale state from Plumbing/Bundled).
        const pairedQuantity = Number(wanted.get(item.includedWith) || 0);
        if (pairedQuantity > 0) {
          lines.push(makeLine(item, pairedQuantity, 0, true, false, false));
        }
        continue;
      }

      if (!wanted.has(item.id)) continue;
      const quantity = wanted.get(item.id);
      if (quantity <= 0) continue;
      const lineTotal = covered ? item.price * quantity : 0;
      const billable = covered && lineTotal > 0;
      if (billable) addonTotal += lineTotal;
      lines.push(makeLine(item, quantity, lineTotal, false, !covered, billable));
    }
  }

  const total = plan.price + addonTotal;

  return {
    planId: plan.id,
    plan: plan.full,
    basePrice: plan.price,
    lines,
    addonTotal,
    total,
    monthlyEquivalent: Math.round((total / 12) * 100) / 100,
  };
}

function makeLine(item, quantity, lineTotal, includedFree, locked, billable) {
  let storedName = item.name;
  if (includedFree) storedName += INCLUDED_SUFFIX;
  else if (locked) storedName += LOCKED_SUFFIX;
  return {
    id: item.id,
    name: item.name,
    storedName,
    unitPrice: item.price,
    quantity,
    lineTotal,
    includedFree,
    locked,
    billable,
  };
}
