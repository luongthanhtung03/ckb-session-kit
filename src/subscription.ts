import { ccc } from "@ckb-ccc/core";
import {
  relativeBlocksSince,
  TESTNET_LEGACY_DEPLOYMENTS,
  sessionLockCellDep,
  sessionLockScript,
  type SessionLockDeployment,
} from "./lock.js";
import {
  assertSigningLock,
  collect,
  keyCellFloor,
  matureCells,
  ownerSweep,
  SessionBalanceError,
  signAndSend,
} from "./onchain.js";
import { SessionPolicyError } from "./session.js";

/**
 * Subscriptions (docs/design/subscriptions.md): the same session lock, with the
 * roles moved. The subscriber is the owner; the creator's charger key is the
 * session key; `max_per_tx` is the price, `min_interval` the period, and the
 * recipient the creator's payout address. So the network lets the charger take
 * at most the price, at most once per period, only to the payout address, and
 * the subscriber can sweep everything back alone at any time.
 *
 * - `openSubscription` — the subscriber funds one cell. One signature.
 * - `chargeSubscription` — the creator's charger key takes the price, paying the
 *   fee from its own cell. No subscriber involved.
 * - `cancelSubscription` — the subscriber sweeps the cell back. One signature.
 * - `verifySubscription` — the creator checks a subscription it was told about.
 *
 * A `Subscription` holds no private key: both sides can store it as it is.
 */
export interface Subscription {
  subscriberLockHash: ccc.Hex;
  chargerLockHash: ccc.Hex;
  payToLockHash: ccc.Hex;
  /** Shannons per charge. */
  price: bigint;
  /** Blocks between two charges of the same cell. */
  periodBlocks: bigint;
  /** The funding transaction, when this side opened it. */
  openTx?: ccc.Hex;
}

export function subscriptionLock(deployment: SessionLockDeployment, sub: Subscription): ccc.Script {
  return sessionLockScript(deployment, {
    ownerLockHash: sub.subscriberLockHash,
    sessionLockHash: sub.chargerLockHash,
    maxPerTx: sub.price,
    minInterval: sub.periodBlocks,
    recipientLockHash: sub.payToLockHash,
  });
}

/** Throws unless the three roles and the numbers make a subscription the lock can enforce as meant. */
function assertTerms(sub: Subscription): void {
  if (sub.price <= 0n) throw new SessionPolicyError("price must be positive");
  // min_interval 0 means no rate limit at all: the charger could take the price every block.
  if (sub.periodBlocks <= 0n) throw new SessionPolicyError("periodBlocks must be positive");
  relativeBlocksSince(sub.periodBlocks);
  if (sub.payToLockHash === sub.chargerLockHash) {
    // With a recipient set, outputs under the key's lock may not grow (error 17).
    throw new SessionPolicyError("payTo must differ from the charger: a charge to the charger's own lock is refused (error 17)");
  }
  if (sub.chargerLockHash === sub.subscriberLockHash) throw new SessionPolicyError("the charger must not be the subscriber");
  if (sub.payToLockHash === sub.subscriberLockHash) throw new SessionPolicyError("payTo must not be the subscriber");
}

async function isAnyoneCanPay(lock: ccc.Script, client: ccc.Client): Promise<boolean> {
  const acp = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
  return lock.codeHash === acp.codeHash && lock.hashType === acp.hashType;
}

/**
 * The memo an opening commits to, binding the subscription to one account at the
 * creator: a hash, so the account id never appears on-chain and can double as a
 * secret the subscriber's browser presents to the creator.
 */
export function subscriptionMemo(account: string): ccc.Hex {
  return ccc.hashCkb(ccc.bytesFrom(`ckb-session-kit subscribe ${account}`, "utf8"));
}

/**
 * Plain (untyped) cells under a subscription's lock, with or without data: the
 * charger may write data into a change cell, and such a cell must still be found,
 * charged and swept (review L2).
 */
async function subscriptionCells(client: ccc.Client, lock: ccc.Script): Promise<ccc.Cell[]> {
  const cells: ccc.Cell[] = [];
  for await (const cell of client.findCellsByLock(lock, null, true)) if (!cell.cellOutput.type) cells.push(cell);
  return cells;
}

