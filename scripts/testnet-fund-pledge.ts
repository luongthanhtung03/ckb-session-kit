/**
 * A CrowdCell pledge funded from a session, on public testnet, against
 * CrowdCell's live scripts (CKBuilder-projects#6, Part 1). No CrowdCell code is
 * run: the transactions are built here in CrowdCell's shape (the live pledge
 * 0xd4602458..., 3 Nov), and CrowdCell's deployed scripts check them on chain.
 *
 *   1. create a campaign of our own (wallet signs): goal far above the pledge,
 *      deadline DEADLINE_BLOCKS ahead, titled as a test;
 *   2. off-chain refusals, nothing signed: a session with a recipient;
 *   3. open a session with no recipient (wallet signs once):
 *      maxPerTx = pledge + 552 CKB, budget = that + 121 CKB;
 *   4. pledge 100 CKB with sendWithSession: session key only, no wallet;
 *   5. pledge 101 CKB: refused before signing (ScopeError, over maxPerTx);
 *   6. close the session (key cell back, owner sweeps);
 *   7. after the deadline: finalize the campaign as Failed (permissionless),
 *      then refund the pledge and reclaim the receipt to the wallet.
 *
 * The campaign cell itself stays: CrowdCell lets it be destroyed only ~180 days
 * after the deadline (GRACE_PERIOD_BLOCKS), so its capacity (342 CKB on 3 Nov)
 * is the run's cost, with the fees (under 0.001 CKB).
 *
 * Keys: smokeKeys() (.env.smoke, testnet only); the funder is the wallet and the
 * backer. Never printed. LOG=1 writes docs/evidence/<date>-fund-pledge.log.
 *
 * Usage: npm run smoke:fund-pledge   (DEADLINE_BLOCKS=40 by default, ~6 minutes)
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import {
  closeSession,
  createSession,
  findSessionCells,
  fundInSession,
  openSession,
  ScopeError,
  sendWithSession,
  SessionPolicyError,
  type OnChainBinding,
  type SessionLockDeployment,
} from "../src/index.js";
import { CROWDCELL_TESTNET } from "./fetch-crowdcell.js";
import { CKB, committed, explorer, intOption, rpcUrl, sleep, smokeKeys, startLog } from "./testnet-lib.js";

const deployment = JSON.parse(readFileSync("deployment/testnet.json", "utf8")) as SessionLockDeployment;

const PLEDGE = 100n * CKB;
/** CrowdCell's PLEDGE_CELL_OVERHEAD: the pledge cell's own storage, back to the backer at refund or release. */
const PLEDGE_OVERHEAD = 252n * CKB;
/** What the live frontend puts in a receipt today (pledge 0xd4602458...). */
const RECEIPT = 300n * CKB;
const PER_PLEDGE = PLEDGE + PLEDGE_OVERHEAD + RECEIPT;
const SESSION_CELL = 121n * CKB;
const FEE_RATE = 2000n;

const u64le = (v: bigint) => ccc.hexFrom(ccc.numLeToBytes(v, 8)).slice(2);
const text = (t: string) => {
  const b = ccc.bytesFrom(t, "utf8");
  return ccc.hexFrom(ccc.numLeToBytes(b.length, 2)).slice(2) + ccc.hexFrom(b).slice(2);
};
const fmt = (v: bigint) => ccc.fixedPointToString(v);

type Name = keyof typeof CROWDCELL_TESTNET;
const script = (name: Name, args: ccc.HexLike) =>
  ccc.Script.from({ codeHash: CROWDCELL_TESTNET[name].codeHash, hashType: "data2", args });
const dep = (name: Name) => ccc.CellDep.from({ outPoint: { txHash: CROWDCELL_TESTNET[name].txHash, index: 0 }, depType: "code" });

/** Campaign data as CrowdCell writes it: 65 bytes, then a length-prefixed title and description. */
export function campaignData(creator: ccc.Hex, goal: bigint, deadline: bigint, total: bigint, status: 0 | 1 | 2, meta: string): ccc.Hex {
  return ccc.hexFrom(creator + u64le(goal) + u64le(deadline) + u64le(total) + status.toString(16).padStart(2, "0") + "00".repeat(8) + meta);
}

