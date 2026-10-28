/**
 * Token subscriptions on testnet: the same flow as smoke:subscription, paid in
 * the demo xUDT token (demo/app/tokens) instead of CKB. Same session lock;
 * nothing new deployed.
 *
 *   open    — the subscriber pays the first period (2 units) into the creator's
 *             anyone-can-pay token cell and funds one token cell with 4 units more
 *             (and 283 CKB, its size plus 1): period 10 blocks, bound to an account
 *             (one signature)
 *   verify  — the creator checks it from the chain alone, with the token; another
 *             account is refused, and so is a check that expects CKB
 *   early   — a charge before the period is refused by the node (session lock error 14)
 *   leak    — a mature charge that also takes 1 shannon of CKB is refused by the
 *             node (error 12): max_per_tx is 0, so no CKB ever leaves
 *   charge  — the charger key takes 2 units into the creator's token cell, twice, a
 *             period apart, paying the fee itself; each new cell verifies as paid
 *   dry     — a third charge is refused: no tokens left for a price
 *   cancel  — the subscriber sweeps the cell back (its CKB, and any tokens), alone
 *
 * The charger is the creator's secp256k1 address; the payout address is the
 * creator's anyone-can-pay address (same key, different lock), as in
 * smoke:subscription. It needs a cell of the demo token: setup:token makes three
 * for the pay-per-read creator, and this script makes one if there is none.
 * The subscriber's tokens are minted as any visitor would (mintDemoToken).
 *
 * Usage: FUNDER_KEY=0x... CREATOR_KEY=0x... npm run smoke:subscription-token
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import { demoToken, mintDemoToken, units } from "../demo/app/tokens/token.js";
import {
  cancelSubscription,
  chargeSubscription,
  findSubscriptionCells,
  openSubscription,
  relativeBlocksSince,
  SessionBalanceError,
  sessionLockCellDep,
  sessionLockErrorFrom,
  tokenAmount,
  verifySubscription,
  type SessionLockDeployment,
  type Subscription,
} from "../src/index.js";

const CKB = 100_000_000n;
const PRICE = 2n; // token units, as an article on the token page
const PERIOD = 10n;
const ACCOUNT = "smoke-test-token";
const explorer = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
const deployment = JSON.parse(readFileSync("deployment/testnet.json", "utf8")) as SessionLockDeployment;

async function committed(client: ccc.Client, hash: ccc.Hex): Promise<void> {
  for (let i = 0; i < 180; i++) {
    if ((await client.getTransaction(hash))?.status === "committed") return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`not committed after 15 minutes: ${explorer(hash)}`);
}

/** Cells under `lock` typed with `token`, with their amounts. */
async function tokenCells(client: ccc.Client, lock: ccc.Script, token: ccc.Script): Promise<ccc.Cell[]> {
  const cells: ccc.Cell[] = [];
  for await (const c of client.findCells({ script: lock, scriptType: "lock", scriptSearchMode: "exact", filter: { script: token }, withData: true })) {
    if (c.cellOutput.type?.eq(token) && ccc.bytesFrom(c.outputData).length >= 16) cells.push(c);
  }
  return cells;
}

const unitsOf = (cells: ccc.Cell[]) => cells.reduce((s, c) => s + tokenAmount(c.outputData), 0n);

