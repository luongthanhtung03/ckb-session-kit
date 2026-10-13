import { ccc } from "@ckb-ccc/core";
import {
  relativeBlocksSince,
  sessionLockCellDep,
  sessionLockScript,
  type SessionLockDeployment,
  type SessionLockParams,
} from "./lock.js";
import { checkRequest, SessionPolicyError, type Session } from "./session.js";
import { ScopeError, sessionSigner } from "./transfer.js";

/**
 * Sessions enforced by the on-chain session lock.
 *
 * - `openSession`  — the owner (any CCC signer: a wallet) funds a session cell under
 *   the session lock and a key cell under the session key's own lock. One signature.
 * - `spendInSession` — the session key alone spends from the session cell; the key
 *   cell pays the fee. No wallet involved; the network enforces the scope. With
 *   `topUp`, it adds to the recipient's anyone-can-pay cell instead of creating a
 *   new one, so a payment can be any size (a new cell needs at least 61 CKB).
 * - `closeSession` — the key cell goes back to the owner (session key signs), then
 *   the owner sweeps the session cells (one wallet signature).
 * - `recoverSessions` — the device holding the session key is gone: the owner's
 *   wallet alone finds every session it opened and sweeps them back.
 */

/** What the browser must remember, besides the key, to find and spend the session. */
export type OnChainBinding = NonNullable<Session["onchain"]>;

export interface SessionCells {
  lock: ccc.Script;
  keyLock: ccc.Script;
  sessionCells: ccc.Cell[];
  keyCells: ccc.Cell[];
  /** Spendable balance of the session cells, in shannons. */
  balance: bigint;
  /** Fee budget left in the key cells, in shannons. */
  feeBalance: bigint;
}

export class SessionBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBalanceError";
  }
}

const KEY_CELL_MIN = 61n * 100_000_000n;
const DEFAULT_FEE_BUDGET = 62n * 100_000_000n;

export async function keyLockOf(session: Session, client: ccc.Client): Promise<ccc.Script> {
  return (await sessionSigner(session, client).getRecommendedAddressObj()).script;
}

function params(session: Session, keyLock: ccc.Script, binding: OnChainBinding): SessionLockParams {
  return {
    ownerLockHash: ccc.Script.from(binding.ownerLock).hash(),
    sessionLockHash: keyLock.hash(),
    maxPerTx: session.policy.scope.maxPerTx,
    minInterval: binding.minInterval,
    ...(binding.recipientLockHash && { recipientLockHash: binding.recipientLockHash }),
  };
}

export async function sessionLockOf(
  session: Session,
  client: ccc.Client,
  deployment: SessionLockDeployment,
  binding: OnChainBinding,
): Promise<ccc.Script> {
  return sessionLockScript(deployment, params(session, await keyLockOf(session, client), binding));
}

async function collect(client: ccc.Client, lock: ccc.Script): Promise<ccc.Cell[]> {
  const cells: ccc.Cell[] = [];
  for await (const cell of client.findCellsByLock(lock, null, true)) {
    if (!cell.cellOutput.type && cell.outputData === "0x") cells.push(cell);
  }
  return cells;
}

export async function findSessionCells(
  session: Session,
  client: ccc.Client,
  deployment: SessionLockDeployment,
  binding: OnChainBinding,
): Promise<SessionCells> {
  const keyLock = await keyLockOf(session, client);
  const lock = sessionLockScript(deployment, params(session, keyLock, binding));
  const [sessionCells, keyCells] = await Promise.all([collect(client, lock), collect(client, keyLock)]);
  const sum = (cells: ccc.Cell[]) => cells.reduce((s, c) => s + c.cellOutput.capacity, 0n);
  return { lock, keyLock, sessionCells, keyCells, balance: sum(sessionCells), feeBalance: sum(keyCells) };
}

/**
 * The recipient the session lock will enforce, taken from the session's own scope
 * so the browser and the chain cannot disagree. The lock holds one recipient, so a
 * scope listing several cannot be enforced on-chain and is refused.
 */
export function onchainRecipient(session: Session): string | undefined {
  const { recipients } = session.policy.scope;
  if (!recipients) return undefined;
  if (recipients.length !== 1) {
    throw new SessionPolicyError(
      `the session lock enforces one recipient; scope.recipients lists ${recipients.length}`,
    );
  }
  return recipients[0];
}

