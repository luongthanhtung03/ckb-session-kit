/**
 * Subscriptions on testnet: a creator charges 10 CKB once per period from a cell
 * the subscriber controls, with no subscriber online, and the subscriber cancels
 * alone. Same session lock as every other flow; nothing new deployed.
 *
 *   open    — the subscriber's wallet pays the first period and funds one cell: price 10 CKB,
 *             period 10 blocks, bound to an account (one signature)
 *   verify  — the creator checks the subscription from the chain alone (verifySubscription):
 *             terms, the first payment, the account; another account is refused
 *   early   — a charge before the period is refused by the node (session lock error 14)
 *   charge  — the charger key takes 10 CKB into the creator's anyone-can-pay cell, twice,
 *             a period apart; the charger pays the fee; each new cell verifies as paid
 *   dry     — a third charge is refused: what is left cannot cover a price and a cell
 *   cancel  — the subscriber sweeps the rest back, no creator involved
 *
 * The charger is the creator's normal secp256k1 address; the payout address is
 * the creator's anyone-can-pay address (same key, different lock, so the two
 * lock hashes differ, as the lock requires).
 *
 * Usage: FUNDER_KEY=0x... CREATOR_KEY=0x... npm run smoke:subscription
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import {
  cancelSubscription,
  chargeSubscription,
  findSubscriptionCells,
  openSubscription,
  relativeBlocksSince,
  SessionBalanceError,
  sessionLockCellDep,
  sessionLockErrorFrom,
  verifySubscription,
  type SessionLockDeployment,
} from "../src/index.js";

const CKB = 100_000_000n;
const PRICE = 10n * CKB;
const PERIOD = 10n;
const ACCOUNT = "smoke-test";
const explorer = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
const deployment = JSON.parse(readFileSync("deployment/testnet.json", "utf8")) as SessionLockDeployment;

async function committed(client: ccc.Client, hash: ccc.Hex): Promise<void> {
  for (let i = 0; i < 180; i++) {
    if ((await client.getTransaction(hash))?.status === "committed") return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`not committed after 15 minutes: ${explorer(hash)}`);
}

async function balanceOf(client: ccc.Client, lock: ccc.Script): Promise<bigint> {
  let total = 0n;
  for await (const cell of client.findCellsByLock(lock, null, true)) total += cell.cellOutput.capacity;
  return total;
}

async function fund(from: ccc.Signer, lock: ccc.Script, capacity: bigint, what: string): Promise<void> {
  console.log(`setup: ${what}`);
  const tx = ccc.Transaction.from({ outputs: [{ lock, capacity }] });
  await tx.completeInputsByCapacity(from);
  await tx.completeFeeBy(from);
  const hash = await from.sendTransaction(tx);
  console.log(`  ${explorer(hash)}`);
  await committed(from.client, hash);
}

async function main(): Promise<void> {
  const funderKey = process.env.FUNDER_KEY;
  const creatorKey = process.env.CREATOR_KEY;
  if (!funderKey || !creatorKey) throw new Error("set FUNDER_KEY and CREATOR_KEY to testnet private keys");
  // Over HTTP: the default WebSocket connection has hung mid-run (26 Oct).
  const client = new ccc.ClientPublicTestnet({ url: process.env.CKB_RPC_URL ?? "https://testnet.ckb.dev/" });
  const subscriber = new ccc.SignerCkbPrivateKey(client, funderKey);
  const charger = new ccc.SignerCkbPrivateKey(client, creatorKey);
  const chargerAddr = await charger.getRecommendedAddressObj();
  const acp = await ccc.Address.fromKnownScript(client, ccc.KnownScript.AnyoneCanPay, chargerAddr.script.args);
  console.log(`charger: ${chargerAddr.toString()}\npayout : ${acp.toString()}`);

  if ((await balanceOf(client, acp.script)) === 0n) {
    await fund(subscriber, acp.script, 61n * CKB, "the creator's anyone-can-pay cell (61 CKB)");
  }
  if ((await balanceOf(client, chargerAddr.script)) < 70n * CKB) {
    await fund(subscriber, chargerAddr.script, 100n * CKB, "a 100 CKB cell for the charger's fees");
  }
  // A run cut short leaves its subscription open, and the library refuses a second
  // one with the same terms: take the old one back first.
  const subscriberLock = (await subscriber.getRecommendedAddressObj()).script;
  const leftover = {
    subscriberLockHash: subscriberLock.hash(),
    chargerLockHash: chargerAddr.script.hash(),
    payToLockHash: acp.script.hash(),
    price: PRICE,
    periodBlocks: PERIOD,
  };
  if ((await findSubscriptionCells(client, deployment, leftover)).cells.length) {
    const { txHash } = await cancelSubscription(subscriber, deployment, leftover);
    console.log(`setup: cancel a subscription left open by an earlier run
  ${explorer(txHash!)}`);
    await committed(client, txHash!);
  }
  const payoutBefore = await balanceOf(client, acp.script);

  // 153 CKB is the cell's own size; two prices on top pay exactly two periods.
  console.log(`open: first period paid now, price 10 CKB, period ${PERIOD} blocks, budget 173 CKB (one subscriber signature)`);
  const { txHash: openTx, subscription: sub } = await openSubscription(subscriber, deployment, {
    charger: chargerAddr.toString(),
    payTo: acp.toString(),
    price: PRICE,
    periodBlocks: PERIOD,
    budget: 173n * CKB,
    account: ACCOUNT,
  });
  console.log(`  ${explorer(openTx)}`);
  await committed(client, openTx);

  const terms = { charger: chargerAddr.toString(), payTo: acp.toString(), price: PRICE, periodBlocks: PERIOD };
  const check = await verifySubscription(client, deployment, { txHash: openTx, index: 0 }, { ...terms, account: ACCOUNT });
  if (!check.ok) throw new Error(`creator's check refused: ${check.reason}`);
  const thief = await verifySubscription(client, deployment, { txHash: openTx, index: 0 }, { ...terms, account: "someone-else" });
  if (thief.ok) throw new Error("the subscription was accepted for another account");
  console.log(
    `verify: creator accepts terms, first payment and account (paid through block ${check.paidThroughBlock}, ` +
      `${check.chargesLeft} charges left) · another account refused (${thief.reason})`,
  );

  // The library refuses an early charge itself; to see the network refuse it, send
  // one by hand with a since of 1 block, which the lock checks against the period.
  await waitBlocks(client, sub, 1n);
  await earlyCharge(charger, sub, acp.script);

  const charges: ccc.Hex[] = [];
  for (let i = 1; i <= 2; i++) {
    await waitBlocks(client, sub, 0n);
    const tx = await chargeSubscription(charger, deployment, sub, { payTo: acp.toString(), topUp: true });
    console.log(`charge ${i}: 10 CKB to the creator, charger key only`);
    console.log(`  ✓ ${explorer(tx)}`);
    await committed(client, tx);
    charges.push(tx);
    const paid = await verifySubscription(client, deployment, { txHash: tx, index: 1 }, terms);
    if (!paid.ok) throw new Error(`the charge's new cell does not verify: ${paid.reason}`);
    console.log(`  ✓ creator: paid through block ${paid.paidThroughBlock}`);
  }
  const payoutAfter = await balanceOf(client, acp.script);
  console.log(`  payout balance ${ccc.fixedPointToString(payoutBefore)} → ${ccc.fixedPointToString(payoutAfter)} CKB`);
  if (payoutAfter - payoutBefore !== 3n * PRICE) throw new Error(`expected the creator to gain 30 CKB, gained ${payoutAfter - payoutBefore}`);

  await waitBlocks(client, sub, 0n);
  try {
    await chargeSubscription(charger, deployment, sub, { payTo: acp.toString(), topUp: true });
    throw new Error("a third charge was not refused");
  } catch (e) {
    if (!(e instanceof SessionBalanceError)) throw e;
    console.log(`dry: third charge\n  ✓ refused: ${e.message}`);
  }

  console.log("cancel: the subscriber sweeps the rest back (one signature, no creator)");
  const { txHash, refunded } = await cancelSubscription(subscriber, deployment, sub);
  console.log(`  ✓ ${explorer(txHash!)} · ${ccc.fixedPointToString(refunded)} CKB back`);
  await committed(client, txHash!);
  if ((await findSubscriptionCells(client, deployment, sub)).cells.length) throw new Error("cells left after cancel");
  console.log("done: the first period at opening, two charges a period apart, an early charge refused by the network, cancel by the subscriber alone");
}

/** Waits until a subscription cell is at least `blocks` old (0 = a full period). */
async function waitBlocks(client: ccc.Client, sub: Parameters<typeof findSubscriptionCells>[2], blocks: bigint): Promise<void> {
  // Testnet blocks can slow to minutes each (26 Oct): wait up to an hour.
  for (let i = 0; i < 720; i++) {
    const { nextChargeIn } = await findSubscriptionCells(client, deployment, sub);
    if (nextChargeIn !== undefined && (blocks === 0n ? nextChargeIn === 0n : sub.periodBlocks - nextChargeIn >= blocks)) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("the subscription cell did not age in an hour");
}

/**
 * A charge built by hand with since = 1 block, before the period is over. Outflow
 * is exactly the price, into the payout cell, so the period is the only thing
 * wrong: the node must refuse it with session lock error 14.
 */
async function earlyCharge(charger: ccc.Signer, sub: Parameters<typeof findSubscriptionCells>[2], payTo: ccc.Script): Promise<void> {
  const client = charger.client;
  const { cells, lock } = await findSubscriptionCells(client, deployment, sub);
  const chargerLock = (await charger.getRecommendedAddressObj()).script;
  const plain = async (l: ccc.Script) => {
    for await (const c of client.findCellsByLock(l, null, true)) if (!c.cellOutput.type && c.outputData === "0x") return c;
    throw new Error("no plain cell under " + l.hash());
  };
  const [target, keyCell] = [await plain(payTo), await plain(chargerLock)];
  const tx = ccc.Transaction.from({
    cellDeps: [sessionLockCellDep(deployment)],
    inputs: [
      { previousOutput: cells[0].outPoint, since: relativeBlocksSince(1n) },
      { previousOutput: target.outPoint },
      { previousOutput: keyCell.outPoint },
    ],
    outputs: [
      { lock: payTo, capacity: target.cellOutput.capacity + PRICE },
      { lock, capacity: cells[0].cellOutput.capacity - PRICE },
      { lock: chargerLock, capacity: 0n },
    ],
    outputsData: ["0x", "0x", "0x"],
  });
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.AnyoneCanPay);
  await tx.completeFeeChangeToOutput(charger, 2);
  try {
    const hash = await charger.sendTransaction(tx);
    throw new Error(`an early charge was accepted: ${explorer(hash)}`);
  } catch (e) {
    const err = sessionLockErrorFrom(e instanceof Error ? e.message : String(e), [0]);
    if (err?.code !== 14) throw e;
    console.log(`early: a charge 1 block after opening, period ${PERIOD}
  ✓ refused by the node: error 14, ${err.meaning}`);
    console.log(`    node: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
