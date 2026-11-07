import { ccc } from "@ckb-ccc/core";
import {
  relativeBlocksSince,
  sessionLockCellDep,
  sessionLockScript,
  type SessionLockDeployment,
  type SessionLockParams,
} from "./lock.js";
import { assertCurrentDeployment } from "./deployment.js";
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

/**
 * Why a `SessionBalanceError` was thrown, where a caller may need to tell it apart
 * without matching the message (which may change):
 * - `no-fee-cell`: the paying key (a session's key cell, a subscription's charger)
 *   has no cell that can pay the fee.
 * - `no-payout-cell`: the recipient (`payTo`) has no cell to top up.
 * - `payout-busy`: every payout cell checked is being spent by a transaction in
 *   the node's pool (other payers at the same moment). Nothing was sent; try
 *   again after a block, or give the recipient more cells (`createPayoutCells`).
 *
 * Neither is about the session's or the subscription's own balance or timing: the
 * missing cells belong to the key's holder or the recipient (in a subscription,
 * both are the creator's). Other balance errors have no `reason`.
 */
export type SessionBalanceReason = "no-fee-cell" | "no-payout-cell" | "payout-busy";

export class SessionBalanceError extends Error {
  readonly reason?: SessionBalanceReason;
  constructor(message: string, reason?: SessionBalanceReason) {
    super(message);
    this.name = "SessionBalanceError";
    if (reason) this.reason = reason;
  }
}

/**
 * Something about a session's terms that the lock will enforce as written but that
 * the owner may not have meant. `openSession` reports it before anything is signed
 * (`opts.onWarning`, or `console.warn` without one).
 * - `no-rate-limit`: `minInterval` is 0 (or 1, almost the same: review W6 I3). Each
 *   spend is held to `maxPerTx`, but the change of one spend can be spent again in
 *   the next block (with 1, a block later), so a leaked key can repeat spends until the
 *   session is empty.
 * - `owner-lock-build-unreviewed`: the owner's lock is Omnilock, JoyID or the
 *   Nostr lock under its type id, and its live code cell is not a build listed
 *   in `REVIEWED_OWNER_LOCK_BUILDS` (`dataHash` is what it runs now). The
 *   deployer may have upgraded it; the opening is not refused.
 * - `owner-lock-build-unresolved`: the same locks, but the code cell could not be
 *   read, so the build was not checked.
 */
export interface SessionWarning {
  code: "no-rate-limit" | "owner-lock-build-unreviewed" | "owner-lock-build-unresolved";
  message: string;
  /** With `"owner-lock-build-unreviewed"`: the data hash of the owner lock's live code cell. */
  dataHash?: ccc.Hex;
}

/** The warnings for a session opened with these terms. */
function sessionWarnings(minInterval: bigint, recipient: boolean): SessionWarning[] {
  if (minInterval > 1n) return [];
  return [
    {
      code: "no-rate-limit",
      message:
        (minInterval === 0n
          ? "minInterval is 0: no rate limit. Each spend is held to maxPerTx, but spends can repeat every block "
          : "minInterval is 1: almost no rate limit. Each spend is held to maxPerTx, but spends can repeat one block apart ") +
        "until the session is empty, so a leaked key can drain the whole budget" +
        (recipient ? " (with a recipient too: the fee is not an output, so up to maxPerTx can go to the miner each time)" : "") +
        ". Set minInterval to limit how often the key can spend.",
    },
  ];
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
 * A send failed and the node could not then be asked whether it has the
 * transaction (review W6 L4): it may have been taken and committed. Never
 * retried; `txHash` is the transaction to look for, and `cause` the send's own
 * error. Its message never repeats the cause's, so nothing reads it as a
 * refusal for a spent input.
 */
export class SendOutcomeUnknownError extends Error {
  readonly txHash: ccc.Hex;
  constructor(txHash: ccc.Hex, cause: unknown) {
    super(`the send of ${txHash} failed and its status could not be looked up: it may still commit; check it before paying again`, { cause });
    this.name = "SendOutcomeUnknownError";
    this.txHash = txHash;
  }
}

/**
 * Signs `tx`, hands its final hash to `beforeSend`, then sends it. The hash is
 * known before anything leaves, so a caller can record the payment or the key
 * against it first. If the send throws but the node did take the transaction (a
 * timeout on the reply, say), the hash is returned all the same. If the send
 * throws and the status lookup fails too, a `SendOutcomeUnknownError` is thrown
 * instead of the send's error, which `rebuildOnDeadInputs` never retries.
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
    let known: Awaited<ReturnType<ccc.Client["getTransaction"]>>;
    try {
      known = await signer.client.getTransaction(hash);
    } catch {
      // A lost reply, then a fallback node answering Dead because this one committed: not a refusal.
      throw new SendOutcomeUnknownError(hash, e);
    }
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
export async function ownOrigin(client: ccc.Client, cell: ccc.Cell): Promise<boolean> {
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

/** One of `cells` at random: payers or chargers at once then rarely compete for the same cell. */
export const randomPick = <T>(cells: T[]): T | undefined => cells[Math.floor(Math.random() * cells.length)];

/** Whether `lock` is this network's anyone-can-pay lock (RFC 0026). */
export async function isAnyoneCanPay(lock: ccc.Script, client: ccc.Client): Promise<boolean> {
  const acp = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
  return lock.codeHash === acp.codeHash && lock.hashType === acp.hashType;
}

/** The most cells of a recipient read when picking one to top up: any of them will do. */
export const MAX_PAYOUT_CELLS = 64;
/** The most payout cells a pick asks the node about (`get_live_cell` with the pool), all at once. */
export const MAX_POOL_CHECKS = 4;

const outPointKey = (op: ccc.OutPointLike) => ccc.hexFrom(ccc.OutPoint.from(op).toBytes());

/** The out points CCC's client cache lists as live under `lock`: outputs of transactions this client sent. */
async function cachedOutPoints(client: ccc.Client, lock: ccc.Script): Promise<Set<string>> {
  const cached = new Set<string>();
  if (!client.cache) return cached;
  for await (const c of client.cache.findCells({ script: lock, scriptType: "lock", scriptSearchMode: "exact", withData: true })) {
    cached.add(outPointKey(c.outPoint));
  }
  return cached;
}

function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const payoutBusy = () =>
  new SessionBalanceError(
    "every payout cell is being spent by another payment in the node's pool: try again after a block, " +
      "or give the recipient more cells (createPayoutCells)",
    "payout-busy",
  );

/**
 * Which of `cells` (the recipient's anyone-can-pay cells) to top up, so payers at
 * the same moment rarely take the same one (mentor review, 2 Nov):
 *
 * - confirmed cells first (listed by the indexer), then this client's own
 *   outputs still pending (only CCC's cache lists them), each group shuffled;
 * - `avoid` (out points a node rejection named as spent) left out;
 * - the first `MAX_POOL_CHECKS` asked at once whether a transaction in the
 *   node's pool spends them (`get_live_cell` with `include_tx_pool`: a cell a
 *   pool transaction consumes is dead); the first free one is taken.
 *
 * If the node cannot be asked, an unchecked cell is taken (a rejected send is
 * retried). If every cell checked is spent in the pool, an unchecked one is taken
 * if any is left; otherwise a `SessionBalanceError` "payout-busy" is thrown and
 * nothing is sent. Undefined when `cells` is empty.
 */
export async function pickPayoutCell(
  client: ccc.Client,
  lock: ccc.Script,
  cells: ccc.Cell[],
  avoid: ReadonlySet<string> = new Set(),
): Promise<ccc.Cell | undefined> {
  if (!cells.length) return undefined;
  const usable = cells.filter((c) => !avoid.has(outPointKey(c.outPoint)));
  if (!usable.length) throw payoutBusy();
  const cached = await cachedOutPoints(client, lock);
  const isCached = (c: ccc.Cell) => cached.has(outPointKey(c.outPoint));
  const order = [...shuffled(usable.filter((c) => !isCached(c))), ...shuffled(usable.filter(isCached))];
  const checked = order.slice(0, MAX_POOL_CHECKS);
  const states = await Promise.all(
    checked.map(async (c): Promise<"free" | "taken" | "unknown"> => {
      try {
        return (await client.getCellLive(c.outPoint, false, true)) ? "free" : "taken";
      } catch {
        return "unknown"; // the node cannot be asked
      }
    }),
  );
  const first = (state: "free" | "unknown") => checked[states.indexOf(state)];
  const picked = first("free") ?? first("unknown") ?? randomPick(order.slice(MAX_POOL_CHECKS));
  if (!picked) throw payoutBusy();
  return picked;
}

/**
 * Plain cells under the recipient's `lock` (with `token`, cells holding exactly
 * that token), at most `MAX_PAYOUT_CELLS` of them from the first
 * `4 * MAX_PAYOUT_CELLS` listed: anyone can create cells under any lock. The
 * indexer lists only cells of that kind (no type and no data; or exactly the
 * token, with a 16-byte amount), so cells of any other kind planted under an
 * anyone-can-pay `lock` never push the real ones out of reach (review W6 L5).
 */
async function payoutCells(client: ccc.Client, lock: ccc.Script, token?: ccc.Script): Promise<ccc.Cell[]> {
  const cells: ccc.Cell[] = [];
  let seen = 0;
  const filter: ccc.ClientIndexerSearchKeyFilterLike = token
    ? { script: token, scriptLenRange: [token.occupiedSize, token.occupiedSize + 1], outputDataLenRange: [16, 17] }
    : { scriptLenRange: [0, 1], outputDataLenRange: [0, 1] };
  for await (const cell of client.findCells({ script: lock, scriptType: "lock", scriptSearchMode: "exact", filter, withData: true })) {
    if (++seen > 4 * MAX_PAYOUT_CELLS || cells.length >= MAX_PAYOUT_CELLS) break;
    if (token ? plainTokenCell(cell, token) : !cell.cellOutput.type && cell.outputData === "0x") cells.push(cell);
  }
  return withoutDeadCached(client, lock, cells);
}

/**
 * Tops up one cell under the anyone-can-pay `lock` in `tx`: one input, and one
 * output holding `ckb` shannons more, or with `token`, `units` more of it in a
 * cell of that token. The cell is chosen by `pickPayoutCell`, never one in
 * `avoid`. Returns the cell, or undefined when `lock` has none to add to.
 */
export async function addTopUp(
  tx: ccc.Transaction,
  client: ccc.Client,
  lock: ccc.Script,
  add: { ckb?: bigint; token?: ccc.Script; units?: bigint },
  avoid?: ReadonlySet<string>,
): Promise<ccc.Cell | undefined> {
  const { token } = add;
  const cells = await payoutCells(client, lock, token);
  // A cell the payment would take past a u128 of tokens cannot be topped up (xUDT refuses it).
  const room = token ? cells.filter((c) => tokenAmount(c.outputData) + (add.units ?? 0n) <= U128_MAX) : cells;
  if (cells.length && !room.length) {
    throw new SessionBalanceError(
      "every token cell of the recipient would hold over 2^128 - 1 units after this payment", "no-payout-cell",
    );
  }
  const target = await pickPayoutCell(client, lock, room, avoid);
  if (!target) return undefined;
  tx.inputs.push(ccc.CellInput.from({ previousOutput: target.outPoint }));
  tx.addOutput(
    { lock, type: target.cellOutput.type, capacity: target.cellOutput.capacity + (add.ckb ?? 0n) },
    token ? tokenData(tokenAmount(target.outputData) + (add.units ?? 0n)) : "0x",
  );
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.AnyoneCanPay, ...(token ? [ccc.KnownScript.XUdt] : []));
  return target;
}