/**
 * Owner funds the session: one transaction, one signature from `owner`.
 * The on-chain recipient comes from `session.policy.scope.recipients`.
 *
 * `beforeSend` runs once the transaction is built and before it is sent: save the
 * session there (`store.save({ ...session, onchain: binding })`). Saved after
 * sending, a failed save would leave funds under a key that exists nowhere.
 */
export async function openSession(
  owner: ccc.Signer,
  session: Session,
  deployment: SessionLockDeployment,
  opts: {
    budget: bigint;
    feeBudget?: bigint;
    minInterval?: bigint;
    beforeSend?: (binding: OnChainBinding) => Promise<void>;
  },
): Promise<{ txHash: ccc.Hex; binding: OnChainBinding }> {
  const client = owner.client;
  if (opts.minInterval !== undefined) relativeBlocksSince(opts.minInterval); // a spend must be able to meet it
  const feeBudget = opts.feeBudget ?? DEFAULT_FEE_BUDGET;
  if (feeBudget <= KEY_CELL_MIN) {
    throw new SessionBalanceError(
      `feeBudget must be above ${ccc.fixedPointToString(KEY_CELL_MIN)} CKB: the key cell must stay that size after paying fees`,
    );
  }
  const ownerLock = (await owner.getRecommendedAddressObj()).script;
  const recipient = onchainRecipient(session);
  const recipientLockHash = recipient
    ? (await ccc.Address.fromString(recipient, client)).script.hash()
    : undefined;
  const binding: OnChainBinding = {
    ownerLock: { codeHash: ownerLock.codeHash, hashType: ownerLock.hashType, args: ownerLock.args },
    minInterval: opts.minInterval ?? 0n,
    ...(recipientLockHash && { recipientLockHash }),
  };
  const keyLock = await keyLockOf(session, client);
  const lock = sessionLockScript(deployment, params(session, keyLock, binding));

  const tx = ccc.Transaction.from({
    outputs: [
      { lock, capacity: opts.budget },
      { lock: keyLock, capacity: feeBudget },
    ],
  });
  // CCC raises an output to its occupied capacity; a budget below that is a mistake.
  if (tx.outputs[0].capacity !== opts.budget) {
    throw new SessionBalanceError(`budget must be at least ${ccc.fixedPointToString(tx.outputs[0].capacity)} CKB`);
  }
  await tx.completeInputsByCapacity(owner);
  await tx.completeFeeBy(owner);
  await opts.beforeSend?.(binding);
  return { txHash: await owner.sendTransaction(tx), binding };
}

/**
 * The session key pays `amount` to `to`. The scope is checked here first, then
 * the network checks it again in the session lock. No wallet is involved.
 *
 * `topUp: true` pays into an existing cell of `to` instead of creating one. `to`
 * must be an anyone-can-pay address with at least one live plain cell; that cell
 * is consumed and recreated holding `amount` more, which the anyone-can-pay lock
 * allows without the recipient's signature.
 *
 * `memo` is recorded in the witness of the session key's own input, which that
 * key's signature covers: the payment commits to it (see `verifyAccess`).
 */