/**
 * The subscriber opens a subscription, in one transaction and one signature: the
 * first period's price goes to `payTo` at once (a new cell cannot be charged for a
 * whole period, so otherwise the first period would be free; review H1), and one
 * cell holding `budget` shannons goes under the session lock. No key cell: the
 * creator already owns cells under its charger key. `budget` of the cell's own
 * size (153 CKB) plus n prices pays n more periods; what is left comes back on
 * cancel. With a price of 153 CKB or more, the last 153 can be charged too.
 *
 * `account` (the subscriber's id at the creator) is committed in the witness of
 * the subscriber's own input, which the subscriber's signature covers; the
 * creator checks it with `verifySubscription`, so nobody else can present this
 * subscription as theirs (review H3).
 *
 * `payTo` should be an anyone-can-pay address with a live cell, so a charge of
 * any size tops it up; otherwise each charge creates a new cell and the price must
 * be at least that cell's size (61 CKB for a plain address). Keep a plain cell in
 * the wallet: cancelling needs one to prove ownership.
 */
export async function openSubscription(
  subscriber: ccc.Signer,
  deployment: SessionLockDeployment,
  opts: {
    charger: string;
    payTo: string;
    price: bigint;
    periodBlocks: bigint;
    budget: bigint;
    account?: string;
    beforeSend?: (sub: Subscription) => Promise<void>;
  },
): Promise<{ txHash: ccc.Hex; subscription: Subscription }> {
  const client = subscriber.client;
  if (TESTNET_LEGACY_DEPLOYMENTS.some((d) => ccc.hexFrom(d.codeHash) === ccc.hexFrom(deployment.codeHash))) {
    // The 8 Oct code lacks errors 16-18 (review M5); no new subscription goes under an old lock.
    throw new SessionPolicyError("this is an old deployment of the session lock: open subscriptions under the current one");
  }
  const subscriberLock = (await subscriber.getRecommendedAddressObj()).script;
  await assertSigningLock(subscriberLock, client);
  const [chargerLock, payToLock] = await Promise.all(
    [opts.charger, opts.payTo].map(async (a) => (await ccc.Address.fromString(a, client)).script),
  );
  // A charger lock that signs nothing would let anyone trigger charges (review M2).
  await assertSigningLock(chargerLock, client);
  const sub: Subscription = {
    subscriberLockHash: subscriberLock.hash(),
    chargerLockHash: chargerLock.hash(),
    payToLockHash: payToLock.hash(),
    price: opts.price,
    periodBlocks: opts.periodBlocks,
  };
  assertTerms(sub);
  const acp = await isAnyoneCanPay(payToLock, client);
  const newCell = ccc.CellOutput.from({ lock: payToLock }, "0x").capacity;
  if (opts.price < newCell && !acp) {
    throw new SessionPolicyError(
      `each charge creates a cell for payTo, which needs ${ccc.fixedPointToString(newCell)} CKB: ` +
        "raise the price or use an anyone-can-pay address",
    );
  }
  const lock = subscriptionLock(deployment, sub);
  // Two live cells under the same lock are one group with two rate-limited cells:
  // two charges per period (review M1).
  if ((await subscriptionCells(client, lock)).length) {
    throw new SessionPolicyError("a subscription with exactly these terms is already open: cancel it first");
  }

  const tx = ccc.Transaction.from({ outputs: [{ lock, capacity: opts.budget }] });
  // CCC raises an output to its occupied capacity; a budget below that is a mistake.
  if (tx.outputs[0].capacity !== opts.budget) {
    throw new SessionBalanceError(`budget must be at least ${ccc.fixedPointToString(tx.outputs[0].capacity)} CKB`);
  }
  // The first period, paid now.
  const target = acp ? (await collect(client, payToLock))[0] : undefined;
  if (target) {
    tx.inputs.push(ccc.CellInput.from({ previousOutput: target.outPoint }));
    tx.addOutput({ lock: payToLock, capacity: target.cellOutput.capacity + opts.price });
    await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.AnyoneCanPay);
  } else {
    tx.addOutput({ lock: payToLock, capacity: opts.price });
    if (tx.outputs[1].capacity !== opts.price) {
      throw new SessionBalanceError(`payTo has no cell to top up, and a new one needs ${ccc.fixedPointToString(newCell)} CKB`);
    }
  }
  await tx.completeInputsByCapacity(subscriber);
  if (opts.account !== undefined) {
    let mine = -1;
    for (let i = 0; i < tx.inputs.length && mine < 0; i++) {
      await tx.inputs[i].completeExtraInfos(client);
      if (tx.inputs[i].cellOutput?.lock.eq(subscriberLock)) mine = i;
    }
    if (mine < 0) throw new SessionBalanceError("no input of the subscriber to carry the account memo");
    tx.setWitnessArgsAt(mine, { inputType: subscriptionMemo(opts.account) });
  }
  await tx.completeFeeBy(subscriber);
  let funded = sub;
  const txHash = await signAndSend(subscriber, tx, async (hash) => {
    funded = { ...sub, openTx: hash };
    await opts.beforeSend?.(funded);
  });
  return { txHash, subscription: funded };
}