/** Plain cells under `lock`; with `token`, also cells holding exactly that token. */
export async function collect(client: ccc.Client, lock: ccc.Script, token?: ccc.Script): Promise<ccc.Cell[]> {
  const cells: ccc.Cell[] = [];
  for await (const cell of client.findCellsByLock(lock, null, true)) {
    if ((!cell.cellOutput.type && cell.outputData === "0x") || (token && plainTokenCell(cell, token))) cells.push(cell);
  }
  return withoutDeadCached(client, lock, cells);
}

/**
 * `cells` (found under `lock`) less those only CCC's client cache vouches for
 * that are gone. The cache lists the outputs of every transaction this client
 * sent as live, ahead of the indexer's cells, and never drops them: once another
 * tab, device or server instance spends them, every transaction built here on
 * them would be rejected until a reload (audit, 31 Oct). A cached cell is kept
 * while the transaction that made it is pending or proposed (a chain of
 * payments faster than the indexer needs it), or once committed while the node
 * says it is still live; it is dropped once the node no longer knows that
 * transaction, or says the cell is spent. When the node cannot be asked, it is kept.
 */
export async function withoutDeadCached(client: ccc.Client, lock: ccc.Script, cells: ccc.Cell[]): Promise<ccc.Cell[]> {
  if (!cells.length || !client.cache) return cells;
  const cached = await cachedOutPoints(client, lock);
  if (!cached.size) return cells;
  const keep = await Promise.all(
    cells.map(async (c) => {
      if (!cached.has(ccc.hexFrom(c.outPoint.toBytes()))) return true;
      try {
        const status = (await client.getTransactionNoCache(c.outPoint.txHash))?.status;
        if (status === "pending" || status === "proposed") return true;
        if (status !== "committed") return false;
        return !!(await client.getCellLive(c.outPoint, false, false));
      } catch {
        return true; // the node cannot be asked: a dead one is rejected, then rebuilt (rebuildOnDeadInputs)
      }
    }),
  );
  return cells.filter((_, i) => keep[i]);
}

