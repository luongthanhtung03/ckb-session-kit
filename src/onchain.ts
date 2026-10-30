import { ccc } from "@ckb-ccc/core";
import {
  relativeBlocksSince,
  sessionLockCellDep,
  sessionLockScript,
  type SessionLockDeployment,
  type SessionLockParams,
} from "./lock.js";
import { checkRequest, isActive, SessionPolicyError, type Session } from "./session.js";
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
 *
 * A token session (`openSession(..., { token })`) holds an xUDT token as well as
 * CKB; `spendInSession(..., { to, token })` pays in it, and the lock caps the
 * units per spend as it caps shannons. Sweeps return the tokens to the owner.
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
  /** Token units in the session cells (token sessions; 0 otherwise). */
  tokenBalance: bigint;
}

export class SessionBalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBalanceError";
  }
}

const KEY_CELL_MIN = 61n * 100_000_000n;
/** What the key cell keeps above the cell it returns to the owner as, for fees. */
const FEE_MARGIN = 1n * 100_000_000n;

/**
 * The smallest key cell that can still be returned to the owner: a cell under the
 * owner's lock (63 CKB for JoyID or Omnilock, whose args are 22 bytes), and never
 * below a key cell's own 61 CKB.
 */
export function keyCellFloor(ownerLock: ccc.ScriptLike): bigint {
  const ownerCell = ccc.CellOutput.from({ lock: ownerLock }, "0x").capacity;
  return ownerCell > KEY_CELL_MIN ? ownerCell : KEY_CELL_MIN;
}

/**
 * Signs `tx`, hands its final hash to `beforeSend`, then sends it. The hash is
 * known before anything leaves, so a caller can record the payment or the key
 * against it first. If the send throws but the node did take the transaction (a
 * timeout on the reply, say), the hash is returned all the same.
 */
export async function signAndSend(
  signer: ccc.Signer,
  tx: ccc.Transaction,
  beforeSend?: (txHash: ccc.Hex) => Promise<void>,
): Promise<ccc.Hex> {
  const signed = await signer.signTransaction(tx);
  const hash = signed.hash();
  await beforeSend?.(hash);
  try {
    return await signer.client.sendTransaction(signed);
  } catch (e) {
    const known = await signer.client.getTransaction(hash).catch(() => undefined);
    if (known && ["pending", "proposed", "committed"].includes(known.status)) return hash;
    throw e;
  }
}

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
    ...(binding.token && {
      token: { typeHash: ccc.Script.from(binding.token.type).hash(), maxPerTx: binding.token.maxPerTx },
    }),
  };
}

/** The xUDT amount in a cell's data (RFC 0052: u128 LE in the first 16 bytes). */
export function tokenAmount(data: ccc.HexLike): bigint {
  const bytes = ccc.bytesFrom(data);
  if (bytes.length < 16) throw new RangeError("not an xUDT cell: under 16 bytes of data");
  return ccc.numLeFromBytes(bytes.slice(0, 16));
}

export const tokenData = (amount: bigint, rest: Uint8Array = new Uint8Array()) =>
  ccc.hexFrom(ccc.bytesConcat(ccc.numLeToBytes(amount, 16), rest));

/** A cell's data is exactly a 16-byte amount: what the session lock accepts as token change. */
export const plainTokenCell = (cell: ccc.Cell, type: ccc.Script) =>
  cell.cellOutput.type?.eq(type) === true && ccc.bytesFrom(cell.outputData).length === 16;

export async function sessionLockOf(
  session: Session,
  client: ccc.Client,
  deployment: SessionLockDeployment,
  binding: OnChainBinding,
): Promise<ccc.Script> {
  return sessionLockScript(deployment, params(session, await keyLockOf(session, client), binding));
}

const U128_MAX = (1n << 128n) - 1n;
/** The most inputs a creating transaction may have for its origin to be looked up (each is an RPC call). */
const MAX_ORIGIN_INPUTS = 32;

/**
 * Whether a session-lock cell was created by a transaction its owner or its
 * session key took part in (an input under the lock hash in args bytes 0..32 or
 * 32..64). Nobody else can sign for those, so a planted cell never passes.
 */