/** The live cells of a subscription, their balance, and how many blocks until one can be charged. */
export async function findSubscriptionCells(
  client: ccc.Client,
  deployment: SessionLockDeployment,
  sub: Subscription,
): Promise<{ lock: ccc.Script; cells: ccc.Cell[]; balance: bigint; nextChargeIn: bigint | undefined }> {
  const lock = subscriptionLock(deployment, sub);
  const cells = await subscriptionCells(client, lock);
  const balance = cells.reduce((s, c) => s + c.cellOutput.capacity, 0n);
  if (!cells.length) return { lock, cells, balance, nextChargeIn: undefined };
  const tip = await client.getTip();
  let nextChargeIn: bigint | undefined;
  for (const c of cells) {
    const born = (await client.getTransaction(c.outPoint.txHash))?.blockNumber;
    if (born === undefined || born === null) continue; // not committed yet
    const age = tip - ccc.numFrom(born);
    const wait = age >= sub.periodBlocks ? 0n : sub.periodBlocks - age;
    if (nextChargeIn === undefined || wait < nextChargeIn) nextChargeIn = wait;
  }
  return { lock, cells, balance, nextChargeIn };
}

/**
 * The creator's charger key takes one price from the subscription and pays it to
 * `payTo` (topping up its anyone-can-pay cell with `topUp`). The fee comes from
 * one of the charger's own plain cells, which goes back to it smaller. Throws a
 * `SessionBalanceError` while no cell is a full period old, or once what is left
 * cannot cover a price and still leave a cell behind.
 */
export async function chargeSubscription(
  charger: ccc.Signer,
  deployment: SessionLockDeployment,
  sub: Subscription,
  opts: { payTo: string; topUp?: boolean; beforeSend?: (txHash: ccc.Hex) => Promise<void> },
): Promise<ccc.Hex> {
  const client = charger.client;
  assertTerms(sub);
  const chargerLock = (await charger.getRecommendedAddressObj()).script;
  if (chargerLock.hash() !== sub.chargerLockHash) throw new SessionPolicyError("this signer is not the subscription's charger");
  const { script: payToLock } = await ccc.Address.fromString(opts.payTo, client);
  if (payToLock.hash() !== sub.payToLockHash) throw new SessionPolicyError("payTo is not the subscription's payout address");

  const state = await findSubscriptionCells(client, deployment, sub);
  if (!state.cells.length) throw new SessionBalanceError("no subscription cell: cancelled, or not committed yet");
  if (state.nextChargeIn !== 0n) {
    throw new SessionBalanceError(
      state.nextChargeIn === undefined
        ? "the subscription's cell is not committed yet"
        : `not a full period yet: next charge in ${state.nextChargeIn} blocks`,
    );
  }

  const tx = ccc.Transaction.from({ cellDeps: [sessionLockCellDep(deployment)] });
  if (opts.topUp) {
    if (!(await isAnyoneCanPay(payToLock, client))) throw new SessionPolicyError("topUp needs an anyone-can-pay payTo");
    const targets = await collect(client, payToLock);
    const target = targets[Math.floor(Math.random() * targets.length)];
    if (!target) throw new SessionBalanceError("payTo has no anyone-can-pay cell to top up");
    tx.inputs.push(ccc.CellInput.from({ previousOutput: target.outPoint }));
    tx.addOutput({ lock: payToLock, capacity: target.cellOutput.capacity + sub.price });
    await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.AnyoneCanPay);
  } else {
    tx.addOutput({ lock: payToLock, capacity: sub.price });
    if (tx.outputs[0].capacity !== sub.price) {
      throw new SessionBalanceError(`a charge to a new cell must be at least ${ccc.fixedPointToString(tx.outputs[0].capacity)} CKB`);
    }
  }

  // Every mature cell, merged into one change: the rate limit is per cell, so
  // leaving one out would let it pay another price in the same period (code review, 26 Oct).
  const taken = await matureCells(client, state.cells, sub.periodBlocks);
  const ckbIn = taken.reduce((s, c) => s + c.cellOutput.capacity, 0n);
  const since = relativeBlocksSince(sub.periodBlocks);
  tx.inputs.unshift(...taken.map((c) => ccc.CellInput.from({ previousOutput: c.outPoint, since })));
  const change = ckbIn - sub.price;
  const cellSize = ccc.CellOutput.from({ lock: state.lock }, "0x").capacity;
  if (change < 0n || (change > 0n && change < cellSize)) {
    throw new SessionBalanceError(
      `the subscription holds ${ccc.fixedPointToString(ckbIn)} CKB: not enough for a price of ` +
        `${ccc.fixedPointToString(sub.price)} CKB and a ${ccc.fixedPointToString(cellSize)} CKB cell left behind`,
    );
  }
  if (change > 0n) tx.addOutput({ lock: state.lock, capacity: change });

  // The charger's own cell authorises the charge and pays the fee; it comes back last, smaller.
  const floor = keyCellFloor(chargerLock);
  const keyCell = (await collect(client, chargerLock)).find((c) => c.cellOutput.capacity > floor);
  if (!keyCell) throw new SessionBalanceError(`the charger needs a plain cell above ${ccc.fixedPointToString(floor)} CKB for fees`);
  tx.inputs.push(ccc.CellInput.from({ previousOutput: keyCell.outPoint }));
  tx.addOutput({ lock: chargerLock, capacity: 0n });
  await tx.completeFeeChangeToOutput(charger, tx.outputs.length - 1);
  return signAndSend(charger, tx, opts.beforeSend);
}