/** Whether a send was rejected because an input is spent or unknown to the node. */
export function deadInputs(e: unknown): boolean {
  if (e instanceof SendOutcomeUnknownError) return false;
  if (e instanceof ccc.ErrorClientResolveUnknown) return true;
  const text = e instanceof ccc.ErrorClientBase ? `${e.message} ${e.data}` : e instanceof Error ? e.message : String(e);
  return /\b(Dead|Unknown)\(OutPoint\(/.test(text);
}

const errorText = (e: unknown) =>
  e instanceof ccc.ErrorClientBase ? `${e.message} ${e.data}` : e instanceof Error ? e.message : String(e);

/**
 * Whether a send was rejected because an input is already spent by a
 * transaction in the node's pool, on a node with replace-by-fee on: CKB then
 * runs its RBF checks instead of answering `Dead`, and refuses the newcomer
 * (`PoolRejectedRBF`, -1111) unless it pays enough more to replace the other.
 */
export function poolConflict(e: unknown): boolean {
  if (e instanceof SendOutcomeUnknownError) return false;
  if (e instanceof ccc.ErrorClientRBFRejected) return true;
  if (e instanceof ccc.ErrorClientBase && e.code === -1111) return true;
  return /\b(RBFRejected|PoolRejectedRBF)\b/.test(errorText(e));
}

/** The out point a `Dead` or `Unknown` rejection names (as `outPointKey`), if any. */
function rejectedOutPoint(e: unknown): string | undefined {
  if (e instanceof ccc.ErrorClientResolveUnknown) return outPointKey(e.outPoint);
  const hex = /\b(?:Dead|Unknown)\(OutPoint\((0x[0-9a-fA-F]+)\)/.exec(errorText(e))?.[1];
  if (!hex) return undefined;
  try {
    return outPointKey(ccc.OutPoint.fromBytes(hex));
  } catch {
    return undefined;
  }
}

/** How often, and how patiently, a payment or a charge is built again after a refusal for a spent cell. */
export interface RetryOptions {
  /** Attempts in all, the first included (default 3; 1 never retries). */
  attempts?: number;
  /** The wait before the second attempt, in ms (default 1000); it doubles each time, with jitter of +-50%. */
  delayMs?: number;
}

export const DEFAULT_RETRY: Readonly<Required<RetryOptions>> = { attempts: 3, delayMs: 1000 };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `build` (which builds and sends a transaction). If the node definitely
 * refused it because an input was already spent (`Dead`, `Unknown`, or an RBF
 * refusal for a conflict in its pool), or `build` sent nothing because every
 * payout cell was busy ("payout-busy"), clears the client's cache, waits, and
 * runs it again, up to `retry.attempts` in all (audit, 31 Oct; mentor review,
 * 2 Nov). `build` is given the out points rejections named, so a payout cell
 * the node called spent is not picked again. The wait is `retry.delayMs`,
 * doubling each time, times a random 0.5 to 1.5, so payers that collided do
 * not retry in step.
 *
 * Any other error is thrown at once. That includes a send whose outcome is
 * unknown (a timeout, a lost reply): `signAndSend` returns the hash when the
 * node did take the transaction, and otherwise throws the send's own error,
 * which is never retried, so nothing is ever paid twice. When the node cannot
 * be asked either, a refusal for a spent input may only mean the first send
 * committed (CCC retries a send on a fallback node): `signAndSend` then throws
 * `SendOutcomeUnknownError`, never retried (review W6 L4). A `beforeSend` inside
 * runs again with each new transaction's hash: a refused one never commits.
 */
export async function rebuildOnDeadInputs<T>(
  client: ccc.Client,
  build: (avoid: ReadonlySet<string>) => Promise<T>,
  retry: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(retry.attempts ?? DEFAULT_RETRY.attempts));
  const delay = Math.max(0, retry.delayMs ?? DEFAULT_RETRY.delayMs);
  const avoid = new Set<string>();
  for (let attempt = 1; ; attempt++) {
    try {
      return await build(avoid);
    } catch (e) {
      const busy = e instanceof SessionBalanceError && e.reason === "payout-busy";
      if (!(busy || deadInputs(e) || poolConflict(e)) || attempt >= attempts) throw e;
      const named = rejectedOutPoint(e);
      if (named) avoid.add(named);
      await client.cache?.clear();
      const wait = delay * 2 ** (attempt - 1) * (0.5 + Math.random());
      if (wait > 0) await sleep(wait);
    }
  }
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

/** Options for {@link assertSigningLock}. */
export type SigningLockOptions = {
  /**
   * Let a lock this kit has not reviewed own a session, with a `console.warn`.
   * Use it only after checking yourself that the lock cannot be unlocked without
   * the owner's signature. A lock known to unlock without it is refused anyway
   * (the deployed anyone-can-pay, PW-Lock and always-success code, under any
   * hash_type; see `assertSigningLock`).
   */
  allowUnreviewedOwnerLock?: boolean;
};

/**
 * Locks that open without any signature, on mainnet and testnet, refused
 * whatever the client's network: anyone-can-pay (RFC 0026, and the older
 * deployments pw-core lists as anyone-can-pay), PW-Lock (the deployed build is
 * lay2dev/pw-lock's `secp256k1_keccak256_sighash_all_acpl`: with no signature in
 * the witness it takes the anyone-can-pay path, whatever its args) and
 * always-success (ckb-proxy-locks).
 *
 * `type`: the type-id code hash the script is deployed under (hash_type `type`).
 * `data`: the hash of the binary itself, refused under every data hash_type
 * (`data`, `data1`, `data2`): the same code referenced by its data hash opens
 * the same way (review W6 L6). The data hashes are those of the code cells CCC
 * lists for each script on testnet and mainnet, read on 2 Nov 2026.
 */
const SIGNATURE_FREE: { codeHash: string; by: "type" | "data"; what: string }[] = [
  { codeHash: "0xd369597ff47f29fbc0d47d2e3775370d1250b85140c670e4718af712983a2354", by: "type", what: "anyone-can-pay" },
  { codeHash: "0x3419a1c09eb2567f6552ee7a8ecffd64155cffe0f1796e6e61ec088d740c1356", by: "type", what: "anyone-can-pay" },
  { codeHash: "0xcd69ba816f7471e59110058aa37387c362ed9a240cd178f7bb1ecee386cb31e6", by: "data", what: "anyone-can-pay" },
  { codeHash: "0x0fb343953ee78c9986b091defb6252154e0bb51044fd2879fde5b27314506111", by: "data", what: "anyone-can-pay" },
  { codeHash: "0x86a1c6987a4acbe1a887cca4c9dd2ac9fcb07405bbeda51b861b18bbf7492c4b", by: "type", what: "anyone-can-pay" },
  { codeHash: "0xbf43c3602455798c1a61a596e0d95278864c552fafe231c063b3fabf97a8febc", by: "type", what: "PW-Lock" },
  { codeHash: "0x58c5f491aba6d61678b7cf7edf4910b1f5e00ec0cde2f42e0abb4fd9aff25a63", by: "type", what: "PW-Lock" },
  { codeHash: "0xd6a5a0edb152e88e8bbc702e164441cb3890fae35da672b408d28ca9a1bde3ee", by: "data", what: "PW-Lock" },
  { codeHash: "0xeffe377419256d150d68368d7cb5731edad39d1805a8c2c73ce8e9615b9f9878", by: "data", what: "PW-Lock" },
  { codeHash: "0x3b521cc4b552f109d092d8cc468a8048acb53c5952dbe769d2b2f9cf6e47f7f1", by: "data", what: "always-success" },
];

/** The signature-free lock `lock` runs, if it is one of `SIGNATURE_FREE` under a matching hash_type. */
const signatureFree = (lock: ccc.Script) =>
  SIGNATURE_FREE.find((s) => s.codeHash === lock.codeHash && (s.by === "type" ? lock.hashType === "type" : lock.hashType !== "type"));

/** Omnilock auth flags that verify a signature over the whole transaction (RFC 0042, nervosnetwork/omnilock). */
const OMNI_SIGNING_AUTH = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x12]);
/** Omnilock modes that only add checks: time-lock (0x04) and supply (0x08). */
const OMNI_ADDITIVE_MODES = 0x04 | 0x08;

/**
 * Throws `SessionPolicyError` unless `lock` is a reviewed configuration of a lock
 * that needs the owner's signature over the whole transaction. The session lock
 * grants owner mode to any transaction with an input under the owner's lock, so
 * that lock is the only thing standing between a stranger and every session.
 * An allowlist, not a blocklist (code review, 14 Oct; mentor review, 2 Nov):
 *
 * Reviewed, accepted:
 * - secp256k1-blake160 (20-byte args); secp256k1 multisig, v1 and v2 (20 bytes,
 *   or 28 with a since, which only delays);
 * - Omnilock with a signature auth flag (0x00-0x06: CKB, Ethereum, EOS, Tron,
 *   Bitcoin, Dogecoin, multisig; 0x12: Ethereum with the message displayed), and
 *   no mode other than time-lock or supply;
 * - Nostr lock in signing mode (args[0] = 0, 21-byte args);
 * - JoyID (closed source: reviewed from its documentation only).
 *
 * Known to unlock without the owner's signature, refused always (reason
 * `"owner-lock-unsafe"`): anyone-can-pay, PW-Lock, always-success (by their
 * type id, or by the data hash of their deployed binaries under any data
 * hash_type), Omnilock in anyone-can-pay or administrator mode, Nostr lock in
 * PoW mode (args[0] != 0). Another build of those locks (a binary with a
 * different data hash) is not recognised: it is refused as unreviewed.
 *
 * Anything else (Omnilock auth 0xFC-0xFE, which hand the decision to another lock
 * or to other code; the proxy locks; unknown locks; args the lock's code would
 * not accept) is refused with reason `"owner-lock-unreviewed"`, unless
 * `allowUnreviewedOwnerLock` is set: then it passes with a warning.
 *
 * The owner must also never sign a partial (open) transaction with this lock.
 */
export async function assertSigningLock(
  lock: ccc.Script,
  client: ccc.Client,
  opts: SigningLockOptions = {},
): Promise<void> {
  return checkSigningLock(lock, client, !!opts.allowUnreviewedOwnerLock, OWNER_ROLE);
}

/** Whose lock `checkSigningLock` checks, for its messages, and the opt-in that lets an unreviewed one through. */
export type SigningRole = { whose: string; can: string; optIn: string };
const OWNER_ROLE: SigningRole = { whose: "the owner's lock", can: "own a session", optIn: "allowUnreviewedOwnerLock" };

/** `assertSigningLock` for any role: a subscription's charger lock is checked the same way (review M2), with its own opt-in. */
export async function checkSigningLock(lock: ccc.Script, client: ccc.Client, allowUnreviewed: boolean, role: SigningRole): Promise<void> {
  const unsafe = (why: string) => {
    throw new SessionPolicyError(`${role.whose} ${why}: it cannot ${role.can}`, "owner-lock-unsafe");
  };
  const unreviewed = (why: string) => {
    const message = `${role.whose} ${why}`;
    if (allowUnreviewed) {
      console.warn(`ckb-session-kit: ${message}; allowed by ${role.optIn}`);
      return;
    }
    throw new SessionPolicyError(
      `${message}, so it cannot ${role.can} unless you review it and pass ${role.optIn}`,
      "owner-lock-unreviewed",
    );
  };
  const is = async (known: ccc.KnownScript) => {
    try {
      const s = await client.getKnownScript(known);
      return s.codeHash === lock.codeHash && s.hashType === lock.hashType;
    } catch {
      return false; // not deployed on this network
    }
  };
  const args = ccc.bytesFrom(lock.args);

  const free = signatureFree(lock);
  if (free?.what === "PW-Lock" || (await is(ccc.KnownScript.PWLock))) {
    return unsafe("is PW-Lock, whose deployed build is anyone-can-pay: it opens with no signature");
  }
  if (free || (await is(ccc.KnownScript.AnyoneCanPay))) {
    return unsafe(`is ${free?.what ?? "anyone-can-pay"}: it opens with no signature`);
  }
  if (await is(ccc.KnownScript.AlwaysSuccess)) return unsafe("is always-success: it opens with no signature");

  if (await is(ccc.KnownScript.OmniLock)) {
    // Omnilock args: auth flag (1) + auth content (20) + Omnilock flags (1) + mode args.
    if (args.length < 22) return unreviewed("is an Omnilock with args its code would not accept");
    const auth = args[0];
    const modes = args[21];
    if (modes & 0x02) return unsafe("is an Omnilock in anyone-can-pay mode, which opens with no signature");
    if (modes & 0x01) return unsafe("is an Omnilock with an administrator, who could unlock it without the owner");
    if (auth >= 0xfc && auth <= 0xfe) {
      const flag = auth.toString(16);
      return unreviewed(`is an Omnilock that does not verify a signature itself (auth 0x${flag} hands the check to another lock or code)`);
    }
    if (!OMNI_SIGNING_AUTH.has(auth)) {
      return unreviewed(`is an Omnilock with auth flag 0x${auth.toString(16).padStart(2, "0")}, which is not one this kit has reviewed`);
    }
    if (modes & ~OMNI_ADDITIVE_MODES) {
      return unreviewed(`is an Omnilock with mode flags 0x${modes.toString(16).padStart(2, "0")}, not one this kit has reviewed`);
    }
    return;
  }

  if (await is(ccc.KnownScript.NostrLock)) {
    // Nostr lock args: PoW difficulty (1) + blake160 of the Schnorr public key (20).
    if (args.length !== 21) return unreviewed("is a Nostr lock with args its code would not accept");
    if (args[0] !== 0) return unsafe("is a Nostr lock in proof of work mode, which anyone who does the work can unlock");
    return;
  }

  if (await is(ccc.KnownScript.Secp256k1Blake160)) {
    return args.length === 20 ? undefined : unreviewed("is secp256k1-blake160 with args its code would not accept");
  }
  if ((await is(ccc.KnownScript.Secp256k1Multisig)) || (await is(ccc.KnownScript.Secp256k1MultisigV2))) {
    return args.length === 20 || args.length === 28 ? undefined : unreviewed("is a multisig with args its code would not accept");
  }
  if (await is(ccc.KnownScript.JoyId)) return;

  return unreviewed("is not one this kit has reviewed: it may open without the owner's signature");
}

/** A build of a type-id owner lock: the data hash (ckb blake2b) of its code cell. */
export type OwnerLockBuild = {
  lock: "Omnilock" | "JoyID" | "Nostr lock";
  network: "mainnet" | "testnet";
  /** The type-id code hash owner locks reference (hash_type `type`). */
  codeHash: ccc.Hex;
  /** `ccc.hashCkb` of the code cell's data. */
  dataHash: ccc.Hex;
  /** What was checked, and when. */
  review: string;
};

/**
 * The builds of the type-id owner locks this kit has looked at. An owner lock
 * hash binds the type id, not the binary, so the deployer can replace the code
 * under every lock at once. `openSession` and `openSubscription` read the live
 * code cell and warn (`"owner-lock-build-unreviewed"`) when its data hash is not
 * listed here; they do not refuse. Data hashes read from the live code cells
 * (resolved by type id, as CCC resolves them) on 7 Nov 2026.
 */
export const REVIEWED_OWNER_LOCK_BUILDS: readonly OwnerLockBuild[] = Object.freeze([
  {
    lock: "Omnilock",
    network: "mainnet",
    codeHash: "0x9b819793a64463aed77c615d6cb226eea5487ccfc0783043a587254cda2b6f26",
    dataHash: "0x768f306681da232ceb0b94f436c5f813377179762a831c5ad8797bd4fd2d118d",
    review: "source: nervosnetwork/omnilock cd764d7, whose tests pin this hash; reviewed 5 Nov 2026",
  },
  {
    lock: "JoyID",
    network: "mainnet",
    codeHash: "0xd00c84f0ec8fd441c38bc3f87a371f547190f2fcff88e642bc5bf54b9e318323",
    dataHash: "0x4af7d832e7c328aa4ad6f2deb669743446aea7b9a2f0c25646897501ac4f1ebe",
    review: "closed source: documentation and a string scan of this binary only; reviewed 5 Nov 2026",
  },
  {
    lock: "Nostr lock",
    network: "mainnet",
    codeHash: "0x641a89ad2f77721b803cd50d01351c1f308444072d5fa20088567196c0574c68",
    dataHash: "0x2effea19ff3024b5b0fb4c0c59c379e7610110e7e3fe7ae003247b1115e59795",
    review: "source: cryptape/nostr-binding eef134e (strings consistent, not rebuilt); reviewed 5 Nov 2026",
  },
  {
    lock: "Omnilock",
    network: "testnet",
    codeHash: "0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb",
    dataHash: "0x6b29b6f10346b43c540e53806ba88ba0fe3a0c3a29d7448ef555840c8f8318fa",
    review: "the build live on testnet when read on 7 Nov 2026; its source is not identified (testnet funds only)",
  },
  {
    lock: "JoyID",
    network: "testnet",
    codeHash: "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac",
    dataHash: "0xd2c0f2f621a337007e046f0ed65f8fe29112c32a00ea1e43c2f8059fd42ca6d7",
    review: "the build live on testnet when read on 7 Nov 2026, a different binary from mainnet; not examined, documentation review only",
  },
  {
    lock: "Nostr lock",
    network: "testnet",
    codeHash: "0x6ae5ee0cb887b2df5a9a18137315b9bdc55be8d52637b2de0624092d5f0c91d5",
    dataHash: "0x2effea19ff3024b5b0fb4c0c59c379e7610110e7e3fe7ae003247b1115e59795",
    review: "the same binary as the mainnet Nostr lock",
  },
]);

const BUILD_PINNED: [ccc.KnownScript, OwnerLockBuild["lock"]][] = [
  [ccc.KnownScript.OmniLock, "Omnilock"],
  [ccc.KnownScript.JoyId, "JoyID"],
  [ccc.KnownScript.NostrLock, "Nostr lock"],
];

/**
 * For an owner lock that is Omnilock, JoyID or the Nostr lock referenced by type
 * id: reads its live code cell and returns a warning unless the cell's data hash
 * is in `reviewed` (default `REVIEWED_OWNER_LOCK_BUILDS`). `undefined` for every other lock (secp256k1,
 * multisig, and any lock referenced by data hash, which already binds the binary).
 *
 * Never throws: if the code cell cannot be read (RPC error, or no live cell),
 * the warning is `"owner-lock-build-unresolved"`. The pin is advisory, so a
 * failed read cannot be stricter than an unknown build; and a client that cannot
 * read cells will fail later in the opening anyway.
 */
export async function checkOwnerLockBuild(
  lockLike: ccc.ScriptLike,
  client: ccc.Client,
  reviewed: readonly OwnerLockBuild[] = REVIEWED_OWNER_LOCK_BUILDS,
): Promise<SessionWarning | undefined> {
  const lock = ccc.Script.from(lockLike);
  if (lock.hashType !== "type") return undefined;
  let found: { info: ccc.ScriptInfo; name: OwnerLockBuild["lock"] } | undefined;
  for (const [known, name] of BUILD_PINNED) {
    try {
      const info = await client.getKnownScript(known);
      if (info.codeHash === lock.codeHash && info.hashType === "type") found = { info, name };
    } catch {
      // not deployed on this network
    }
    if (found) break;
  }
  if (!found) return undefined;
  const { info, name } = found;
  const whose = `the owner's lock (${name}, type id ${lock.codeHash})`;
  let dataHash: ccc.Hex | undefined;
  try {
    const type = info.cellDeps.map((d) => d.type).find((t) => t && t.hash() === lock.codeHash);
    const cell = type && (await client.findSingletonCellByType(type, true));
    if (cell && cell.cellOutput.type?.hash() === lock.codeHash) dataHash = ccc.hashCkb(cell.outputData);
  } catch {
    dataHash = undefined;
  }
  if (!dataHash) {
    return {
      code: "owner-lock-build-unresolved",
      message: `${whose}: its live code cell could not be read, so its build was not checked against the reviewed builds`,
    };
  }
  if (reviewed.some((b) => b.codeHash === lock.codeHash && b.dataHash === dataHash)) return undefined;
  return {
    code: "owner-lock-build-unreviewed",
    dataHash,
    message:
      `${whose} now runs code with data hash ${dataHash}, not a build this kit has reviewed: ` +
      "the deployer may have upgraded it. Check that every way to unlock it still signs the whole transaction",
  };
}

/** Reports `checkOwnerLockBuild`'s warning, if any, to `onWarning` or `console.warn` (internal; not exported from the package). */
export async function warnOwnerLockBuild(
  lock: ccc.Script,
  client: ccc.Client,
  onWarning?: (warning: SessionWarning) => void | Promise<void>,
): Promise<void> {
  const w = await checkOwnerLockBuild(lock, client);
  if (!w) return;
  if (onWarning) await onWarning(w);
  else console.warn(`ckb-session-kit: ${w.message}`);
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
    /**
     * Called before anything is signed, once per `SessionWarning`; throw to stop the
     * opening. Without it, warnings go to `console.warn`.
     */
    onWarning?: (warning: SessionWarning) => void | Promise<void>;
  } & SigningLockOptions,
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
  await assertSigningLock(ownerLock, client, opts);
  await warnOwnerLockBuild(ownerLock, client, opts.onWarning);
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
  // Before any signature, so the caller can still stop (review 2 Nov).
  for (const w of sessionWarnings(binding.minInterval, recipientLockHash !== undefined)) {
    if (opts.onWarning) await opts.onWarning(w);
    else console.warn(`ckb-session-kit: ${w.message}`);
  }
  // Not a legacy lock, and its code is live on this network (audit round 2, 31 Oct).
  await assertCurrentDeployment(client, deployment);
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
  const fault = plainXudtFault(type, await client.getKnownScript(ccc.KnownScript.XUdt));
  if (fault) throw new SessionPolicyError(fault);
}