async function ownOrigin(client: ccc.Client, cell: ccc.Cell): Promise<boolean> {
  const args = ccc.bytesFrom(cell.cellOutput.lock.args);
  const own = [ccc.hexFrom(args.slice(0, 32)), ccc.hexFrom(args.slice(32, 64))];
  const inputs = (await client.getTransaction(cell.outPoint.txHash))?.transaction.inputs ?? [];
  if (!inputs.length || inputs.length > MAX_ORIGIN_INPUTS) return false;
  const spent = await Promise.all(inputs.map((i) => client.getCell(i.previousOutput)));
  return spent.some((c) => !!c && own.includes(c.cellOutput.lock.hash()));
}

/**
 * `cells` less those whose token amounts would overflow a u128, per token type.
 * Anyone can plant a cell holding 2^128-1 units of a free token under a session
 * lock, and xUDT refuses a transaction whose inputs overflow, so taking every
 * cell would block spends, closes, recovery, charges and cancels (review, 27 and
 * 28 Oct). Which cells stay does not depend on indexer order: cells of the
 * owner's or the key's own making first, then the smallest amounts. Without an
 * overflow nothing is looked up and every cell stays, in order.
 */
export async function withinU128(client: ccc.Client, cells: ccc.Cell[]): Promise<ccc.Cell[]> {
  const units = (c: ccc.Cell) =>
    c.cellOutput.type && ccc.bytesFrom(c.outputData).length >= 16 ? tokenAmount(c.outputData) : 0n;
  const byType = new Map<string, ccc.Cell[]>();
  for (const c of cells) {
    if (!units(c)) continue;
    const key = c.cellOutput.type!.hash();
    byType.set(key, [...(byType.get(key) ?? []), c]);
  }
  const dropped = new Set<ccc.Cell>();
  for (const group of byType.values()) {
    if (group.reduce((s, c) => s + units(c), 0n) <= U128_MAX) continue;
    const own = await Promise.all(group.map((c) => ownOrigin(client, c)));
    const ranked = group
      .map((cell, i) => ({ cell, own: own[i], units: units(cell) }))
      .sort((a, b) => (a.own !== b.own ? (a.own ? -1 : 1) : a.units < b.units ? -1 : a.units > b.units ? 1 : 0));
    let sum = 0n;
    for (const r of ranked) {
      if (sum + r.units > U128_MAX) dropped.add(r.cell);
      else sum += r.units;
    }
  }
  return dropped.size ? cells.filter((c) => !dropped.has(c)) : cells;
}