/** CrowdCell's pledge, before funding (page.tsx:310-398 at 2fd13f6, receipt args as the live frontend writes them). */
export function pledgeTx(campaign: ccc.Cell, backer: ccc.Script, linkage: ccc.Hex, amount: bigint): ccc.Transaction {
  const data = ccc.bytesFrom(campaign.outputData);
  const deadline = ccc.numLeFromBytes(data.slice(40, 48));
  const total = ccc.numLeFromBytes(data.slice(48, 56));
  const newData = ccc.hexFrom(ccc.bytesConcat(data.slice(0, 48), ccc.numLeToBytes(total + amount, 8), data.slice(56)));
  const typeHash = campaign.cellOutput.type!.hash().slice(2);
  const backerHash = backer.hash().slice(2);
  return ccc.Transaction.from({
    inputs: [{ previousOutput: campaign.outPoint }],
    outputs: [
      { lock: campaign.cellOutput.lock, type: campaign.cellOutput.type, capacity: campaign.cellOutput.capacity },
      {
        lock: script("pledgeLock", "0x" + typeHash + u64le(deadline) + backerHash),
        type: script("pledge", CROWDCELL_TESTNET.receipt.codeHash),
        capacity: PLEDGE_OVERHEAD + amount,
      },
      {
        lock: backer,
        type: script("receipt", CROWDCELL_TESTNET.pledge.codeHash + CROWDCELL_TESTNET.pledgeLock.codeHash.slice(2)),
        capacity: RECEIPT,
      },
    ],
    outputsData: [
      newData,
      "0x" + linkage.slice(2) + backerHash + u64le(amount),
      "0x" + u64le(amount) + backerHash + typeHash + u64le(deadline),
    ],
    cellDeps: (["pledge", "pledgeLock", "receipt", "campaign", "campaignLock"] as const).map(dep),
    witnesses: ["0x"],
  });
}

/**
 * The output policy CrowdCell's PR would pass as `check` (plan section 3): the
 * campaign carried forward intact, the pledge under pledge-lock naming the
 * wallet as backer, the receipt under the wallet's lock, and nothing else but
 * the session's change and key cell.
 */
export function pledgeCheck(campaign: ccc.Cell, wallet: ccc.Script, session: { lock: ccc.Script; keyLock: ccc.Script }) {
  return (tx: ccc.Transaction) => {
    const [c, p, r, ...rest] = tx.outputs;
    const ok =
      c?.lock.eq(campaign.cellOutput.lock) &&
      !!c.type?.eq(campaign.cellOutput.type!) &&
      c.capacity === campaign.cellOutput.capacity &&
      p?.lock.codeHash === CROWDCELL_TESTNET.pledgeLock.codeHash &&
      ccc.hexFrom(ccc.bytesFrom(p.lock.args).slice(40, 72)) === wallet.hash() &&
      r?.lock.eq(wallet) &&
      r.type?.codeHash === CROWDCELL_TESTNET.receipt.codeHash &&
      rest.every((o) => !o.type && (o.lock.eq(session.lock) || o.lock.eq(session.keyLock)));
    if (!ok) throw new Error("pledgeCheck: the funded transaction is not the pledge that was built");
  };
}

async function live(client: ccc.Client): Promise<void> {
  for (const [name, { codeHash, txHash }] of Object.entries(CROWDCELL_TESTNET)) {
    const cell = await client.getCellLive({ txHash, index: 0 }, true, false);
    if (!cell || ccc.hashCkb(cell.outputData) !== codeHash) {
      throw new Error(`CrowdCell's ${name} script is not live at ${txHash}:0: refresh scripts/fetch-crowdcell.ts`);
    }
  }
}

async function tipAtLeast(client: ccc.Client, block: bigint): Promise<void> {
  for (;;) {
    const tip = await client.getTip();
    if (tip >= block) return;
    console.log(`  tip ${tip}, waiting for block ${block} (${block - tip} to go)`);
    await sleep(Number(block - tip > 4n ? 30_000n : 10_000n));
  }
}