async function plainBalance(client: ccc.Client, lock: ccc.Script): Promise<bigint> {
  let total = 0n;
  for await (const c of client.findCellsByLock(lock, null, true)) if (!c.cellOutput.type) total += c.cellOutput.capacity;
  return total;
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
  const token = await demoToken(client);
  const subscriberLock = (await subscriber.getRecommendedAddressObj()).script;
  console.log(`charger: ${chargerAddr.toString()}\npayout : ${acp.toString()}\ntoken  : demo xUDT, type hash ${token.hash()}`);

  // Setup, paid by the funder: a token cell for the payout address, fee CKB for the charger.
  if (!(await tokenCells(client, acp.script, token)).length || (await plainBalance(client, chargerAddr.script)) < 70n * CKB) {
    const tx = ccc.Transaction.from({ outputs: [], outputsData: [] });
    if (!(await tokenCells(client, acp.script, token)).length) tx.addOutput({ lock: acp.script, type: token }, units(0n));
    if ((await plainBalance(client, chargerAddr.script)) < 70n * CKB) tx.addOutput({ lock: chargerAddr.script, capacity: 100n * CKB }, "0x");
    await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt);
    await tx.completeInputsByCapacity(subscriber);
    await tx.completeFeeBy(subscriber);
    const hash = await subscriber.sendTransaction(tx);
    console.log(`setup: the payout's token cell and/or 100 CKB for the charger's fees\n  ${explorer(hash)}`);
    await committed(client, hash);
  }
  // The subscriber needs 3 prices: the first period now and two more in the cell.
  const held = unitsOf(await tokenCells(client, subscriberLock, token));
  if (held < 3n * PRICE) {
    const hash = await mintDemoToken(subscriber, 10n);
    console.log(`setup: mint 10 demo units to the subscriber (it held ${held})\n  ${explorer(hash)}`);
    await committed(client, hash);
  }

  const terms: Subscription = {
    subscriberLockHash: subscriberLock.hash(),
    chargerLockHash: chargerAddr.script.hash(),
    payToLockHash: acp.script.hash(),
    price: PRICE,
    periodBlocks: PERIOD,
    token: { type: { codeHash: token.codeHash, hashType: token.hashType, args: token.args } },
  };
  // A run cut short leaves its subscription open, and the library refuses a second
  // one with the same terms: take the old one back first.
  if ((await findSubscriptionCells(client, deployment, terms)).cells.length) {
    const { txHash } = await cancelSubscription(subscriber, deployment, terms);
    console.log(`setup: cancel a subscription left open by an earlier run\n  ${explorer(txHash!)}`);
    await committed(client, txHash!);
  }
  const payoutBefore = unitsOf(await tokenCells(client, acp.script, token));

  console.log(`open: first period paid now (${PRICE} units), ${2n * PRICE} units in the cell, period ${PERIOD} blocks (one subscriber signature)`);
  const { txHash: openTx, subscription: sub } = await openSubscription(subscriber, deployment, {
    charger: chargerAddr.toString(),
    payTo: acp.toString(),
    price: PRICE,
    periodBlocks: PERIOD,
    token: { type: token, amount: 2n * PRICE },
    // 1 CKB over the cell's own 282, so the leak test below can move a shannon
    // without the change falling under its size (which the node would refuse first).
    budget: 283n * CKB,
    account: ACCOUNT,
  });
  console.log(`  ${explorer(openTx)}`);
  await committed(client, openTx);

  const expected = { charger: chargerAddr.toString(), payTo: acp.toString(), price: PRICE, periodBlocks: PERIOD, token };
  const check = await verifySubscription(client, deployment, { txHash: openTx, index: 0 }, { ...expected, account: ACCOUNT });
  if (!check.ok) throw new Error(`creator's check refused: ${check.reason}`);
  const thief = await verifySubscription(client, deployment, { txHash: openTx, index: 0 }, { ...expected, account: "someone-else" });
  if (thief.ok) throw new Error("the subscription was accepted for another account");
  const asCkb = await verifySubscription(client, deployment, { txHash: openTx, index: 0 }, { ...expected, token: undefined });
  if (asCkb.ok) throw new Error("a token subscription verified as a CKB one");
  console.log(
    `verify: creator accepts terms, token, first payment and account (paid through block ${check.paidThroughBlock}, ` +
      `${check.chargesLeft} charges left) · another account refused · a CKB check refused (${asCkb.reason})`,
  );

  // The library refuses these itself; to see the network refuse them, send them by hand.
  await waitBlocks(client, sub, 1n);
  await handCharge(charger, sub, acp.script, token, { since: 1n, ckbLeak: 0n, code: 14, what: `early: a charge 1 block after opening, period ${PERIOD}` });
  await waitBlocks(client, sub, 0n);
  await handCharge(charger, sub, acp.script, token, { since: PERIOD, ckbLeak: 1n, code: 12, what: "leak: a mature charge of the price that also moves 1 shannon of CKB" });

  for (let i = 1; i <= 2; i++) {
    await waitBlocks(client, sub, 0n);
    const tx = await chargeSubscription(charger, deployment, sub, { payTo: acp.toString() });
    console.log(`charge ${i}: ${PRICE} units to the creator's token cell, charger key only, no CKB out`);
    console.log(`  ✓ ${explorer(tx)}`);
    await committed(client, tx);
    const paid = await verifySubscription(client, deployment, { txHash: tx, index: 1 }, expected);
    if (!paid.ok) throw new Error(`the charge's new cell does not verify: ${paid.reason}`);
    if (paid.balance !== check.balance) throw new Error(`CKB left the subscription: ${check.balance} -> ${paid.balance}`);
    console.log(`  ✓ creator: paid through block ${paid.paidThroughBlock}; the cell still holds ${ccc.fixedPointToString(paid.balance)} CKB`);
  }
  const payoutAfter = unitsOf(await tokenCells(client, acp.script, token));
  console.log(`  payout token balance ${payoutBefore} → ${payoutAfter} units`);
  if (payoutAfter - payoutBefore !== 3n * PRICE) throw new Error(`expected the creator to gain ${3n * PRICE} units, gained ${payoutAfter - payoutBefore}`);

  await waitBlocks(client, sub, 0n);
  try {
    await chargeSubscription(charger, deployment, sub, { payTo: acp.toString() });
    throw new Error("a third charge was not refused");
  } catch (e) {
    if (!(e instanceof SessionBalanceError)) throw e;
    console.log(`dry: third charge\n  ✓ refused: ${e.message}`);
  }

  console.log("cancel: the subscriber sweeps the cell back (one signature, no creator)");
  const { txHash, refunded, refundedTokens } = await cancelSubscription(subscriber, deployment, sub);
  console.log(`  ✓ ${explorer(txHash!)} · ${ccc.fixedPointToString(refunded)} CKB and ${refundedTokens} units back`);
  await committed(client, txHash!);
  if ((await findSubscriptionCells(client, deployment, sub)).cells.length) throw new Error("cells left after cancel");
  console.log(
    "done: the first period in tokens at opening, two token charges a period apart with no CKB out, " +
      "an early charge and a CKB leak refused by the network, cancel by the subscriber alone",
  );
}