/** Plain cells under `lock`; with `token`, also cells holding exactly that token. */
export async function collect(client: ccc.Client, lock: ccc.Script, token?: ccc.Script): Promise<ccc.Cell[]> {
  const cells: ccc.Cell[] = [];
  for await (const cell of client.findCellsByLock(lock, null, true)) {
    if ((!cell.cellOutput.type && cell.outputData === "0x") || (token && plainTokenCell(cell, token))) cells.push(cell);
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
  const token = binding.token && ccc.Script.from(binding.token.type);
  const [found, keyCells] = await Promise.all([collect(client, lock, token), collect(client, keyLock)]);
  const sessionCells = await withinU128(client, found);
  const sum = (cells: ccc.Cell[]) => cells.reduce((s, c) => s + c.cellOutput.capacity, 0n);
  const tokenBalance = sessionCells.reduce((s, c) => s + (c.cellOutput.type ? tokenAmount(c.outputData) : 0n), 0n);
  return { lock, keyLock, sessionCells, keyCells, balance: sum(sessionCells), feeBalance: sum(keyCells), tokenBalance };
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
 * Throws unless `lock` is known to need a signature over the whole transaction:
 * the session lock grants owner mode to any transaction with an input under the
 * owner's lock, so that lock is the only thing standing between a stranger and
 * every session. An allowlist, not a blocklist (code review, 14 Oct):
 *
 * - secp256k1-blake160 (single or multisig), JoyID, Nostr, PW lock;
 * - Omnilock with a signature auth flag (0x00-0x07: CKB, Ethereum, EOS, Tron,
 *   Bitcoin, Dogecoin, multisig; 0x12: Ethereum with the message displayed) and neither administrator (0x01) nor
 *   anyone-can-pay (0x02) mode. Auth flags 0xFC-0xFE hand the decision to
 *   another lock or to arbitrary code, and are refused.
 *
 * Anyone-can-pay (RFC 0026) unlocks with no signature at all: anyone could spend
 * the owner's cell back to itself unchanged and sweep every session.
 *
 * The owner must also never sign a partial (open) transaction with this lock.
 */
export async function assertSigningLock(lock: ccc.Script, client: ccc.Client): Promise<void> {
  const is = async (known: ccc.KnownScript) => {
    try {
      const s = await client.getKnownScript(known);
      return s.codeHash === lock.codeHash && s.hashType === lock.hashType;
    } catch {
      return false; // not deployed on this network
    }
  };
  if (await is(ccc.KnownScript.AnyoneCanPay)) {
    throw new SessionPolicyError("the owner's lock is anyone-can-pay: it needs no signature, so it cannot own a session");
  }
  if (await is(ccc.KnownScript.OmniLock)) {
    // Omnilock args: auth flag (1) + auth content (20) + omnilock flags (1) + ...
    const args = ccc.bytesFrom(lock.args);
    const omniFlags = args[21] ?? 0;
    if (omniFlags & 0x02) {
      throw new SessionPolicyError("the owner's Omnilock is in anyone-can-pay mode: it cannot own a session");
    }
    if (omniFlags & 0x01) {
      throw new SessionPolicyError("the owner's Omnilock has an administrator, who could unlock it: it cannot own a session");
    }
    const auth = args[0] ?? 0xff;
    // 0x12 is Ethereum with the message displayed: what CCC gives MetaMask and
    // OKX (EVM) users. Missing from this list until the wallet matrix (26 Oct).
    if (auth > 0x07 && auth !== 0x12) {
      throw new SessionPolicyError("the owner's Omnilock does not verify a signature itself: it cannot own a session");
    }
    return;
  }
  const signing = [
    ccc.KnownScript.Secp256k1Blake160,
    ccc.KnownScript.Secp256k1Multisig,
    ccc.KnownScript.Secp256k1MultisigV2,
    ccc.KnownScript.JoyId,
    ccc.KnownScript.NostrLock,
    ccc.KnownScript.PWLock,
  ];
  for (const known of signing) if (await is(known)) return;
  throw new SessionPolicyError(
    "the owner's lock is not one known to sign the whole transaction, so it cannot own a session",
  );
}

/**
 * Owner funds the session: one transaction, one signature from `owner`.
 * The on-chain recipient comes from `session.policy.scope.recipients`.
 *
 * `beforeSend` runs once the transaction is signed and before it is sent: save the
 * session there (`store.save({ ...session, onchain: binding })`). Saved after
 * sending, a failed save would leave funds under a key that exists nowhere. The
 * binding then carries `openTx`, the funding transaction's hash, which
 * `closeSession` checks before reporting that nothing is left.
 *
 * The key cell (`feeBudget`) must be able to return to the owner at the end: by
 * default it is the size of a cell under the owner's lock plus 1 CKB for fees.
 */
export async function openSession(
  owner: ccc.Signer,
  session: Session,
  deployment: SessionLockDeployment,
  opts: {
    budget: bigint;
    feeBudget?: bigint;
    minInterval?: bigint;
    /** A token session: put `amount` units of the xUDT `type` in it, and let one spend move at most `maxPerTx`. */
    token?: { type: ccc.ScriptLike; amount: bigint; maxPerTx: bigint };
    beforeSend?: (binding: OnChainBinding) => Promise<void>;
  },
): Promise<{ txHash: ccc.Hex; binding: OnChainBinding }> {
  const client = owner.client;
  const token = opts.token && ccc.Script.from(opts.token.type);
  if (token && opts.token) {
    await assertPlainXudt(token, client);
    if (opts.token.amount < 0n || opts.token.maxPerTx <= 0n) {
      throw new SessionBalanceError("token amount must not be negative and token maxPerTx must be positive");
    }
  }
  if (opts.minInterval !== undefined) relativeBlocksSince(opts.minInterval); // a spend must be able to meet it
  const ownerLock = (await owner.getRecommendedAddressObj()).script;
  await assertSigningLock(ownerLock, client);
  const floor = keyCellFloor(ownerLock);
  const feeBudget = opts.feeBudget ?? floor + FEE_MARGIN;
  if (feeBudget <= floor) {
    throw new SessionBalanceError(
      `feeBudget must be above ${ccc.fixedPointToString(floor)} CKB: the key cell pays fees and must still ` +
        "be able to return to the owner's lock",
    );
  }
  const recipient = onchainRecipient(session);
  const recipientLockHash = recipient
    ? (await ccc.Address.fromString(recipient, client)).script.hash()
    : undefined;
  const binding: OnChainBinding = {
    ownerLock: { codeHash: ownerLock.codeHash, hashType: ownerLock.hashType, args: ownerLock.args },
    minInterval: opts.minInterval ?? 0n,
    ...(recipientLockHash && { recipientLockHash }),
    ...(token &&
      opts.token && {
        token: { type: { codeHash: token.codeHash, hashType: token.hashType, args: token.args }, maxPerTx: opts.token.maxPerTx },
      }),
  };
  const keyLock = await keyLockOf(session, client);
  if (recipientLockHash === keyLock.hash()) {
    throw new SessionPolicyError("the recipient is the session key itself: it could then pay anyone");
  }
  const lock = sessionLockScript(deployment, params(session, keyLock, binding));

  const tx = ccc.Transaction.from({
    outputs: [
      { lock, capacity: opts.budget, ...(token && { type: token }) },
      { lock: keyLock, capacity: feeBudget },
    ],
    outputsData: [token && opts.token ? tokenData(opts.token.amount) : "0x", "0x"],
  });
  // CCC raises an output to its occupied capacity; a budget below that is a mistake.
  if (tx.outputs[0].capacity !== opts.budget) {
    throw new SessionBalanceError(`budget must be at least ${ccc.fixedPointToString(tx.outputs[0].capacity)} CKB`);
  }
  if (token) {
    await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt);
    await tx.completeInputsByUdt(owner, token);
    const extra = (await tx.getInputsUdtBalance(client, token)) - tx.getOutputsUdtBalance(token);
    if (extra > 0n) tx.addOutput({ lock: ownerLock, type: token }, tokenData(extra));
  }
  await tx.completeInputsByCapacity(owner);
  await tx.completeFeeBy(owner);
  let funded = binding;
  const txHash = await signAndSend(owner, tx, async (hash) => {
    funded = { ...binding, openTx: hash };
    await opts.beforeSend?.(funded);
  });
  return { txHash, binding: funded };
}

/**
 * Throws unless `type` is a plain xUDT (RFC 0052) on this network: the session
 * lock reads amounts as xUDT stores them, and an xUDT with any flag set in its
 * args either runs extension scripts the owner did not choose on every spend, or
 * widens who may mint (owner mode by input or output type, code review 14 Oct).
 */
export async function assertPlainXudt(type: ccc.Script, client: ccc.Client): Promise<void> {
  const xudt = await client.getKnownScript(ccc.KnownScript.XUdt);
  if (type.codeHash !== xudt.codeHash || type.hashType !== xudt.hashType) {
    throw new SessionPolicyError("a token session holds an xUDT token; this type script is not xUDT");
  }
  const args = ccc.bytesFrom(type.args);
  if (args.length < 32) throw new SessionPolicyError("xUDT args must start with the issuer's 32-byte lock hash");
  if (args.length >= 36 && ccc.numLeFromBytes(args.slice(32, 36)) !== 0n) {
    throw new SessionPolicyError("xUDT tokens with flags (extension scripts, other owner modes) are not supported in a session");
  }
}

/**
 * The session key pays `to`: `amount` shannons, or in a token session `token`
 * units of its xUDT. The scope is checked here first, then the network checks it
 * again in the session lock. No wallet is involved.
 *
 * `topUp: true` pays into an existing cell of `to` instead of creating one. `to`
 * must be an anyone-can-pay address with at least one live cell to add to (plain
 * for CKB, holding the session's token for `token`); that cell is consumed and
 * recreated holding more, which the anyone-can-pay lock allows without the
 * recipient's signature. A token paid without `topUp` goes in a new cell, whose
 * capacity (about 142 CKB) the session also pays and must fit in `maxPerTx`.
 *
 * In a token session, tokens always stay in the change: a CKB payment from a
 * cell holding tokens returns them, never burns them.
 *
 * `memo` is recorded in the witness of the session key's own input, which that
 * key's signature covers: the payment commits to it (see `verifyAccess`).
 */
export async function spendInSession(
  session: Session,
  client: ccc.Client,
  deployment: SessionLockDeployment,
  binding: OnChainBinding,
  request:
    | { to: string; amount: bigint; token?: undefined; topUp?: boolean; memo?: ccc.HexLike; beforeSend?: (txHash: ccc.Hex) => Promise<void> }
    | { to: string; token: bigint; amount?: undefined; topUp?: boolean; memo?: ccc.HexLike; beforeSend?: (txHash: ccc.Hex) => Promise<void> },
  now: Date = new Date(),
): Promise<ccc.Hex> {
  const tokenType = binding.token && ccc.Script.from(binding.token.type);
  const tokenOut = request.token ?? 0n;
  if (request.token !== undefined) {
    if (!binding.token || !tokenType) throw new ScopeError("this session holds no token");
    if (!isActive(session, now)) throw new ScopeError("session expired");
    if (tokenOut <= 0n) throw new ScopeError("token amount must be positive");
    if (tokenOut > binding.token.maxPerTx) {
      throw new ScopeError(`token amount exceeds the session's token maxPerTx (${binding.token.maxPerTx})`);
    }
    const { recipients } = session.policy.scope;
    if (recipients && !recipients.includes(request.to)) throw new ScopeError("recipient not in scope");
  } else {
    const check = checkRequest(session, { to: request.to, amount: request.amount }, now);
    if (!check.ok) throw new ScopeError(check.reason);
  }

  const state = await findSessionCells(session, client, deployment, binding);
  const { script: toLock } = await ccc.Address.fromString(request.to, client);
  if (binding.recipientLockHash && toLock.hash() !== binding.recipientLockHash) {
    throw new ScopeError("recipient not in scope");
  }
  if (!state.keyCells.length) throw new SessionBalanceError("no key cell left to pay fees");

  const since = binding.minInterval > 0n ? relativeBlocksSince(binding.minInterval) : 0n;
  const tx = ccc.Transaction.from({ cellDeps: [sessionLockCellDep(deployment)] });
  if (tokenType) await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt);

  // The payment: output 0, plus the recipient's cell when topping up.
  let ckbOut: bigint;
  if (request.topUp) {
    const acp = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
    if (toLock.codeHash !== acp.codeHash || toLock.hashType !== acp.hashType) {
      throw new ScopeError("top-up needs an anyone-can-pay recipient");
    }
    // Payers at once compete for a cell; a random pick spreads them out when the
    // recipient keeps several.
    const targets = (await collect(client, toLock, tokenType)).filter((c) =>
      request.token !== undefined ? !!c.cellOutput.type : !c.cellOutput.type,
    );
    const target = targets[Math.floor(Math.random() * targets.length)];
    if (!target) throw new SessionBalanceError("the recipient has no anyone-can-pay cell to top up");
    tx.inputs.push(ccc.CellInput.from({ previousOutput: target.outPoint }));
    ckbOut = request.amount ?? 0n;
    tx.addOutput(
      { lock: toLock, type: target.cellOutput.type, capacity: target.cellOutput.capacity + ckbOut },
      request.token !== undefined ? tokenData(tokenAmount(target.outputData) + tokenOut) : "0x",
    );
    await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.AnyoneCanPay);
  } else if (request.token !== undefined) {
    tx.addOutput({ lock: toLock, type: tokenType, capacity: 0n }, tokenData(tokenOut)); // CCC sizes it
    ckbOut = tx.outputs[0].capacity;
    if (ckbOut > session.policy.scope.maxPerTx) {
      throw new ScopeError(
        `a new token cell needs ${ccc.fixedPointToString(ckbOut)} CKB, over maxPerTx; pay with topUp instead`,
      );
    }
  } else {
    ckbOut = request.amount;
    tx.addOutput({ lock: toLock, capacity: ckbOut });
    if (tx.outputs[0].capacity !== ckbOut) {
      throw new SessionBalanceError(`a payment must be at least ${ccc.fixedPointToString(tx.outputs[0].capacity)} CKB`);
    }
  }

  // With a rate limit, only cells at least `minInterval` blocks old can be spent.
  // Anyone can create a cell under this lock; a fresh one picked here would make
  // the whole spend fail (code review, 14 Oct).
  const usable = binding.minInterval > 0n ? await matureCells(client, state.sessionCells, binding.minInterval) : state.sessionCells;
  if (state.sessionCells.length && !usable.length) {
    throw new SessionBalanceError(`rate limited: no session cell is ${binding.minInterval} blocks old yet`);
  }

  // Take session cells until they cover both the shannons and the tokens.
  const taken: ccc.Cell[] = [];
  let ckbIn = 0n;
  let tokenIn = 0n;
  for (const cell of usable) {
    if (ckbIn >= ckbOut && tokenIn >= tokenOut) break;
    if (ckbIn >= ckbOut && !cell.cellOutput.type) continue; // only tokens still needed
    taken.push(cell);
    ckbIn += cell.cellOutput.capacity;
    if (cell.cellOutput.type) tokenIn += tokenAmount(cell.outputData);
  }
  if (ckbIn < ckbOut) {
    throw new SessionBalanceError(`session balance ${ccc.fixedPointToString(state.balance)} CKB is too low`);
  }
  if (tokenIn < tokenOut) throw new SessionBalanceError(`session token balance ${state.tokenBalance} is too low`);
  tx.inputs.unshift(...taken.map((c) => ccc.CellInput.from({ previousOutput: c.outPoint, since })));

  // One change cell (the lock allows no more); it keeps every token that came in and did not leave.
  const change = ckbIn - ckbOut;
  const keepsTokens = taken.some((c) => c.cellOutput.type);
  if (keepsTokens || change > 0n) {
    tx.addOutput(
      { lock: state.lock, capacity: change, ...(keepsTokens && { type: tokenType }) },
      keepsTokens ? tokenData(tokenIn - tokenOut) : "0x",
    );
    const needed = tx.outputs[tx.outputs.length - 1].capacity;
    if (needed !== change) {
      throw new SessionBalanceError(
        `the session would keep ${ccc.fixedPointToString(change)} CKB, below the ` +
          `${ccc.fixedPointToString(needed)} CKB a session cell needs; ` +
          (keepsTokens ? "it still holds tokens, so spend less CKB" : "spend all of it or less"),
      );
    }
  }
  // The key cell authorises the spend, comes back as the last output and pays the fee.
  tx.inputs.push(ccc.CellInput.from({ previousOutput: state.keyCells[0].outPoint }));
  if (request.memo !== undefined) tx.setWitnessArgsAt(tx.inputs.length - 1, { inputType: request.memo });
  tx.addOutput({ lock: state.keyLock, capacity: 0n });
  await tx.completeFeeChangeToOutput(sessionSigner(session, client), tx.outputs.length - 1);
  // Below this, the key cell could no longer go back to the owner at the end.
  if (tx.outputs[tx.outputs.length - 1].capacity < keyCellFloor(binding.ownerLock)) {
    throw new SessionBalanceError("the key cell cannot cover another fee; top it up");
  }
  return signAndSend(sessionSigner(session, client), tx, request.beforeSend);
}

