// Prints the pricing_items seed block for migrations/0006_pricing.sql.
// Prices and labels come from the catalog so they are never retyped here.

import { ADDON_GROUPS, PLANS } from "../lib/intake/catalog.js";

function sqlString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

const rows = [
  ...PLANS.map((plan) => ({
    id: `plan:${plan.id}`,
    kind: "plan",
    label: plan.full,
    price: plan.price,
  })),
  ...ADDON_GROUPS.flatMap((group) =>
    group.items.map((item) => ({
      id: `addon:${item.id}`,
      kind: "addon",
      label: item.name,
      price: item.price,
    }))
  ),
];

const values = rows.map(
  (row) =>
    `  (${sqlString(row.id)}, ${sqlString(row.kind)}, ${sqlString(row.label)}, ${row.price}, NULL, NULL)`
);

process.stdout.write(
  [
    "-- BEGIN GENERATED PRICING SEED",
    "INSERT INTO pricing_items (id, kind, label, price, updated_at, updated_by) VALUES",
    values.join(",\n") + ";",
    "-- END GENERATED PRICING SEED",
    "",
  ].join("\n")
);