/** Waits until a subscription cell is at least `blocks` old (0 = a full period). */
async function waitBlocks(client: ccc.Client, sub: Subscription, blocks: bigint): Promise<void> {
  // Testnet blocks can slow to minutes each (26 Oct): wait up to an hour.
  for (let i = 0; i < 720; i++) {
    const { nextChargeIn } = await findSubscriptionCells(client, deployment, sub);
    if (nextChargeIn !== undefined && (blocks === 0n ? nextChargeIn === 0n : sub.periodBlocks - nextChargeIn >= blocks)) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("the subscription cell did not age in an hour");
}

/**
 * A charge built by hand: exactly the price in tokens into the payout's token
 * cell, with the given `since`, and `ckbLeak` shannons moved from the
 * subscription to the payout cell. One thing wrong at a time, so the node must
 * refuse it with session lock error `code`.
 */
async function handCharge(
  charger: ccc.Signer,
  sub: Subscription,
  payTo: ccc.Script,
  token: ccc.Script,
  o: { since: bigint; ckbLeak: bigint; code: number; what: string },
): Promise<void> {
  const client = charger.client;
  const { cells, lock } = await findSubscriptionCells(client, deployment, sub);
  const chargerLock = (await charger.getRecommendedAddressObj()).script;
  const [target] = await tokenCells(client, payTo, token);
  let keyCell: ccc.Cell | undefined;
  for await (const c of client.findCellsByLock(chargerLock, null, true)) {
    if (!c.cellOutput.type && c.outputData === "0x") {
      keyCell = c;
      break;
    }
  }
  if (!target || !keyCell) throw new Error("no payout token cell or charger cell");
  const cell = cells[0];
  const tx = ccc.Transaction.from({
    cellDeps: [sessionLockCellDep(deployment)],
    inputs: [
      { previousOutput: cell.outPoint, since: relativeBlocksSince(o.since) },
      { previousOutput: target.outPoint },
      { previousOutput: keyCell.outPoint },
    ],
    outputs: [
      { lock: payTo, type: token, capacity: target.cellOutput.capacity + o.ckbLeak },
      { lock, type: token, capacity: cell.cellOutput.capacity - o.ckbLeak },
      { lock: chargerLock, capacity: 0n },
    ],
    outputsData: [units(tokenAmount(target.outputData) + PRICE), units(tokenAmount(cell.outputData) - PRICE), "0x"],
  });
  // CCC raises an output to its size; a raised change would hide the leak.
  if (tx.outputs[1].capacity !== cell.cellOutput.capacity - o.ckbLeak) throw new Error("the change fell under its size");
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.AnyoneCanPay, ccc.KnownScript.XUdt);
  await tx.completeFeeChangeToOutput(charger, 2);
  try {
    const hash = await charger.sendTransaction(tx);
    throw new Error(`a hand-built charge was accepted: ${explorer(hash)}`);
  } catch (e) {
    const err = sessionLockErrorFrom(e instanceof Error ? e.message : String(e), [0]);
    if (err?.code !== o.code) throw e;
    console.log(`${o.what}\n  ✓ refused by the node: error ${o.code}, ${err.meaning}`);
    console.log(`    node: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