/** The cells created at least `blocks` blocks before the tip: those a relative `since` of `blocks` can spend. */
export async function matureCells(client: ccc.Client, cells: ccc.Cell[], blocks: bigint): Promise<ccc.Cell[]> {
  const tip = await client.getTip();
  const born = await Promise.all(cells.map(async (c) => (await client.getTransaction(c.outPoint.txHash))?.blockNumber));
  return cells.filter((_, i) => {
    const b = born[i];
    return b !== undefined && b !== null && tip - ccc.numFrom(b) >= blocks;
  });
}

/**
 * Ends the session: the owner sweeps the session cells (one wallet signature),
 * then the key cell returns to the owner (session key signs, no wallet).
 *
 * The sweep goes first because it is what matters: a key cell too small to pay
 * for the owner's lock (some wallets' locks need more than 61 CKB) must not block
 * it. A key-cell failure is reported in `keyError`; the key stays usable for a retry.
 *
 * `nothingFound` means no cell is left under the session or the key: the key can
 * be forgotten. If the funding transaction (`binding.openTx`) is still in flight
 * or not yet indexed, this throws instead, so the key is never forgotten before
 * the funds it controls arrive.
 */
export async function closeSession(
  owner: ccc.Signer,
  session: Session,
  deployment: SessionLockDeployment,
  binding: OnChainBinding,
): Promise<{ keyTx?: ccc.Hex; sweepTx?: ccc.Hex; keyError?: string; nothingFound?: true }> {
  const client = owner.client;
  const ownerLock = ccc.Script.from(binding.ownerLock);
  const state = await findSessionCells(session, client, deployment, binding);
  const result: { keyTx?: ccc.Hex; sweepTx?: ccc.Hex; keyError?: string; nothingFound?: true } = {};

  if (!state.sessionCells.length && !state.keyCells.length) {
    const open = binding.openTx && (await client.getTransaction(binding.openTx));
    if (open && ["pending", "proposed", "committed"].includes(open.status)) {
      throw new SessionBalanceError(
        `the session's funding transaction is ${open.status === "committed" ? "not indexed yet" : open.status}; close again in a minute`,
      );
    }
    return { nothingFound: true };
  }

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
 * on the args finds them all. Only well-formed args (80 or 112 bytes; 128 or 160
 * for a token session) are kept: a cell with malformed args would fail the lock
 * even in owner mode, and anyone can create one with this owner's hash as a prefix
 * to block a sweep. Likewise a typed cell is kept only if it holds the session's
 * own token in well-formed data; anything else could make the sweep fail. Cells
 * whose tokens would overflow a u128 together are left out (`withinU128`).
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
      if (sweepable(cell)) cells.push(cell);
    }
  }
  return withinU128(owner.client, cells);
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