async function main(): Promise<void> {
  const log = startLog("fund-pledge");
  if (log) console.log(`logging to ${log}`);
  const deadlineBlocks = BigInt(intOption("deadline", "DEADLINE_BLOCKS", process.argv, process.env, 40, 10, 2000));
  const { funderKey } = smokeKeys();
  const client = new ccc.ClientPublicTestnet({ url: rpcUrl() });
  const wallet = new ccc.SignerCkbPrivateKey(client, funderKey);
  const walletLock = (await wallet.getRecommendedAddressObj()).script;
  const before = await client.getBalance([walletLock]);
  console.log(`wallet ${await wallet.getRecommendedAddress()} holds ${fmt(before)} CKB`);

  await live(client);
  console.log("CrowdCell's five scripts are live on testnet with the expected code hashes");

  // 1. A campaign of our own.
  const tip = await client.getTip();
  const deadline = tip + deadlineBlocks;
  const meta = text("ckb-session-kit test (ignore)") + text("Automated test of pledges funded from a session (CKBuilder-projects#6). Ends in minutes; refunded.");
  const create = ccc.Transaction.from({
    outputs: [
      {
        lock: script("campaignLock", "0x" + u64le(deadline)),
        type: script("campaign", "0x" + "00".repeat(32) + CROWDCELL_TESTNET.pledgeLock.codeHash.slice(2)),
        capacity: 0n, // CCC sizes it
      },
    ],
    outputsData: [campaignData(walletLock.hash(), 1_000_000n * CKB, deadline, 0n, 0, meta)],
    cellDeps: [dep("campaign")],
  });
  await create.completeInputsByCapacity(wallet);
  create.outputs[0].type!.args = ccc.hexFrom(ccc.hashTypeId(create.inputs[0], 0) + CROWDCELL_TESTNET.pledgeLock.codeHash.slice(2));
  await create.completeFeeBy(wallet, FEE_RATE);
  const createHash = await wallet.sendTransaction(create);
  console.log(`1. campaign created (wallet signed), deadline block ${deadline}, ${fmt(create.outputs[0].capacity)} CKB: ${explorer(createHash)}`);
  await committed(client, createHash);
  let campaign = (await client.getCellLive({ txHash: createHash, index: 0 }, true, false))!;

  // 2. Off-chain refusal: a session with a recipient cannot fund a pledge.
  const scoped = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: PER_PLEDGE } });
  const scopedBinding: OnChainBinding = { ownerLock: walletLock, minInterval: 0n, recipientLockHash: walletLock.hash() };
  try {
    await fundInSession(scoped, client, deployment, scopedBinding, pledgeTx(campaign, walletLock, createHash, PLEDGE));
    throw new Error("a recipient-scoped session was not refused");
  } catch (e) {
    if (!(e instanceof SessionPolicyError) || e.reason !== "session-has-recipient") throw e;
    console.log(`2. recipient-scoped session refused before signing (${e.reason}): ${e.message}`);
  }

  // 3. A session with no recipient.
  const session = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: PER_PLEDGE } });
  const budget = PER_PLEDGE + SESSION_CELL;
  const { txHash: openTx, binding } = await openSession(wallet, session, deployment, {
    budget,
    onWarning: (w) => console.log(`  warning shown to the owner: ${w.code}`),
  });
  console.log(`3. session opened (wallet signed once): budget ${fmt(budget)} CKB, maxPerTx ${fmt(PER_PLEDGE)} CKB, no recipient: ${explorer(openTx)}`);
  await committed(client, openTx);

  try {
    // 4. The pledge, from the session.
    const cells = await findSessionCells(session, client, deployment, binding);
    let builds = 0;
    const pledgeHash = await sendWithSession(
      session,
      client,
      deployment,
      binding,
      async () => {
        builds++;
        campaign = (await client.getCellLive(campaign.outPoint, true, false)) ?? campaign;
        return pledgeTx(campaign, walletLock, createHash, PLEDGE);
      },
      { feeRate: FEE_RATE, check: pledgeCheck(campaign, walletLock, cells) },
    );
    console.log(`4. pledged ${fmt(PLEDGE)} CKB from the session, no wallet (${builds} build): ${explorer(pledgeHash)}`);
    await committed(client, pledgeHash);
    const sent = (await client.getTransaction(pledgeHash))!.transaction;
    const fee = (await sent.getInputsCapacity(client)) - sent.getOutputsCapacity();
    const after = await findSessionCells(session, client, deployment, binding);
    console.log(`   fee ${fmt(fee)} CKB from the key cell; session ${fmt(cells.balance)} -> ${fmt(after.balance)} CKB (outflow ${fmt(cells.balance - after.balance)})`);
    campaign = (await client.getCellLive({ txHash: pledgeHash, index: 0 }, true, false))!;
    const total = ccc.numLeFromBytes(ccc.bytesFrom(campaign.outputData).slice(48, 56));
    console.log(`   campaign total_pledged now ${fmt(total)} CKB`);

    // 5. One CKB more than the session allows: refused before signing.
    try {
      await fundInSession(session, client, deployment, binding, pledgeTx(campaign, walletLock, createHash, PLEDGE + 1n * CKB));
      throw new Error("an over-limit pledge was not refused");
    } catch (e) {
      if (!(e instanceof ScopeError)) throw e;
      console.log(`5. ${fmt(PLEDGE + CKB)} CKB pledge refused before signing: ${e.message}`);
    }
  } finally {
    // 6. Close: key cell back, owner sweeps (also after a failure above).
    const closed = await closeSession(wallet, session, deployment, binding);
    console.log(`6. session closed: sweep ${closed.sweepTx ? explorer(closed.sweepTx) : "-"}, key cell ${closed.keyTx ? explorer(closed.keyTx) : closed.keyError}`);
    if (closed.sweepTx) await committed(client, closed.sweepTx);
    if (closed.keyTx) await committed(client, closed.keyTx);
  }

  // 7. After the deadline: finalize as Failed, then refund the pledge and reclaim the receipt.
  await tipAtLeast(client, deadline);
  const since = ccc.numFrom(deadline); // absolute block number
  const old = ccc.bytesFrom(campaign.outputData);
  const failed = ccc.hexFrom(ccc.bytesConcat(old.slice(0, 56), [2], old.slice(57)));
  const finalize = ccc.Transaction.from({
    inputs: [{ previousOutput: campaign.outPoint, since }],
    outputs: [{ lock: campaign.cellOutput.lock, type: campaign.cellOutput.type, capacity: campaign.cellOutput.capacity }],
    outputsData: [failed],
    cellDeps: [dep("campaign"), dep("campaignLock")],
    witnesses: ["0x"],
  });
  await finalize.completeFeeBy(wallet, FEE_RATE);
  const finalizeHash = await wallet.sendTransaction(finalize);
  console.log(`7. campaign finalized as Failed: ${explorer(finalizeHash)}`);
  await committed(client, finalizeHash);

  const pledgeTxHash = campaign.outPoint.txHash; // the pledge's outputs: 1 pledge, 2 receipt
  const refund = ccc.Transaction.from({
    inputs: [
      { previousOutput: { txHash: pledgeTxHash, index: 1 }, since },
      { previousOutput: { txHash: pledgeTxHash, index: 2 } },
    ],
    cellDeps: [
      ccc.CellDep.from({ outPoint: { txHash: finalizeHash, index: 0 }, depType: "code" }), // the Failed campaign
      ...(["pledgeLock", "pledge", "receipt"] as const).map(dep),
    ],
    witnesses: ["0x"],
  });
  await refund.completeFeeBy(wallet, FEE_RATE);
  const refundHash = await wallet.sendTransaction(refund);
  console.log(`   pledge refunded and receipt reclaimed to the wallet: ${explorer(refundHash)}`);
  await committed(client, refundHash);

  const end = await client.getBalance([walletLock]);
  console.log(`done: wallet ${fmt(before)} -> ${fmt(end)} CKB (net ${fmt(before - end)} CKB: the campaign cell, held ~180 days by CrowdCell's grace period, and fees)`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
