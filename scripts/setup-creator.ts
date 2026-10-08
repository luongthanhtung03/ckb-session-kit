/**
 * Gives the pay-per-read creator N anyone-can-pay cells (default 3), paid by
 * the funder. Each payment consumes one of these cells, so with several, readers
 * paying at the same moment rarely pick the same one.
 *
 * Usage: FUNDER_KEY=0x... CREATOR_KEY=0x... npm run setup:creator [-- N]
 */
import { ccc } from "@ckb-ccc/core";

const CKB = 100_000_000n;

async function main(): Promise<void> {
  const { FUNDER_KEY, CREATOR_KEY } = process.env;
  if (!FUNDER_KEY || !CREATOR_KEY) throw new Error("set FUNDER_KEY and CREATOR_KEY to testnet private keys");
  const want = Number(process.argv[2] ?? 3);
  const client = new ccc.ClientPublicTestnet();
  const funder = new ccc.SignerCkbPrivateKey(client, FUNDER_KEY);
  const creator = new ccc.SignerCkbPrivateKey(client, CREATOR_KEY);
  const args = (await creator.getRecommendedAddressObj()).script.args;
  const acp = await ccc.Address.fromKnownScript(client, ccc.KnownScript.AnyoneCanPay, args);

  let have = 0;
  let balance = 0n;
  for await (const cell of client.findCellsByLock(acp.script, null, true)) {
    have++;
    balance += cell.cellOutput.capacity;
  }
  console.log(`creator ${acp.toString()}`);
  console.log(`  ${have} anyone-can-pay cell(s), ${ccc.fixedPointToString(balance)} CKB`);
  console.log(`funder balance ${ccc.fixedPointToString(await funder.getBalance())} CKB`);
  if (have >= want) return;

  const tx = ccc.Transaction.from({
    outputs: Array.from({ length: want - have }, () => ({ lock: acp.script, capacity: 61n * CKB })),
  });
  await tx.completeInputsByCapacity(funder);
  await tx.completeFeeBy(funder);
  const hash = await funder.sendTransaction(tx);
  console.log(`added ${want - have} cell(s): https://testnet.explorer.nervos.org/transaction/${hash}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
