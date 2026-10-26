import { ccc } from "@ckb-ccc/core";
import {
  relativeBlocksSince,
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
 * The subscriber opens a subscription: one cell holding `budget` shannons under
 * the session lock. One signature; no key cell (the creator already owns cells
 * under its charger key). `budget` of the cell's own size (153 CKB) plus n prices
 * pays n periods exactly; what is left comes back on cancel.
 *
 * `payTo` should be an anyone-can-pay address with a live cell, so a charge of
 * any size tops it up; otherwise each charge creates a new cell and the price must
 * be at least that cell's size (61 CKB for a plain address).
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
    beforeSend?: (sub: Subscription) => Promise<void>;
  },
): Promise<{ txHash: ccc.Hex; subscription: Subscription }> {
  const client = subscriber.client;
  const subscriberLock = (await subscriber.getRecommendedAddressObj()).script;
  await assertSigningLock(subscriberLock, client);
  const [chargerLock, payToLock] = await Promise.all(
    [opts.charger, opts.payTo].map(async (a) => (await ccc.Address.fromString(a, client)).script),
  );
  const sub: Subscription = {
    subscriberLockHash: subscriberLock.hash(),
    chargerLockHash: chargerLock.hash(),
    payToLockHash: payToLock.hash(),
    price: opts.price,
    periodBlocks: opts.periodBlocks,
  };
  assertTerms(sub);
  const newCell = ccc.CellOutput.from({ lock: payToLock }, "0x").capacity;
  if (opts.price < newCell && !(await isAnyoneCanPay(payToLock, client))) {
    throw new SessionPolicyError(
      `each charge creates a cell for payTo, which needs ${ccc.fixedPointToString(newCell)} CKB: ` +
        "raise the price or use an anyone-can-pay address",
    );
  }

  const tx = ccc.Transaction.from({ outputs: [{ lock: subscriptionLock(deployment, sub), capacity: opts.budget }] });
  // CCC raises an output to its occupied capacity; a budget below that is a mistake.
  if (tx.outputs[0].capacity !== opts.budget) {
    throw new SessionBalanceError(`budget must be at least ${ccc.fixedPointToString(tx.outputs[0].capacity)} CKB`);
  }
  await tx.completeInputsByCapacity(subscriber);
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
  const cells = await collect(client, lock);
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

  // One mature cell that covers the price; several only if none does alone.
  const mature = await matureCells(client, state.cells, sub.periodBlocks);
  mature.sort((a, b) => (a.cellOutput.capacity > b.cellOutput.capacity ? -1 : 1));
  const taken: ccc.Cell[] = [];
  let ckbIn = 0n;
  for (const c of mature) {
    if (ckbIn >= sub.price) break;
    taken.push(c);
    ckbIn += c.cellOutput.capacity;
  }
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
  | { ok: true; subscription: Subscription; balance: bigint }
  | { ok: false; reason: string };

/**
 * The creator checks a subscription a subscriber says it opened, from the chain
 * alone: the cell at `outPoint` must be live, under this deployment of the session
 * lock, untyped, with exactly these terms, and hold at least `minBalance` (by
 * default one price plus the cell's own size, so at least one charge can happen).
 * Nothing in the request is trusted but the out point.
 */
export async function verifySubscription(
  client: ccc.Client,
  deployment: SessionLockDeployment,
  outPoint: ccc.OutPointLike,
  expected: { charger: string; payTo: string; price: bigint; periodBlocks: bigint; minBalance?: bigint },
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
  const minBalance = expected.minBalance ?? sub.price + ccc.CellOutput.from({ lock }, "0x").capacity;
  const balance = cell.cellOutput.capacity;
  if (balance < minBalance) return { ok: false, reason: `holds ${ccc.fixedPointToString(balance)} CKB, under the minimum` };
  return { ok: true, subscription: sub, balance };
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
