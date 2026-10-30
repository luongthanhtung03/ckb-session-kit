/**
 * Creates the /subscribe demo's charger key: a fresh secp256k1 key of its own,
 * kept in .env.charger (gitignored), apart from the creator's key.
 *
 * The charger key sits in the server's environment (CHARGER_KEY on Vercel), so
 * it must hold nothing but a few fee cells. The session lock already limits what
 * it can take from a subscription (one price per period, to the payout address
 * only); but if it were the creator's key, whoever read the server's environment
 * could also spend the creator's income and payout cells (security audit, 30 Oct).
 *
 * Nothing is sent and nothing is funded. The key is written once ("wx": never
 * replaced, since it may already hold fee cells or charge subscriptions); run the
 * script again to see its address. The private key is never printed.
 *
 * Usage: npm run setup:charger
 */
import { ccc } from "@ckb-ccc/core";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const KEY_FILE = ".env.charger";

/** The charger key from .env.charger, created on first run. */
function chargerKey(): { key: string; created: boolean } {
  if (existsSync(KEY_FILE)) {
    const key = /^CHARGER_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(KEY_FILE, "utf8"))?.[1];
    if (!key) throw new Error(`${KEY_FILE} has no CHARGER_KEY=0x… line; fix or remove it`);
    return { key, created: false };
  }
  const key = ccc.hexFrom(randomBytes(32));
  writeFileSync(KEY_FILE, `# /subscribe charger key (testnet). Fee cells only. Never commit.\nCHARGER_KEY=${key}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { key, created: true };
}

async function main(): Promise<void> {
  const client = new ccc.ClientPublicTestnet();
  const { key, created } = chargerKey();
  const address = await new ccc.SignerCkbPrivateKey(client, key).getRecommendedAddress();
  console.log(created ? `created ${KEY_FILE}` : `${KEY_FILE} already exists; its key is kept`);
  console.log(`charger ${address}`);
  console.log("next:");
  console.log("  1. fund it with a few plain cells of about 100 CKB each, for fees (testnet faucet,");
  console.log("     https://faucet.nervos.org/, then split them from a wallet if the faucet sends one cell)");
  console.log("  2. set CHARGER in demo/app/subscribe/config.ts to the address above, and drop the");
  console.log("     skip in demo/app/subscribe/config.test.ts");
  console.log(`  3. set CHARGER_KEY on Vercel to the value in ${KEY_FILE}, then redeploy`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