export async function spendInSession(
  session: Session,
  client: ccc.Client,
  deployment: SessionLockDeployment,
  binding: OnChainBinding,
  request: { to: string; amount: bigint; topUp?: boolean; memo?: ccc.HexLike },
  now: Date = new Date(),
): Promise<ccc.Hex> {
  const check = checkRequest(session, request, now);
  if (!check.ok) throw new ScopeError(check.reason);

  const state = await findSessionCells(session, client, deployment, binding);
  const { script: toLock } = await ccc.Address.fromString(request.to, client);
  if (binding.recipientLockHash && toLock.hash() !== binding.recipientLockHash) {
    throw new ScopeError("recipient not in scope");
  }
  if (!state.keyCells.length) throw new SessionBalanceError("no key cell left to pay fees");

  // Take session cells until they cover the payment.
  const inputs: ccc.Cell[] = [];
  let taken = 0n;
  for (const cell of state.sessionCells) {
    if (taken >= request.amount) break;
    inputs.push(cell);
    taken += cell.cellOutput.capacity;
  }
  if (taken < request.amount) {
    throw new SessionBalanceError(`session balance ${ccc.fixedPointToString(state.balance)} CKB is too low`);
  }

  const since = binding.minInterval > 0n ? relativeBlocksSince(binding.minInterval) : 0n;
  const tx = ccc.Transaction.from({
    inputs: inputs.map((c) => ccc.CellInput.from({ previousOutput: c.outPoint, since })),
    outputs: [{ lock: toLock, capacity: request.amount }],
    cellDeps: [sessionLockCellDep(deployment)],
  });
  if (request.topUp) {
    const acp = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
    if (toLock.codeHash !== acp.codeHash || toLock.hashType !== acp.hashType) {
      throw new ScopeError("top-up needs an anyone-can-pay recipient");
    }
    // Readers paying at once compete for a cell; a random pick spreads them out
    // when the recipient keeps several.
    const targets = await collect(client, toLock);
    const target = targets[Math.floor(Math.random() * targets.length)];
    if (!target) throw new SessionBalanceError("the recipient has no anyone-can-pay cell to top up");
    tx.inputs.push(ccc.CellInput.from({ previousOutput: target.outPoint }));
    tx.outputs[0].capacity = target.cellOutput.capacity + request.amount;
    await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.AnyoneCanPay);
  } else if (tx.outputs[0].capacity !== request.amount) {
    throw new SessionBalanceError(`a payment must be at least ${ccc.fixedPointToString(tx.outputs[0].capacity)} CKB`);
  }
  const change = taken - request.amount;
  if (change > 0n) {
    tx.addOutput({ lock: state.lock, capacity: change });
    if (tx.outputs[1].capacity !== change) {
      throw new SessionBalanceError(
        `the session would keep ${ccc.fixedPointToString(change)} CKB, below the ` +
          `${ccc.fixedPointToString(tx.outputs[1].capacity)} CKB a session cell needs; ` +
          `spend all of it or less`,
      );
    }
  }
  // The key cell authorises the spend, comes back as the last output and pays the fee.
  tx.inputs.push(ccc.CellInput.from({ previousOutput: state.keyCells[0].outPoint }));
  if (request.memo !== undefined) tx.setWitnessArgsAt(tx.inputs.length - 1, { inputType: request.memo });
  tx.addOutput({ lock: state.keyLock, capacity: 0n });
  await tx.completeFeeChangeToOutput(sessionSigner(session, client), tx.outputs.length - 1);
  if (tx.outputs[tx.outputs.length - 1].capacity < KEY_CELL_MIN) {
    throw new SessionBalanceError("the key cell cannot cover another fee; top it up");
  }
  return sessionSigner(session, client).sendTransaction(tx);
}

/**
 * Ends the session: the owner sweeps the session cells (one wallet signature),
 * then the key cell returns to the owner (session key signs, no wallet).
 *
 * The sweep goes first because it is what matters: a key cell too small to pay
 * for the owner's lock (some wallets' locks need more than 61 CKB) must not block
 * it. A key-cell failure is reported in `keyError`; the key stays usable for a retry.
 */
export async function closeSession(
  owner: ccc.Signer,
  session: Session,
  deployment: SessionLockDeployment,
  binding: OnChainBinding,
): Promise<{ keyTx?: ccc.Hex; sweepTx?: ccc.Hex; keyError?: string }> {
  const client = owner.client;
  const ownerLock = ccc.Script.from(binding.ownerLock);
  const state = await findSessionCells(session, client, deployment, binding);
  const result: { keyTx?: ccc.Hex; sweepTx?: ccc.Hex; keyError?: string } = {};

  if (state.sessionCells.length) result.sweepTx = await ownerSweep(owner, deployment, state.sessionCells);

  if (state.keyCells.length) {
    try {
      const tx = ccc.Transaction.from({
        inputs: state.keyCells.map((c) => ({ previousOutput: c.outPoint })),
        outputs: [{ lock: ownerLock, capacity: 0n }],
      });
      await tx.completeFeeChangeToOutput(sessionSigner(session, client), 0);
      result.keyTx = await sessionSigner(session, client).sendTransaction(tx);
    } catch (e) {
      result.keyError = e instanceof Error ? e.message : String(e);
    }
  }
  return result;
}