/**
 * The subscriber takes everything left back, in owner mode: no creator involved
 * and no wait. `nothingFound` means no cell is left (already cancelled, or run dry).
 * Subscriptions are also found and swept by `recoverSessions`, since their args
 * begin with the subscriber's lock hash like any session's.
 */
export async function cancelSubscription(
  subscriber: ccc.Signer,
  deployment: SessionLockDeployment,
  sub: Subscription,
): Promise<{ txHash?: ccc.Hex; refunded: bigint; nothingFound?: true }> {
  const lock = (await subscriber.getRecommendedAddressObj()).script;
  if (lock.hash() !== sub.subscriberLockHash) throw new SessionPolicyError("this signer is not the subscriber");
  const { cells, balance } = await findSubscriptionCells(subscriber.client, deployment, sub);
  if (!cells.length) return { refunded: 0n, nothingFound: true };
  return { txHash: await ownerSweep(subscriber, deployment, cells), refunded: balance };
}

export type SubscriptionCheck =
  | {
      ok: true;
      subscription: Subscription;
      balance: bigint;
      /** Charges the cell can still pay. */
      chargesLeft: bigint;
      /** The block until which the subscriber has paid: the block that created this cell, plus one period. */
      paidThroughBlock: bigint;
    }
  | { ok: false; reason: string };

/**
 * The creator checks a subscription from the chain alone. Nothing in the request
 * is trusted but the out point. The cell at `outPoint` must be live, under this
 * deployment of the session lock (never an older one), untyped and without data,
 * with 112-byte args holding exactly these terms, and at least `minBalance`.
 *
 * And the transaction that created the cell must have paid `payTo` at least one
 * price: the opening pays the first period, every charge pays one. A cell the
 * subscriber re-created in owner mode to reset its age paid nothing, and is
 * refused (review H2). So access is granted up to `paidThroughBlock`; check the
 * current cell again (`findSubscriptionCells`) once that block has passed.
 *
 * With `account`, the creating transaction must also carry `subscriptionMemo(account)`
 * in the witness of an input under the subscriber's lock, which only the
 * subscriber's signature covers: someone else's subscription cannot be claimed
 * (review H3). The memo is in the opening only, so check `account` once, when a
 * subscription is registered, then keep the subscription by its lock.
 */