/** The network's xUDT code: what `client.getKnownScript(ccc.KnownScript.XUdt)` returns. */
type XudtCode = { codeHash: ccc.Hex; hashType: ccc.HashType };

/** Why `type` is not a plain xUDT under the network's xUDT script `xudt`, or undefined if it is. */
export function plainXudtFault(type: ccc.Script, xudt: XudtCode): string | undefined {
  if (type.codeHash !== xudt.codeHash || type.hashType !== xudt.hashType) {
    return "a token session holds an xUDT token; this type script is not xUDT";
  }
  const args = ccc.bytesFrom(type.args);
  if (args.length < 32) return "xUDT args must start with the issuer's 32-byte lock hash";
  if (args.length >= 36 && ccc.numLeFromBytes(args.slice(32, 36)) !== 0n) {
    return "xUDT tokens with flags (extension scripts, other owner modes) are not supported in a session";
  }
  return undefined;
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
 *
 * With `topUp`, the recipient's cell is a confirmed one that no transaction in
 * the node's pool spends, where the node can tell (`pickPayoutCell`): readers
 * paying at the same moment compete for those cells.
 *
 * If the node rejects the payment because an input is already spent (another
 * tab, device or payer took it first) or unknown, the client's cache is cleared
 * and the payment is built again from the live cells, with another payout
 * cell, after a short wait: up to `retry.attempts` in all (default 3), waiting
 * `retry.delayMs` (default 1000) doubling each time. `beforeSend` runs again
 * with each new hash (`rebuildOnDeadInputs`). A send whose outcome is unknown
 * is never retried.
 */
export async function spendInSession(
  session: Session,
  client: ccc.Client,
  deployment: SessionLockDeployment,
  binding: OnChainBinding,
  request: SpendRequest,
  now: Date = new Date(),
): Promise<ccc.Hex> {
  // Built on a cell another tab or payer spent since: rebuilt from live cells (audit, 31 Oct; review, 2 Nov).
  return rebuildOnDeadInputs(client, (avoid) => spendOnce(session, client, deployment, binding, request, now, avoid), request.retry);
}

type SpendCommon = { to: string; topUp?: boolean; memo?: ccc.HexLike; beforeSend?: (txHash: ccc.Hex) => Promise<void>; retry?: RetryOptions };
type SpendRequest = SpendCommon & ({ amount: bigint; token?: undefined } | { token: bigint; amount?: undefined });

async function spendOnce(
  session: Session,
  client: ccc.Client,
  deployment: SessionLockDeployment,
  binding: OnChainBinding,
  request: SpendRequest,
  now: Date,
  avoid: ReadonlySet<string>,
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
  if (!state.keyCells.length) throw new SessionBalanceError("no key cell left to pay fees", "no-fee-cell");

  const since = binding.minInterval > 0n ? relativeBlocksSince(binding.minInterval) : 0n;
  const tx = ccc.Transaction.from({ cellDeps: [sessionLockCellDep(deployment)] });
  if (tokenType) await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt);

  // The payment: output 0, plus the recipient's cell when topping up.
  let ckbOut: bigint;
  if (request.topUp) {
    if (!(await isAnyoneCanPay(toLock, client))) throw new ScopeError("top-up needs an anyone-can-pay recipient");
    // Payers at once compete for a cell: a confirmed one no pool transaction spends,
    // at random among the recipient's (pickPayoutCell).
    ckbOut = request.amount ?? 0n;
    const paid = request.token !== undefined ? { token: tokenType, units: tokenOut } : { ckb: ckbOut };
    if (!(await addTopUp(tx, client, toLock, paid, avoid))) {
      throw new SessionBalanceError("the recipient has no anyone-can-pay cell to top up", "no-payout-cell");
    }
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
  // The largest one: any other plain cell sent to the key address (a stranger's
  // 61 CKB, or a top-up beside a key cell run down to its floor) is listed first
  // and may not cover the fee (audit, 30 Oct). One key cell in, one out, no larger.
  tx.inputs.push(ccc.CellInput.from({ previousOutput: largestCell(state.keyCells).outPoint }));
  if (request.memo !== undefined) tx.setWitnessArgsAt(tx.inputs.length - 1, { inputType: request.memo });
  tx.addOutput({ lock: state.keyLock, capacity: 0n });
  await completeFeeOrNoFeeCell(tx, sessionSigner(session, client), "the key cell cannot cover the fee; top it up");
  // Below this, the key cell could no longer go back to the owner at the end.
  if (tx.outputs[tx.outputs.length - 1].capacity < keyCellFloor(binding.ownerLock)) {
    throw new SessionBalanceError("the key cell cannot cover another fee; top it up", "no-fee-cell");
  }
  return signAndSend(sessionSigner(session, client), tx, request.beforeSend);
}

/**
 * The fee rate `fundInSession` and `sendWithSession` use when none is given, in
 * shannons per 1000 bytes (twice the usual testnet minimum). `sendWithSession` keeps the
 * same rate on every attempt (see there).
 */
export const DEFAULT_FUND_FEE_RATE = 2000n;

/** Options for {@link fundInSession}. */
export interface FundOptions {
  /** Shannons per 1000 bytes (default `DEFAULT_FUND_FEE_RATE`). The key cell pays it. */
  feeRate?: ccc.NumLike;
  /**
   * The app's own policy on the finished transaction (which outputs it may hold),
   * run last, before anything is signed: throw to refuse it. It guards against
   * app bugs; a leaked key is bounded by the lock, not by this.
   */
  check?: (tx: ccc.Transaction) => void | Promise<void>;
  now?: Date;
  /** Out points (as `ccc.hexFrom(outPoint.toBytes())`) of session or key cells not to take. */
  avoid?: ReadonlySet<string>;
}

/** What {@link fundInSession} returns. */
export interface FundedTransaction {
  /** The app's transaction with the session's inputs and outputs added, unsigned. */
  tx: ccc.Transaction;
  /** Shannons leaving the session cells (session inputs less change): what the lock holds to `maxPerTx`. */
  outflow: bigint;
  /** The inputs the kit added: session cells, then the key cell (and any key cell CCC added for the fee). */
  sessionInputs: ccc.OutPoint[];
}

/**
 * Funds a transaction the app built (its own inputs, typed outputs, cell deps
 * and witnesses) from the session: adds session cells as inputs, at most one
 * plain change cell under the session lock, and the key cell, which comes back
 * as the last output and pays the fee. Signs nothing; `sendWithSession` signs
 * and sends. The checks follow the order the session lock makes them, so a
 * transaction this returns is one the lock accepts:
 *
 * 1. The session is active, and has no on-chain recipient: a recipient-scoped
 *    session can only pay that recipient and the owner, never a typed output
 *    (lock errors 13 and 18), so it is refused (`SessionPolicyError`,
 *    "session-has-recipient").
 * 2. No input of the app's is under the owner's lock: the lock would run in owner
 *    mode, and the wallet would have to sign ("owner-lock-input"). None is under
 *    the session lock or the key's lock, and no output is either: the kit adds
 *    those ("app-tx-shape").
 * 3. Need = the outputs' capacity less the app inputs'. Over `maxPerTx`, a
 *    `ScopeError` before anything is looked up. Session cells are taken (plain
 *    ones only, mature ones under a rate limit, with `since` set), and change
 *    is either none or at least a session cell's size (121 CKB for 80-byte args).
 * 4. The key cell: the largest, in last, out last; the fee (`feeRate`) comes out
 *    of it, so the fee never counts as outflow.
 * 5. outflow = session inputs less change, checked against `maxPerTx` again;
 *    then `opts.check`.
 *
 * The app's inputs, witnesses and cell deps stay where they are; the kit's
 * inputs go after them. `tx` itself is not changed.
 */
export async function fundInSession(
  session: Session,
  client: ccc.Client,
  deployment: SessionLockDeployment,
  binding: OnChainBinding,
  txLike: ccc.TransactionLike,
  opts: FundOptions = {},
): Promise<FundedTransaction> {
  const now = opts.now ?? new Date();
  if (!isActive(session, now)) throw new ScopeError("session expired");
  if (binding.recipientLockHash) {
    throw new SessionPolicyError(
      "an app transaction with typed outputs to other locks needs a session without a recipient: " +
        "this session's lock only lets it pay its recipient and the owner, in plain cells",
      "session-has-recipient",
    );
  }
  const { maxPerTx } = session.policy.scope;
  const tx = ccc.Transaction.from(txLike).clone();
  const appInputs = tx.inputs.length;
  const state = await findSessionCells(session, client, deployment, binding);
  const ownerHash = ccc.Script.from(binding.ownerLock).hash();
  const ownHashes = [state.lock.hash(), state.keyLock.hash()];

  for (const [i, input] of tx.inputs.entries()) {
    await input.completeExtraInfos(client);
    const lockHash = input.cellOutput?.lock.hash();
    if (lockHash === ownerHash) {
      throw new SessionPolicyError(
        `input ${i} is under the session owner's lock: the session lock would run in owner mode and ` +
          "the wallet would have to sign; fund this transaction from the wallet instead",
        "owner-lock-input",
      );
    }
    if (lockHash && ownHashes.includes(lockHash)) {
      throw new SessionPolicyError(`input ${i} is a session or key cell: fundInSession adds those itself`, "app-tx-shape");
    }
  }
  for (const [i, output] of tx.outputs.entries()) {
    if (ownHashes.includes(output.lock.hash())) {
      throw new SessionPolicyError(
        `output ${i} is under the session lock or the key's lock: fundInSession adds the change and key cells itself`,
        "app-tx-shape",
      );
    }
  }

  const need = tx.getOutputsCapacity() - (await tx.getInputsCapacity(client));
  if (need < 0n) {
    throw new SessionPolicyError(
      `the app transaction's inputs exceed its outputs by ${ccc.fixedPointToString(-need)} CKB: ` +
        "give the surplus an output, or it would go to the key cell",
      "app-tx-shape",
    );
  }
  if (need > maxPerTx) {
    throw new ScopeError(
      `the transaction needs ${ccc.fixedPointToString(need)} CKB from the session, over maxPerTx ` +
        `(${ccc.fixedPointToString(maxPerTx)} CKB)`,
    );
  }

  const avoid = opts.avoid ?? new Set<string>();
  const free = (c: ccc.Cell) => !avoid.has(outPointKey(c.outPoint));
  const keyCells = state.keyCells.filter(free);
  if (!keyCells.length) throw new SessionBalanceError("no key cell left to pay fees", "no-fee-cell");

  // Plain cells only: in a token session the tokens stay where they are.
  const plain = state.sessionCells.filter((c) => !c.cellOutput.type && free(c));
  const usable = need > 0n && binding.minInterval > 0n ? await matureCells(client, plain, binding.minInterval) : plain;
  if (need > 0n && plain.length && !usable.length) {
    throw new SessionBalanceError(`rate limited: no session cell is ${binding.minInterval} blocks old yet`);
  }
  // Change is none, or a whole session cell: take one more cell rather than leave a sliver.
  const minChange = ccc.CellOutput.from({ lock: state.lock }, "0x").capacity;
  const taken: ccc.Cell[] = [];
  let ckbIn = 0n;
  for (const cell of usable) {
    if (ckbIn >= need && (ckbIn === need || ckbIn - need >= minChange)) break;
    taken.push(cell);
    ckbIn += cell.cellOutput.capacity;
  }
  const balance = plain.reduce((s, c) => s + c.cellOutput.capacity, 0n);
  if (ckbIn < need) {
    throw new SessionBalanceError(
      `session balance ${ccc.fixedPointToString(balance)} CKB is too low: the transaction needs ${ccc.fixedPointToString(need)} CKB`,
    );
  }
  const change = ckbIn - need;
  if (change > 0n && change < minChange) {
    throw new SessionBalanceError(
      `the session would keep ${ccc.fixedPointToString(change)} CKB, below the ` +
        `${ccc.fixedPointToString(minChange)} CKB a session cell needs; spend all of it or less`,
    );
  }

  const since = binding.minInterval > 0n ? relativeBlocksSince(binding.minInterval) : 0n;
  tx.inputs.push(...taken.map((c) => ccc.CellInput.from({ previousOutput: c.outPoint, since })));
  if (taken.length) tx.addCellDeps(sessionLockCellDep(deployment));
  if (change > 0n) tx.addOutput({ lock: state.lock, capacity: change }, "0x");

  // The key cell authorises the spend, comes back last and pays the fee (as in spendOnce).
  tx.inputs.push(ccc.CellInput.from({ previousOutput: largestCell(keyCells).outPoint }));
  tx.addOutput({ lock: state.keyLock, capacity: 0n }, "0x");
  await completeFeeOrNoFeeCell(
    tx,
    sessionSigner(session, client),
    "the key cell cannot cover the fee; top it up",
    opts.feeRate ?? DEFAULT_FUND_FEE_RATE,
  );
  if (tx.outputs[tx.outputs.length - 1].capacity < keyCellFloor(binding.ownerLock)) {
    throw new SessionBalanceError("the key cell cannot cover another fee; top it up", "no-fee-cell");
  }

  // The lock's own rules on the result (1: outflow; 3 and 5: one plain change cell).
  const outflow = taken.reduce((s, c) => s + c.cellOutput.capacity, 0n) - change;
  if (outflow > maxPerTx) {
    throw new ScopeError(`outflow ${ccc.fixedPointToString(outflow)} CKB exceeds maxPerTx (${ccc.fixedPointToString(maxPerTx)} CKB)`);
  }
  const changeCells = tx.outputs.filter((o) => o.lock.eq(state.lock));
  if (changeCells.length > 1 || changeCells.some((o) => o.type)) {
    throw new SessionPolicyError("the session lock allows one plain change cell", "app-tx-shape");
  }
  await opts.check?.(tx);
  return { tx, outflow, sessionInputs: tx.inputs.slice(appInputs).map((i) => i.previousOutput) };
}

/** Options for {@link sendWithSession}. */
export interface SendWithSessionOptions extends Omit<FundOptions, "avoid"> {
  /** Runs with the signed transaction's hash before it is sent, on every attempt (see `signAndSend`). */
  beforeSend?: (txHash: ccc.Hex) => Promise<void>;
  /** Attempts and backoff for a refusal naming one of the session's own cells (default `DEFAULT_RETRY`). */
  retry?: RetryOptions;
}

/**
 * Builds the app's transaction (`build`), funds it from the session
 * (`fundInSession`), signs it with the session key alone and sends it. No
 * wallet is involved: the key signs only its own cell, and the session lock
 * checks no signature. Returns the transaction hash.
 *
 * Retries only when the node refuses the transaction for one of the session's
 * own cells (`Dead` or `Unknown` naming a session or key cell this attempt
 * added: another tab spent it). Then the client's cache is cleared, that cell
 * is left out, and `build` runs again, with the backoff of `rebuildOnDeadInputs`.
 *
 * Any other refusal is thrown unchanged, for the app's own loop: a dead input of
 * the app's (another user took the cell the app built on, such as a
 * crowdfunding campaign cell; `deadInputs(e)` is true) or an RBF refusal
 * (`poolConflict(e)`), which names no cell. The app waits for its cell to move
 * and calls again. A send whose outcome is unknown is never retried.
 *
 * The fee rate is the same on every attempt (`feeRate`, default
 * `DEFAULT_FUND_FEE_RATE`): a retry at a higher rate could replace (RBF)
 * another user's pending transaction on the same app cell.
 */
export async function sendWithSession(
  session: Session,
  client: ccc.Client,
  deployment: SessionLockDeployment,
  binding: OnChainBinding,
  build: () => Promise<ccc.TransactionLike>,
  opts: SendWithSessionOptions = {},
): Promise<ccc.Hex> {
  const attempts = Math.max(1, Math.floor(opts.retry?.attempts ?? DEFAULT_RETRY.attempts));
  const delay = Math.max(0, opts.retry?.delayMs ?? DEFAULT_RETRY.delayMs);
  const feeRate = opts.feeRate ?? DEFAULT_FUND_FEE_RATE; // fixed for every attempt
  const avoid = new Set<string>();
  for (let attempt = 1; ; attempt++) {
    let ours = new Set<string>();
    try {
      const funded = await fundInSession(session, client, deployment, binding, await build(), {
        feeRate,
        check: opts.check,
        now: opts.now,
        avoid,
      });
      ours = new Set(funded.sessionInputs.map(outPointKey));
      return await signAndSend(sessionSigner(session, client), funded.tx, opts.beforeSend);
    } catch (e) {
      const named = e instanceof SendOutcomeUnknownError ? undefined : rejectedOutPoint(e);
      if (!named || !ours.has(named) || attempt >= attempts) throw e;
      avoid.add(named);
      await client.cache?.clear();
      const wait = delay * 2 ** (attempt - 1) * (0.5 + Math.random());
      if (wait > 0) await sleep(wait);
    }
  }
}

/**
 * `completeFeeChangeToOutput` into the last output, with CCC's "Insufficient CKB"
 * (the paying cell holds its floor but not the fee too) as a
 * `SessionBalanceError` with reason `no-fee-cell` (audit round 2, 31 Oct).
 */
export async function completeFeeOrNoFeeCell(
  tx: ccc.Transaction,
  signer: ccc.Signer,
  message: string,
  feeRate?: ccc.NumLike,
): Promise<void> {
  try {
    await (feeRate === undefined
      ? tx.completeFeeChangeToOutput(signer, tx.outputs.length - 1)
      : tx.completeFeeChangeToOutput(signer, tx.outputs.length - 1, feeRate));
  } catch (e) {
    // By class, or by message where a second copy of CCC threw it (a bundler's CJS and ESM builds).
    const short = e instanceof ccc.ErrorTransactionInsufficientCapacity || (e instanceof Error && /^Insufficient CKB/.test(e.message));
    if (short) throw new SessionBalanceError(message, "no-fee-cell");
    throw e;
  }
}

/** The largest of `cells` by capacity; on a tie, the lowest out point (tx hash, then index), whatever the indexer order. */
function largestCell(cells: ccc.Cell[]): ccc.Cell {
  const before = (x: ccc.OutPoint, y: ccc.OutPoint) => (x.txHash !== y.txHash ? x.txHash < y.txHash : x.index < y.index);
  return cells.reduce((best, c) => {
    const a = c.cellOutput.capacity;
    const b = best.cellOutput.capacity;
    return a > b || (a === b && before(c.outPoint, best.outPoint)) ? c : best;
  });
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
 * be forgotten. If the funding transaction (`binding.openTx`) is still in flight,
 * or committed with an output under the session or the key the node still holds
 * live (not indexed yet), this throws instead, so the key is never forgotten
 * before the funds it controls arrive. Once the funding is committed and every
 * one of those outputs is spent (a close whose reply was lost, another tab's
 * close), it is `nothingFound` (audit, 31 Oct).
 *
 * `owner` must be the wallet that opened the session (its lock is
 * `binding.ownerLock`): any other is refused with a `SessionPolicyError` before
 * it is asked to sign anything.
 */
export async function closeSession(
  owner: ccc.Signer,
  session: Session,
  deployment: SessionLockDeployment,
  binding: OnChainBinding,
): Promise<{ keyTx?: ccc.Hex; sweepTx?: ccc.Hex; keyError?: string; nothingFound?: true }> {
  const client = owner.client;
  const ownerLock = ccc.Script.from(binding.ownerLock);
  // After a wallet switch, the connected wallet may not be the owner: it must not
  // be shown a sweep of someone else's session to itself (audit, 31 Oct).
  const signerLock = (await owner.getRecommendedAddressObj()).script;
  if (signerLock.hash() !== ownerLock.hash()) {
    throw new SessionPolicyError("this signer is not the session's owner: connect the wallet that opened it");
  }
  // Built on a cell another tab spent since: rebuilt once from live cells.
  return rebuildOnDeadInputs(client, () => closeOnce(owner, session, deployment, binding));
}

/**
 * Whether the node's indexer has reached the chain tip: false when it is behind,
 * undefined for a client with no JSON-RPC requestor to ask (tests, custom clients).
 */
async function indexerCaughtUp(client: ccc.Client): Promise<boolean | undefined> {
  const requestor = (client as { requestor?: { request(method: string, params: unknown[]): Promise<unknown> } }).requestor;
  if (!requestor) return undefined;
  try {
    const tip = (await requestor.request("get_indexer_tip", [])) as { block_number?: string } | null;
    if (!tip?.block_number) return false;
    return BigInt(tip.block_number) >= (await client.getTip());
  } catch {
    return false; // cannot tell: keep the key
  }
}

async function closeOnce(
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
    if (binding.openTx && open && open.status === "committed") {
      const openTx = binding.openTx;
      // Nothing indexed under the session: the indexer lags, or every output the
      // funding made under the session and the key is spent already. Ask the node.
      const ours = (open.transaction?.outputs ?? [])
        .map((o, index) => ({ o, index }))
        .filter(({ o }) => o.lock.eq(state.lock) || o.lock.eq(state.keyLock));
      if (!ours.length) {
        throw new SessionBalanceError("the funding transaction made no cell under this session: is it the session's deployment?");
      }
      const live = await Promise.all(
        ours.map(({ index }) => client.getCellLive({ txHash: openTx, index }, false, false)),
      );
      if (live.every((c) => !c)) {
        // Spent, but a later spend's new key cell may not be indexed yet: trust the
        // empty search only once the indexer has reached the tip, and search again.
        if ((await indexerCaughtUp(client)) === false) {
          throw new SessionBalanceError("the indexer is behind the chain; close again in a minute");
        }
        const again = await findSessionCells(session, client, deployment, binding);
        if (!again.sessionCells.length && !again.keyCells.length) return { nothingFound: true };
        throw new SessionBalanceError("the session's cells were not indexed yet; close again");
      }
      throw new SessionBalanceError("the session's funding transaction is not indexed yet; close again in a minute");
    }
    if (open && (open.status === "pending" || open.status === "proposed")) {
      throw new SessionBalanceError(`the session's funding transaction is ${open.status}; close again in a minute`);
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
      const key = sessionSigner(session, client);
      await tx.completeFeeChangeToOutput(key, 0);
      // A key return the node took but whose reply was lost is still the key return.
      result.keyTx = await signAndSend(key, tx);
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
 * own token, a plain xUDT, in exactly 16 bytes of data; anything else could make
 * the sweep fail. Cells
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
  let xudt: XudtCode | undefined; // looked up once, at the first typed cell
  for (const deployment of [deployments].flat()) {
    for await (const cell of owner.client.findCells({
      script: { codeHash: deployment.codeHash, hashType: deployment.hashType, args: ownerLock.hash() },
      scriptType: "lock",
      scriptSearchMode: "prefix",
      withData: true,
    })) {
      if (cell.cellOutput.type && !xudt) xudt = await owner.client.getKnownScript(ccc.KnownScript.XUdt);
      if (sweepable(cell, xudt)) cells.push(cell);
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
 * sweep fail. So if the one transaction is refused, each session (cells under one
 * session lock) is swept on its own, one signature each: a cell someone else can
 * spend fails alone, and `failed` counts the sessions not recovered. A fault no
 * retry can fix (the owner holds no plain cell to prove ownership) is thrown.
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
  // A fault no other set of cells can fix (no plain owner cell) is thrown, not
  // retried once per session (review, 28 Oct).
  const fixed = (e: unknown) => e instanceof SessionBalanceError || e instanceof SessionPolicyError;
  try {
    return { txHashes: [await ownerSweep(owner, deployment, cells)], recovered: total(cells), cells: cells.length, failed: 0 };
  } catch (e) {
    if (fixed(e)) throw e;
    // Fall through: one session at a time.
  }
  // One group per session lock (its full hash), not per session key: anyone can
  // plant a cell carrying the victim's (public) key hash under other args, and a
  // group it joined would fail on every retry (audit, 30 Oct).
  const sessions = new Map<string, ccc.Cell[]>();
  for (const c of cells) {
    const lockHash = c.cellOutput.lock.hash();
    sessions.set(lockHash, [...(sessions.get(lockHash) ?? []), c]);
  }
  const result = { txHashes: [] as ccc.Hex[], recovered: 0n, cells: 0, failed: 0 };
  for (const group of sessions.values()) {
    try {
      result.txHashes.push(await ownerSweep(owner, deployment, group));
      result.recovered += total(group);
      result.cells += group.length;
    } catch (e) {
      if (fixed(e)) throw e;
      result.failed++;
    }
  }
  return result;
}

/**
 * A session cell an owner sweep can safely include. A typed cell must hold the
 * session's own token, a plain xUDT (`assertPlainXudt`'s rules, against the
 * network's xUDT script `xudt`), in exactly the 16-byte amount a session makes:
 * any other type script can refuse to be consumed, or needs code the sweep does
 * not bring (audit, 30 Oct).
 */
function sweepable(cell: ccc.Cell, xudt?: XudtCode): boolean {
  const args = ccc.bytesFrom(cell.cellOutput.lock.args);
  const type = cell.cellOutput.type;
  if (args.length === 80 || args.length === 112) return !type;
  if (args.length !== 128 && args.length !== 160) return false;
  if (!type) return true;
  return (
    !!xudt &&
    plainXudtFault(type, xudt) === undefined &&
    type.hash() === ccc.hexFrom(args.slice(80, 112)) &&
    ccc.bytesFrom(cell.outputData).length === 16
  );
}

/**
 * Spends `cells` in owner mode: everything returns to the owner. Tokens go back
 * in one cell per token type (xUDT would let a sweep burn them otherwise).
 * `memo` goes in the witness (`input_type`) of the owner's own input, which the
 * owner's signature covers: what the sweep is for (`CLEAR_PLANTED_MEMO`).
 */
export async function ownerSweep(
  owner: ccc.Signer,
  deployments: SessionLockDeployment | SessionLockDeployment[],
  cells: ccc.Cell[],
  opts: { memo?: ccc.Hex } = {},
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
    if (opts.memo) tx.setWitnessArgsAt(tx.inputs.length - 1, { inputType: opts.memo });
    await tx.completeFeeBy(owner);
    // A sweep the node took but whose reply was lost is still the sweep (review, 28 Oct).
    return signAndSend(owner, tx);
  }
  throw new SessionBalanceError("the owner needs one plain cell to prove ownership");
}

/**
 * Gives an anyone-can-pay address (a creator's `payTo`) `count` more cells to be
 * topped up, paid by `funder`, in one transaction. Each top-up consumes one of
 * these cells, so readers paying at the same moment compete for them; with more
 * cells they rarely pick the same one (mentor review, 2 Nov). Anyone can be the
 * funder: the anyone-can-pay lock needs no signature to receive a new cell.
 *
 * Each cell is as small as a cell under `payTo` can be (61 CKB for a 20-byte
 * args address) unless `capacity` is given. With `token`, each is a cell of that
 * token holding 0 units (about 142 CKB), for token payments. `count` is 1 to
 * `MAX_PAYOUT_CELLS`: a payment reads no more than that many.
 */
export async function createPayoutCells(
  funder: ccc.Signer,
  payTo: string,
  opts: { count: number; capacity?: bigint; token?: ccc.ScriptLike; beforeSend?: (txHash: ccc.Hex) => Promise<void> },
): Promise<ccc.Hex> {
  const client = funder.client;
  if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > MAX_PAYOUT_CELLS) {
    throw new RangeError(`count must be 1 to ${MAX_PAYOUT_CELLS}`);
  }
  const { script: lock } = await ccc.Address.fromString(payTo, client);
  if (!(await isAnyoneCanPay(lock, client))) {
    throw new SessionPolicyError("payout cells go under an anyone-can-pay address", "payto-not-anyone-can-pay");
  }
  const token = opts.token && ccc.Script.from(opts.token);
  const tx = ccc.Transaction.from({ outputs: [], outputsData: [] });
  // CCC raises a capacity below what the cell occupies to that size.
  for (let i = 0; i < opts.count; i++) {
    tx.addOutput({ lock, capacity: opts.capacity ?? 0n, ...(token && { type: token }) }, token ? tokenData(0n) : "0x");
  }
  if (token) await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt);
  await tx.completeInputsByCapacity(funder);
  await tx.completeFeeBy(funder);
  return signAndSend(funder, tx, opts.beforeSend);
}