/**
 * Every live session cell this owner opened, found without any session key.
 *
 * Session-lock args begin with the owner's lock hash, so an indexer prefix search
 * on the args finds them all. Only well-formed args (80 or 112 bytes) are kept: a
 * cell with malformed args would fail the lock even in owner mode, and anyone can
 * create one with this owner's hash as a prefix to block a sweep.
 *
 * Pass several deployments (`[TESTNET_DEPLOYMENT, ...TESTNET_LEGACY_DEPLOYMENTS]`)
 * to find sessions opened under earlier versions of the lock as well.
 */
export async function findOwnedSessionCells(
  owner: ccc.Signer,
  deployments: SessionLockDeployment | SessionLockDeployment[],
): Promise<ccc.Cell[]> {
  const ownerLock = (await owner.getRecommendedAddressObj()).script;
  const cells: ccc.Cell[] = [];
  for (const deployment of [deployments].flat()) {
    for await (const cell of owner.client.findCells({
      script: { codeHash: deployment.codeHash, hashType: deployment.hashType, args: ownerLock.hash() },
      scriptType: "lock",
      scriptSearchMode: "prefix",
      withData: true,
    })) {
      const argBytes = (cell.cellOutput.lock.args.length - 2) / 2;
      if ((argBytes === 80 || argBytes === 112) && !cell.cellOutput.type) cells.push(cell);
    }
  }
  return cells;
}

/**
 * Device-loss recovery: sweeps every session this owner opened back to the owner,
 * in one transaction and one wallet signature. Needs nothing from the lost device.
 *
 * Anyone can create a cell under a session lock carrying this owner's hash and
 * their own key, and spend it before the sweep lands, which would make a single
 * sweep fail. So if the one transaction is refused, each session (cells sharing a
 * session key) is swept on its own, one signature each: a cell someone else can
 * spend fails alone, and `failed` counts the sessions not recovered.
 *
 * The key cell (the fee budget) is under the session key's own lock and cannot be
 * recovered without that key; keep it small.
 */
export async function recoverSessions(
  owner: ccc.Signer,
  deployments: SessionLockDeployment | SessionLockDeployment[],
): Promise<{ txHashes: ccc.Hex[]; recovered: bigint; cells: number; failed: number }> {
  const deployment = [deployments].flat();
  const cells = await findOwnedSessionCells(owner, deployment);
  const total = (cs: ccc.Cell[]) => cs.reduce((sum, c) => sum + c.cellOutput.capacity, 0n);
  if (!cells.length) return { txHashes: [], recovered: 0n, cells: 0, failed: 0 };
  try {
    return { txHashes: [await ownerSweep(owner, deployment, cells)], recovered: total(cells), cells: cells.length, failed: 0 };
  } catch {
    // Fall through: one session at a time.
  }
  const sessions = new Map<string, ccc.Cell[]>();
  for (const c of cells) {
    const keyHash = c.cellOutput.lock.args.slice(66, 130); // session_lock_hash, bytes 32..64
    sessions.set(keyHash, [...(sessions.get(keyHash) ?? []), c]);
  }
  const result = { txHashes: [] as ccc.Hex[], recovered: 0n, cells: 0, failed: 0 };
  for (const group of sessions.values()) {
    try {
      result.txHashes.push(await ownerSweep(owner, deployment, group));
      result.recovered += total(group);
      result.cells += group.length;
    } catch {
      result.failed++;
    }
  }
  return result;
}

/** Spends `cells` in owner mode: everything returns to the owner as change. */
async function ownerSweep(
  owner: ccc.Signer,
  deployments: SessionLockDeployment | SessionLockDeployment[],
  cells: ccc.Cell[],
): Promise<ccc.Hex> {
  // The code of every lock version these cells are under, and only those.
  const used = [deployments].flat().filter((d) => cells.some((c) => c.cellOutput.lock.codeHash === d.codeHash));
  const tx = ccc.Transaction.from({
    inputs: cells.map((c) => ({ previousOutput: c.outPoint })),
    outputs: [],
    cellDeps: used.map(sessionLockCellDep),
  });
  // Owner mode needs an owner-locked input in the transaction.
  for await (const cell of owner.findCells({ scriptLenRange: [0, 1], outputDataLenRange: [0, 1] }, true)) {
    tx.inputs.push(ccc.CellInput.from({ previousOutput: cell.outPoint }));
    await tx.completeFeeBy(owner);
    return owner.sendTransaction(tx);
  }
  throw new SessionBalanceError("the owner needs one plain cell to prove ownership");
}