export async function verifySubscription(
  client: ccc.Client,
  deployment: SessionLockDeployment,
  outPoint: ccc.OutPointLike,
  expected: { charger: string; payTo: string; price: bigint; periodBlocks: bigint; minBalance?: bigint; account?: string },
): Promise<SubscriptionCheck> {
  const cell = await client.getCellLive(outPoint, true, false);
  if (!cell) return { ok: false, reason: "no live cell at that out point" };
  const lock = cell.cellOutput.lock;
  if (lock.codeHash !== ccc.hexFrom(deployment.codeHash) || lock.hashType !== ccc.hashTypeFrom(deployment.hashType)) {
    return { ok: false, reason: "not under this deployment of the session lock" };
  }
  if (cell.cellOutput.type || cell.outputData !== "0x") return { ok: false, reason: "a subscription cell carries no type and no data" };
  const args = ccc.bytesFrom(lock.args);
  if (args.length !== 112) return { ok: false, reason: "not a subscription: args must be 112 bytes (CKB, with a payout address)" };
  const [chargerLock, payToLock] = await Promise.all(
    [expected.charger, expected.payTo].map(async (a) => (await ccc.Address.fromString(a, client)).script),
  );
  const sub: Subscription = {
    subscriberLockHash: ccc.hexFrom(args.slice(0, 32)),
    chargerLockHash: ccc.hexFrom(args.slice(32, 64)),
    price: ccc.numLeFromBytes(args.slice(64, 72)),
    periodBlocks: ccc.numLeFromBytes(args.slice(72, 80)),
    payToLockHash: ccc.hexFrom(args.slice(80, 112)),
  };
  if (sub.chargerLockHash !== chargerLock.hash()) return { ok: false, reason: "a different charger" };
  if (sub.payToLockHash !== payToLock.hash()) return { ok: false, reason: "a different payout address" };
  if (sub.price !== expected.price) return { ok: false, reason: "a different price" };
  if (sub.periodBlocks !== expected.periodBlocks) return { ok: false, reason: "a different period" };
  try {
    assertTerms(sub);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const cellSize = ccc.CellOutput.from({ lock }, "0x").capacity;
  const balance = cell.cellOutput.capacity;
  if (balance < (expected.minBalance ?? cellSize)) {
    return { ok: false, reason: `holds ${ccc.fixedPointToString(balance)} CKB, under the minimum` };
  }

  const created = await paymentOf(client, deployment, cell.outPoint.txHash, sub);
  if (typeof created === "string") return { ok: false, reason: created };
  if (expected.account !== undefined && !commitsToAccount(created, sub, expected.account)) {
    return { ok: false, reason: "the opening does not commit to this account" };
  }
  return {
    ok: true,
    subscription: sub,
    balance,
    chargesLeft: balance >= cellSize + sub.price ? (balance - cellSize) / sub.price : 0n,
    paidThroughBlock: created.block + sub.periodBlocks,
  };
}

interface Payment {
  tx: ccc.Transaction;
  block: bigint;
  inputs: (ccc.Cell | undefined)[];
}

/** The most inputs a creating transaction may have before its inputs are looked up (each is an RPC call). */
const MAX_PAYMENT_INPUTS = 32;

/**
 * The committed transaction `txHash`, if it paid `sub`'s payout address enough;
 * otherwise why not. Enough is the sum of the prices of every subscription cell
 * it creates for that payout address, not one price: otherwise one payment could
 * open or renew many subscriptions at once (code review, 26 Oct). Only untyped
 * cells count as paid, and an input that cannot be looked up fails the check.
 */
async function paymentOf(
  client: ccc.Client,
  deployment: SessionLockDeployment,
  txHash: ccc.HexLike,
  sub: Subscription,
): Promise<Payment | string> {
  const created = await client.getTransaction(txHash);
  if (!created || created.status !== "committed" || created.blockNumber === undefined || created.blockNumber === null) {
    return "the transaction that created the cell is not committed";
  }
  const tx = created.transaction;
  if (tx.inputs.length > MAX_PAYMENT_INPUTS) return `the transaction has over ${MAX_PAYMENT_INPUTS} inputs`;
  const codeHash = ccc.hexFrom(deployment.codeHash);
  const hashType = ccc.hashTypeFrom(deployment.hashType);
  let owed = 0n;
  for (const o of tx.outputs) {
    const args = ccc.bytesFrom(o.lock.args);
    if (o.lock.codeHash !== codeHash || o.lock.hashType !== hashType || args.length !== 112) continue;
    if (ccc.hexFrom(args.slice(80, 112)) === sub.payToLockHash) owed += ccc.numLeFromBytes(args.slice(64, 72));
  }
  if (owed < sub.price) owed = sub.price;
  const inputs = await Promise.all(tx.inputs.map((i) => client.getCell(i.previousOutput)));
  if (inputs.some((c) => !c)) return "an input of the transaction could not be looked up";
  const sum = (cells: ccc.CellOutput[]) =>
    cells.reduce((s, c) => (!c.type && c.lock.hash() === sub.payToLockHash ? s + c.capacity : s), 0n);
  const paid = sum(tx.outputs) - sum(inputs.map((c) => c!.cellOutput));
  if (paid < owed) return "the transaction that created the cell did not pay the price to payTo";
  return { tx, block: ccc.numFrom(created.blockNumber), inputs };
}

/** Whether `p` carries `subscriptionMemo(account)` in the witness of an input under the subscriber's lock. */
function commitsToAccount(p: Payment, sub: Subscription, account: string): boolean {
  const memo = subscriptionMemo(account);
  return p.inputs.some(
    (c, i) => c?.cellOutput.lock.hash() === sub.subscriberLockHash && p.tx.getWitnessArgsAt(i)?.inputType === memo,
  );
}

export interface SubscriptionStatus {
  /** The block until which the subscriber has paid, from the newest paying cell; undefined when no cell is left. */
  paidThroughBlock: bigint | undefined;
  tip: bigint;
  /** Whether the tip is within the paid period. */
  active: boolean;
  balance: bigint;
  chargesLeft: bigint;
  /** Blocks until the creator may charge again (0 = now). */
  nextChargeIn: bigint | undefined;
}

/**
 * Where a subscription stands, for a creator's server that keeps no database:
 * the subscriber sends the terms' subscriber lock hash, the opening's hash and
 * its account id on every request. The opening must have paid the first price
 * into a cell under exactly this subscription's lock and committed to `account`
 * under the subscriber's signature; then the live cells give the period paid for.
 * Each must have been created by a payment, so a cell re-created by the
 * subscriber to reset its age counts for nothing. Cancelling ends access at once.
 */
export async function subscriptionStatus(
  client: ccc.Client,
  deployment: SessionLockDeployment,
  sub: Subscription,
  proof: { openTx: ccc.HexLike; account: string },
): Promise<{ ok: true; status: SubscriptionStatus } | { ok: false; reason: string }> {
  try {
    assertTerms(sub);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const lock = subscriptionLock(deployment, sub);
  const opening = await paymentOf(client, deployment, proof.openTx, sub);
  if (typeof opening === "string") return { ok: false, reason: `opening: ${opening}` };
  if (!opening.tx.outputs.some((o) => o.lock.eq(lock))) return { ok: false, reason: "the opening created no cell under this subscription's lock" };
  if (!commitsToAccount(opening, sub, proof.account)) return { ok: false, reason: "the opening does not commit to this account" };

  const { cells, balance, nextChargeIn } = await findSubscriptionCells(client, deployment, sub);
  const tip = await client.getTip();
  let paidThroughBlock: bigint | undefined;
  for (const c of cells) {
    const p = await paymentOf(client, deployment, c.outPoint.txHash, sub);
    if (typeof p === "string") continue;
    const through = p.block + sub.periodBlocks;
    if (paidThroughBlock === undefined || through > paidThroughBlock) paidThroughBlock = through;
  }
  const cellSize = ccc.CellOutput.from({ lock }, "0x").capacity;
  return {
    ok: true,
    status: {
      paidThroughBlock,
      tip,
      active: paidThroughBlock !== undefined && tip <= paidThroughBlock,
      balance,
      chargesLeft: balance >= cellSize + sub.price ? (balance - cellSize) / sub.price : 0n,
      nextChargeIn,
    },
  };
}

/**
 * About how many blocks `seconds` is, from the average block time over the last
 * `sample` blocks. Block time varies; round up when a period means "no more often than".
 */
export async function blocksForSeconds(client: ccc.Client, seconds: number, sample = 1000n): Promise<bigint> {
  const tip = await client.getTipHeader();
  const old = await client.getHeaderByNumber(tip.number > sample ? tip.number - sample : 0n);
  if (!old || tip.number === old.number) throw new Error("not enough blocks to estimate block time");
  const msPerBlock = Number(tip.timestamp - old.timestamp) / Number(tip.number - old.number);
  return BigInt(Math.ceil((seconds * 1000) / msPerBlock));
}
