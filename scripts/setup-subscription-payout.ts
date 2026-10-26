/**
 * Gives the /subscribe demo its own payout address, apart from the one paid
 * reads top up: the creator's key under the anyone-can-pay lock with one more
 * args byte (a CKB minimum of 10^0 shannons, so any amount still passes). Same
 * key, different lock hash. With a payout address of its own, no payment can be
 * both a paid read and a subscription period (review, 27 Oct).
 *
 * Creates the cells charges top up, paid by the funder: one plain CKB cell, and
 * one cell of the demo token holding 0 units (xUDT allows a new cell of 0).
 *
 * Usage: FUNDER_KEY=0x... CREATOR_KEY=0x... npm run setup:subscription-payout
 */
import { ccc } from "@ckb-ccc/core";
import { demoToken } from "../demo/app/tokens/token.js";

async function main(): Promise<void> {
  const { FUNDER_KEY, CREATOR_KEY } = process.env;
  if (!FUNDER_KEY || !CREATOR_KEY) throw new Error("set FUNDER_KEY and CREATOR_KEY to testnet private keys");
  const client = new ccc.ClientPublicTestnet({ url: process.env.CKB_RPC_URL ?? "https://testnet.ckb.dev/" });
  const funder = new ccc.SignerCkbPrivateKey(client, FUNDER_KEY);
  const creator = new ccc.SignerCkbPrivateKey(client, CREATOR_KEY);
  const args = (await creator.getRecommendedAddressObj()).script.args;
  const payout = await ccc.Address.fromKnownScript(client, ccc.KnownScript.AnyoneCanPay, `${args}00`);
  const token = await demoToken(client);
  console.log(`subscription payout: ${payout.toString()}`);

  let plain = false;
  let tokenCell = false;
  for await (const cell of client.findCellsByLock(payout.script, null, true)) {
    if (!cell.cellOutput.type) plain = true;
    else if (cell.cellOutput.type.eq(token)) tokenCell = true;
  }
  if (plain && tokenCell) {
    console.log("  already has a plain cell and a demo-token cell");
    return;
  }
  const tx = ccc.Transaction.from({ outputs: [], outputsData: [] });
  if (!plain) tx.addOutput({ lock: payout.script }, "0x");
  if (!tokenCell) tx.addOutput({ lock: payout.script, type: token }, ccc.numLeToBytes(0, 16));
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt);
  await tx.completeInputsByCapacity(funder);
  await tx.completeFeeBy(funder);
  const hash = await funder.sendTransaction(tx);
  console.log(`  created: https://testnet.explorer.nervos.org/transaction/${hash}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
