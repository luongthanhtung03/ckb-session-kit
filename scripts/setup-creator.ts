/**
 * Gives the pay-per-read creator N anyone-can-pay cells (default 8), paid by
 * the funder, with the library's `createPayoutCells`. Each payment consumes one
 * of these cells, so readers paying at the same moment compete for them; with
 * more cells they rarely pick the same one (mentor review, 2 Nov). A payment
 * reads at most MAX_PAYOUT_CELLS (64) of them.
 *
 * Usage: FUNDER_KEY=0x... CREATOR_KEY=0x... npm run setup:creator [-- N]
 */
import { ccc } from "@ckb-ccc/core";
import { createPayoutCells, MAX_PAYOUT_CELLS } from "../src/onchain.js";

async function main(): Promise<void> {
  const { FUNDER_KEY, CREATOR_KEY } = process.env;
  if (!FUNDER_KEY || !CREATOR_KEY) throw new Error("set FUNDER_KEY and CREATOR_KEY to testnet private keys");
  const want = Number(process.argv[2] ?? 8);
  if (!Number.isInteger(want) || want < 1 || want > MAX_PAYOUT_CELLS) throw new Error(`N must be 1 to ${MAX_PAYOUT_CELLS}`);
  const client = new ccc.ClientPublicTestnet();
  const funder = new ccc.SignerCkbPrivateKey(client, FUNDER_KEY);
  const creator = new ccc.SignerCkbPrivateKey(client, CREATOR_KEY);
  const args = (await creator.getRecommendedAddressObj()).script.args;
  const acp = await ccc.Address.fromKnownScript(client, ccc.KnownScript.AnyoneCanPay, args);

  let have = 0;
  let balance = 0n;
  for await (const cell of client.findCellsByLock(acp.script, null, true)) {
    if (cell.cellOutput.type || cell.outputData !== "0x") continue; // only plain cells take CKB top-ups
    have++;
    balance += cell.cellOutput.capacity;
  }
  console.log(`creator ${acp.toString()}`);
  console.log(`  ${have} plain anyone-can-pay cell(s), ${ccc.fixedPointToString(balance)} CKB`);
  console.log(`funder balance ${ccc.fixedPointToString(await funder.getBalance())} CKB`);
  if (have >= want) return;

  const hash = await createPayoutCells(funder, acp.toString(), { count: want - have });
  console.log(`added ${want - have} cell(s): https://testnet.explorer.nervos.org/transaction/${hash}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
