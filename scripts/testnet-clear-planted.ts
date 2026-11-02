/**
 * Planted cells on testnet (mentor review, tracker #47, 2 Nov): a third party
 * pushes a subscription past MAX_SUBSCRIPTION_CELLS, which blocks its status
 * and its charges; the subscriber clears the planted cells without cancelling,
 * and the schedule goes on as before.
 *
 *   open    — the subscriber (FUNDER_KEY) opens a subscription: price 10 CKB,
 *             period PERIOD_BLOCKS (default 30), budget 163 CKB (one more charge)
 *   status  — active, paid through the opening's block + period
 *   plant   — a third party (a key derived from FUNDER_KEY, funded by it) creates
 *             enough cells of the minimum size under the subscription's lock to
 *             pass MAX_SUBSCRIPTION_CELLS (16): 16 cells beside the subscription's own
 *   blocked — the status and a charge are refused ("too-many-cells"), nothing sent
 *   clear   — clearPlantedCells (repeated while `more`): one subscriber signature
 *             sweeps the planted cells to the subscriber, who keeps their CKB
 *   active  — the status is active again, and the next charge is dated from the
 *             opening, not from the clear
 *   charge  — the charger (CREATOR_KEY) charges once the period is over: accepted
 *   cancel  — the subscriber sweeps the rest back; the third party's change goes
 *             back to the funder
 *
 * Usage: FUNDER_KEY=0x... CREATOR_KEY=0x... npm run smoke:clear-planted
 *        [-- --period=30] [-- --dry-run]
 * LOG=1 also writes docs/evidence/<date>-smoke-clear-planted.log.
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import {
  cancelSubscription,
  chargeSubscription,
  clearPlantedCells,
  findSubscriptionCells,
  MAX_SUBSCRIPTION_CELLS,
  openSubscription,
  SessionPolicyError,
  subscriptionLock,
  subscriptionStatus,
  type SessionLockDeployment,
  type Subscription,
} from "../src/index.js";
import {
  balanceOf,
  CKB,
  clearOptions,
  committed,
  deriveKey,
  errorText,
  explorer,
  fund,
  isDryRun,
  plantPlan,
  rpcUrl,
  sleep,
  startLog,
  sweepAll,
  waitBlocks,
  type ClearOptions,
  smokeKeys,
  SMOKE_KEY_FILE,
} from "./testnet-lib.js";

const PRICE = 10n * CKB;
const SUBSCRIPTION_CELL = 153n * CKB;
const ACCOUNT = "clear-planted-smoke";
const deployment = JSON.parse(readFileSync("deployment/testnet.json", "utf8")) as SessionLockDeployment;
const fmt = (n: bigint) => ccc.fixedPointToString(n);

function printPlan(o: ClearOptions): void {
  const plan = plantPlan(1, SUBSCRIPTION_CELL, MAX_SUBSCRIPTION_CELLS);
  console.log("dry run: nothing is sent, no key is read");
  console.log(`  period ${o.period} blocks, price ${fmt(PRICE)} CKB, budget ${fmt(SUBSCRIPTION_CELL + PRICE)} CKB`);
  console.log("  needs FUNDER_KEY (subscriber, funds the third party) and CREATOR_KEY (charger; payout to its anyone-can-pay address)");
  console.log(
    `  planted: ${plan.count} cells x ${fmt(SUBSCRIPTION_CELL)} = ${fmt(plan.locked)} CKB from the funder, ` +
      "back to the subscriber (the funder) when cleared",
  );
  console.log(`  paid to the creator: ${fmt(2n * PRICE)} CKB (the opening's period and one charge), plus fees`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts = clearOptions(argv);
  if (isDryRun(argv)) return printPlan(opts);
  const { funderKey, creatorKey, created } = smokeKeys();
  if (created) {
    const funderAddress = await new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet({ url: rpcUrl() }), funderKey).getRecommendedAddress();
    console.log(`created ${SMOKE_KEY_FILE} with two new testnet keys`);
    console.log(`fund this address from https://faucet.nervos.org, then run again:
  ${funderAddress}`);
    return;
  }
  const logFile = startLog("smoke-clear-planted");
  const url = rpcUrl();
  const client = new ccc.ClientPublicTestnet({ url });
  const subscriber = new ccc.SignerCkbPrivateKey(client, funderKey);
  const charger = new ccc.SignerCkbPrivateKey(client, creatorKey);
  // The third party has its own client: the subscriber and the charger only see its cells once indexed.
  const planter = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet({ url }), deriveKey(funderKey, "clear-planted-planter", 0));
  const subscriberLock = (await subscriber.getRecommendedAddressObj()).script;
  const chargerAddr = await charger.getRecommendedAddressObj();
  const acp = await ccc.Address.fromKnownScript(client, ccc.KnownScript.AnyoneCanPay, chargerAddr.script.args);
  const period = BigInt(opts.period);
  console.log(`subscriber: ${(await subscriber.getRecommendedAddressObj()).toString()}`);
  console.log(`charger   : ${chargerAddr.toString()}\npayout    : ${acp.toString()}`);
  console.log(`planter   : ${(await planter.getRecommendedAddressObj()).toString()} (third party)`);

  // Setup, as in smoke:subscription: a payout cell, the charger's fee cell, no subscription left open.
  if ((await balanceOf(client, acp.script)) === 0n) await fund(subscriber, acp.script, 61n * CKB, "the creator's anyone-can-pay cell (61 CKB)");
  if ((await balanceOf(client, chargerAddr.script)) < 70n * CKB) await fund(subscriber, chargerAddr.script, 100n * CKB, "a 100 CKB cell for the charger's fees");
  const terms: Subscription = {
    subscriberLockHash: subscriberLock.hash(),
    chargerLockHash: chargerAddr.script.hash(),
    payToLockHash: acp.script.hash(),
    price: PRICE,
    periodBlocks: period,
  };
  const leftover = await cancelSubscription(subscriber, deployment, terms);
  if (leftover.txHash) {
    console.log(`setup: cancel a subscription left open by an earlier run, ${fmt(leftover.refunded)} CKB back\n  ${explorer(leftover.txHash)}`);
    await committed(client, leftover.txHash);
  }
  const lock = subscriptionLock(deployment, terms);
  const cellSize = ccc.CellOutput.from({ lock }, "0x").capacity;
  const plan = plantPlan(1, cellSize, MAX_SUBSCRIPTION_CELLS);
  // The planter's own change must be a cell too (61 CKB), and pay the fee.
  const planterNeeds = plan.locked + 62n * CKB;
  const planterHas = await balanceOf(client, (await planter.getRecommendedAddressObj()).script);
  const before = await balanceOf(client, subscriberLock);
  console.log(`funder balance ${fmt(before)} CKB`);
  if (planterHas < planterNeeds) {
    await fund(subscriber, (await planter.getRecommendedAddressObj()).script, planterNeeds - planterHas, `the third party, ${fmt(planterNeeds - planterHas)} CKB`);
  }

  let failure: unknown;
  let sub: Subscription | undefined;
  try {
    console.log(`open: price 10 CKB, period ${period} blocks, budget ${fmt(SUBSCRIPTION_CELL + PRICE)} CKB (one subscriber signature)`);
    const opened = await openSubscription(subscriber, deployment, {
      charger: chargerAddr.toString(),
      payTo: acp.toString(),
      price: PRICE,
      periodBlocks: period,
      budget: SUBSCRIPTION_CELL + PRICE,
      account: ACCOUNT,
    });
    sub = opened.subscription;
    console.log(`  ${explorer(opened.txHash)}`);
    const openBlock = await committed(client, opened.txHash);
    const proof = { openTx: opened.txHash, account: ACCOUNT };
    const first = await status(client, sub, proof);
    console.log(`status: active ${first.active}, paid through block ${first.paidThroughBlock}, next charge in ${first.nextChargeIn} blocks (opened in block ${openBlock})`);
    if (!first.active) throw new Error("the subscription is not active after opening");

    console.log(
      `plant: a third party creates ${plan.count} cells of ${fmt(cellSize)} CKB (the least a cell under this lock holds) ` +
        `under the subscription's lock: ${fmt(plan.locked)} CKB in all, 1 + ${plan.count} cells > ${MAX_SUBSCRIPTION_CELLS}`,
    );
    const plant = ccc.Transaction.from({ outputs: Array.from({ length: plan.count }, () => ({ lock, capacity: cellSize })) });
    await plant.completeInputsByCapacity(planter);
    await plant.completeFeeBy(planter);
    const plantHash = await planter.sendTransaction(plant);
    console.log(`  ${explorer(plantHash)}`);
    const plantBlock = await committed(client, plantHash);

    // The indexer may list them a little after the commit.
    let blocked: SessionPolicyError | undefined;
    for (let i = 0; i < 24 && !blocked; i++) {
      try {
        await findSubscriptionCells(client, deployment, sub);
        await sleep(5000);
      } catch (e) {
        if (!(e instanceof SessionPolicyError && e.reason === "too-many-cells")) throw e;
        blocked = e;
      }
    }
    if (!blocked) throw new Error("the planted cells did not block the subscription");
    try {
      await subscriptionStatus(client, deployment, sub, proof);
      throw new Error("the status was answered past the cap");
    } catch (e) {
      if (!(e instanceof SessionPolicyError && e.reason === "too-many-cells")) throw e;
      console.log(`blocked: status\n  ✓ refused (too-many-cells): ${e.message}`);
    }
    try {
      const h = await chargeSubscription(charger, deployment, sub, { payTo: acp.toString(), topUp: true });
      throw new Error(`a charge went through past the cap: ${explorer(h)}`);
    } catch (e) {
      if (!(e instanceof SessionPolicyError && e.reason === "too-many-cells")) throw e;
      console.log(`blocked: charge\n  ✓ refused before anything was sent (too-many-cells)`);
    }

    console.log("clear: the subscriber sweeps the planted cells to itself (clearPlantedCells, one signature, no cancel)");
    let clearBlock = 0n;
    for (let pass = 1; pass <= 5; pass++) {
      const r = await clearPlantedCells(subscriber, deployment, sub);
      if (!r.txHash) {
        console.log(`  pass ${pass}: nothing planted left${r.more ? " (more unread)" : ""}`);
        if (!r.more) break;
        continue;
      }
      console.log(`  pass ${pass}: ${r.swept} cell(s), ${fmt(r.refunded)} CKB back to the subscriber${r.more ? ", more to read" : ""}`);
      console.log(`  ✓ ${explorer(r.txHash)}`);
      clearBlock = await committed(client, r.txHash);
      if (!r.more) break;
    }
    if (!clearBlock) throw new Error("nothing was cleared");

    const after = await status(client, sub, proof);
    const expected = openBlock + period > after.tip ? openBlock + period - after.tip : 0n;
    const ifDatedByClear = clearBlock + period > after.tip ? clearBlock + period - after.tip : 0n;
    // Paid through the opening's block + period, as before the planting; past it, unpaid until the charge.
    const paidOk = after.paidThroughBlock === first.paidThroughBlock;
    const activeOk = after.active === after.tip <= openBlock + period;
    console.log(`active: status after the clear (tip ${after.tip})`);
    console.log(
      `  ${paidOk && activeOk ? "✓" : "✗"} active ${after.active}, paid through block ${after.paidThroughBlock} (as before the planting), ` +
        `${after.chargesLeft} charge(s) left${after.active ? "" : ": the period ran out before the clear committed, run with a longer --period"}`,
    );
    console.log(
      `  ${after.nextChargeIn === expected ? "✓" : "✗"} next charge in ${after.nextChargeIn} blocks: dated from the opening (block ${openBlock}), ` +
        `not from the clear (block ${clearBlock}, which would give ${ifDatedByClear})`,
    );
    if (!paidOk || !activeOk || after.nextChargeIn !== expected) throw new Error("the clear changed the subscription's state");

    await waitBlocks(client, deployment, sub, 0n);
    const charge = await chargeSubscription(charger, deployment, sub, { payTo: acp.toString(), topUp: true });
    console.log(`charge: 10 CKB to the creator once the period is over, charger key only`);
    console.log(`  ✓ ${explorer(charge)}`);
    const chargeBlock = await committed(client, charge);
    console.log(
      `  charged in block ${chargeBlock}: the period from the opening ended at ${openBlock + period}; ` +
        (clearBlock + period > chargeBlock
          ? `a charge dated by the clear could not come before ${clearBlock + period} ✓ on time`
          : `the clear landed too late in the period to tell (run with a longer --period)`),
    );
    console.log(`  planted in block ${plantBlock}, cleared in block ${clearBlock}`);
  } catch (e) {
    failure = e;
    console.error(`stopped: ${errorText(e)}`);
  } finally {
    // Everything back: the subscription to the subscriber, the planter's change to the funder.
    try {
      const c = await cancelSubscription(subscriber, deployment, sub ?? terms);
      if (c.txHash) {
        console.log(`cancel: the subscriber sweeps the rest back, ${fmt(c.refunded)} CKB\n  ✓ ${explorer(c.txHash)}`);
        await committed(client, c.txHash);
      }
      const back = await sweepAll(planter, subscriberLock);
      if (back) {
        console.log(`sweep: the third party's change back to the funder, ${fmt(back.amount)} CKB\n  ${explorer(back.hash)}`);
        await committed(client, back.hash);
      }
    } catch (e) {
      console.error(`✗ clean-up: ${errorText(e)} (run again: it cancels and sweeps first)`);
      failure ??= e;
    }
  }
  const end = await balanceOf(client, subscriberLock);
  console.log(`funder balance ${fmt(before)} → ${fmt(end)} CKB: spent ${fmt(before - end)} CKB in all (prices to the creator and fees)`);
  if (failure) throw failure;
  console.log("done: planted cells blocked status and charges; cleared by the subscriber alone; status active again, the next charge on time");
  if (logFile) console.log(`log: ${logFile}`);
}

async function status(client: ccc.Client, sub: Subscription, proof: { openTx: ccc.Hex; account: string }) {
  const r = await subscriptionStatus(client, deployment, sub, proof);
  if (!r.ok) throw new Error(`status refused: ${r.reason}`);
  return r.status;
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
