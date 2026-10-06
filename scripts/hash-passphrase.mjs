import { createHash } from "node:crypto";

const passphrase = process.argv[2];
if (!passphrase) {
  console.error('Usage: node scripts/hash-passphrase.mjs "your passphrase"');
  process.exit(1);
}

const PASSPHRASE_SALT = "care-plan-pricing-speed-bump-v1";
const hash = createHash("sha256").update(PASSPHRASE_SALT + passphrase, "utf8").digest("hex");
process.stdout.write(hash + "\n");