/** A session cell an owner sweep can safely include. */
function sweepable(cell: ccc.Cell): boolean {
  const args = ccc.bytesFrom(cell.cellOutput.lock.args);
  const type = cell.cellOutput.type;
  if (args.length === 80 || args.length === 112) return !type;
  if (args.length !== 128 && args.length !== 160) return false;
  if (!type) return true;
  return type.hash() === ccc.hexFrom(args.slice(80, 112)) && ccc.bytesFrom(cell.outputData).length >= 16;
}

/**
 * Spends `cells` in owner mode: everything returns to the owner. Tokens go back
 * in one cell per token type (xUDT would let a sweep burn them otherwise).
 */
export async function ownerSweep(
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
  const ownerLock = (await owner.getRecommendedAddressObj()).script;
  const tokens = new Map<string, { type: ccc.Script; amount: bigint }>();
  for (const c of cells) {
    const type = c.cellOutput.type;
    if (!type) continue;
    const held = tokens.get(type.hash()) ?? { type, amount: 0n };
    held.amount += tokenAmount(c.outputData);
    tokens.set(type.hash(), held);
  }
  for (const { type, amount } of tokens.values()) tx.addOutput({ lock: ownerLock, type }, tokenData(amount));
  if (tokens.size) await tx.addCellDepsOfKnownScripts(owner.client, ccc.KnownScript.XUdt);
  // Owner mode needs an owner-locked input in the transaction.
  for await (const cell of owner.findCells({ scriptLenRange: [0, 1], outputDataLenRange: [0, 1] }, true)) {
    tx.inputs.push(ccc.CellInput.from({ previousOutput: cell.outPoint }));
    await tx.completeFeeBy(owner);
    return owner.sendTransaction(tx);
  }
  throw new SessionBalanceError("the owner needs one plain cell to prove ownership");
}
