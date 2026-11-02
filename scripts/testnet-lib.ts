/**
 * Helpers shared by the testnet scripts (scripts/testnet-*.ts). Nothing here
 * touches the network or a key at import: the pure parts (option parsing,
 * plans, the contention analysis, key derivation) are unit-tested in
 * test/testnet-scripts.test.ts without a node.
 */
import { ccc } from "@ckb-ccc/core";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";
import { findSubscriptionCells, type SessionLockDeployment, type Subscription } from "../src/index.js";

export const CKB = 100_000_000n;
export const explorer = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
/** Over HTTP: the default WebSocket connection has hung mid-run (26 Oct). */
export const rpcUrl = (env: NodeJS.ProcessEnv = process.env) => env.CKB_RPC_URL ?? "https://testnet.ckb.dev/";
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- logs ------------------------------------------------------------------

/**
 * With LOG=1, everything the script prints also goes to
 * docs/evidence/<yyyy-mm-dd>-<name>.log (UTF-8, whatever the shell); with
 * LOG=<path>, to that file. Returns the path, or undefined without LOG.
 */
export function startLog(name: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): string | undefined {
  const target = logPath(name, env.LOG, now);
  if (!target) return undefined;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `> ${name} (${now.toISOString()})\n\n`);
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      appendFileSync(target, format(...args) + "\n");
    };
  }
  return target;
}

export function logPath(name: string, log: string | undefined, now = new Date()): string | undefined {
  if (!log || log === "0") return undefined;
  if (log !== "1") return log;
  return `docs/evidence/${now.toISOString().slice(0, 10)}-${name}.log`;
}

/** An error as the node gave it: class, code, message and data, on one line. */
export function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e).replace(/\s+/g, " ");
  const err = e as Error & { code?: unknown; data?: unknown };
  const code = err.code !== undefined ? ` code ${String(err.code)}` : "";
  const data = err.data !== undefined && err.data !== "" ? ` data ${String(err.data)}` : "";
  return `${err.constructor?.name ?? err.name}${code}: ${err.message}${data}`.replace(/\s+/g, " ");
}

export type Rejection = "rbf" | "dead" | "unknown" | "duplicated" | "other";

/** What kind of refusal a send got, from the node's text (see drafts/w6-contention.md). */
export function classifyRejection(text: string): Rejection {
  if (/RBFRejected|PoolRejectedRBF|code -1111\b/.test(text)) return "rbf";
  if (/\bDead\(OutPoint\(/.test(text)) return "dead";
  if (/\bUnknown\(OutPoint\(/.test(text) || /ErrorClientResolveUnknown/.test(text)) return "unknown";
  if (/Duplicated|code -1107\b/.test(text)) return "duplicated";
  return "other";
}

// --- options ---------------------------------------------------------------

/** An integer option from `--name=N` in argv, else the env variable, else `fallback`; within [min, max]. */
export function intOption(
  name: string,
  envName: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  fallback: number,
  min: number,
  max: number,
): number {
  const flag = argv.find((a) => a.startsWith(`--${name}=`));
  const raw = flag ? flag.slice(name.length + 3) : env[envName];
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new RangeError(`${name} (--${name}= or ${envName}) must be an integer from ${min} to ${max}, got ${raw}`);
  }
  return n;
}

export const isDryRun = (argv: string[], env: NodeJS.ProcessEnv = process.env) =>
  argv.includes("--dry-run") || env.DRY_RUN === "1";

export interface ContentionOptions {
  /** Payers paying at the same moment. */
  payers: number;
  /** Rounds of simultaneous payments, all committed before the next. */
  rounds: number;
  /** Plain anyone-can-pay cells the creator should have before the rounds. */
  cells: number;
}

export function contentionOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): ContentionOptions {
  return {
    payers: intOption("payers", "PAYERS", argv, env, 4, 2, 16),
    // A 160 CKB session cell keeps at least 153 after at most 7 payments of 1 CKB.
    rounds: intOption("rounds", "ROUNDS", argv, env, 2, 1, 5),
    cells: intOption("cells", "CELLS", argv, env, 8, 1, 64),
  };
}

/** What each payer key gets: a 160 CKB session, a 62 CKB key cell, a change cell (61+) and fees. */
export const PAYER_FUNDING = 300n * CKB;
export const PAYER_BUDGET = 160n * CKB;
/** The key that sends the hand-built conflicting top-up. */
export const PROBE_FUNDING = 100n * CKB;
export const PAYMENT = 1n * CKB;
export const PLAIN_ACP_CELL = 61n * CKB;

export function contentionCost(o: ContentionOptions, payoutCellsHave: number) {
  const create = Math.max(0, o.cells - payoutCellsHave);
  return {
    /** Out of the funder for the run, back at the end (less what is paid). */
    lent: BigInt(o.payers) * PAYER_FUNDING + PROBE_FUNDING,
    /** New payout cells: they stay the creator's (61 CKB each). */
    payoutCells: BigInt(create) * PLAIN_ACP_CELL,
    created: create,
    /** Paid to the creator: 1 CKB per payer per round, and the probe's 1 CKB. */
    paid: BigInt(o.payers * o.rounds) * PAYMENT + PAYMENT,
  };
}

export interface ClearOptions {
  /** The subscription's period, in blocks. */
  period: number;
}

export function clearOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): ClearOptions {
  // Long enough that planting and clearing (two commits) land inside the first period.
  return { period: intOption("period", "PERIOD_BLOCKS", argv, env, 30, 10, 1000) };
}

/** How many cells to plant to take a subscription with `own` cells past `cap`, and what they hold. */
export function plantPlan(own: number, cellCapacity: bigint, cap = 16) {
  const count = Math.max(1, cap + 1 - own);
  return { count, locked: BigInt(count) * cellCapacity };
}

// --- keys ------------------------------------------------------------------

const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

/**
 * A testnet key derived from `seed` (the funder's key), a label and an index:
 * the same on every run, so a run cut short can be swept back by running again.
 * One-way (blake2b), so it says nothing about `seed`.
 */
export function deriveKey(seed: ccc.HexLike, label: string, index: number): ccc.Hex {
  for (let salt = 0; ; salt++) {
    const k = ccc.hashCkb(ccc.bytesFrom(seed), ccc.bytesFrom(`ckb-session-kit/${label}/${index}/${salt}`, "utf8"));
    const n = BigInt(k);
    if (n > 0n && n < SECP256K1_N) return k;
  }
}

// --- chain -----------------------------------------------------------------

export async function committed(client: ccc.Client, hash: ccc.Hex): Promise<bigint> {
  for (let i = 0; i < 180; i++) {
    const res = await client.getTransaction(hash);
    if (res?.status === "committed" && res.blockNumber !== undefined) return res.blockNumber;
    await sleep(5000);
  }
  throw new Error(`not committed after 15 minutes: ${explorer(hash)}`);
}

export async function balanceOf(client: ccc.Client, lock: ccc.Script): Promise<bigint> {
  let total = 0n;
  for await (const cell of client.findCellsByLock(lock, null, true)) total += cell.cellOutput.capacity;
  return total;
}

/** Plain cells (no type, no data) under `lock`, as the indexer lists them. */
export async function plainCells(client: ccc.Client, lock: ccc.Script): Promise<ccc.Cell[]> {
  const cells: ccc.Cell[] = [];
  for await (const cell of client.findCellsByLock(lock, null, true)) {
    if (!cell.cellOutput.type && cell.outputData === "0x") cells.push(cell);
  }
  return cells;
}

export async function fund(from: ccc.Signer, lock: ccc.Script, capacity: bigint, what: string): Promise<void> {
  console.log(`setup: ${what}`);
  const tx = ccc.Transaction.from({ outputs: [{ lock, capacity }] });
  await tx.completeInputsByCapacity(from);
  await tx.completeFeeBy(from);
  const hash = await from.sendTransaction(tx);
  console.log(`  ${explorer(hash)}`);
  await committed(from.client, hash);
}

/** Sends every plain cell of `from` to `to` in one transaction; undefined when it has none. */
export async function sweepAll(from: ccc.Signer, to: ccc.Script): Promise<{ hash: ccc.Hex; amount: bigint } | undefined> {
  const lock = (await from.getRecommendedAddressObj()).script;
  const amount = (await plainCells(from.client, lock)).reduce((s, c) => s + c.cellOutput.capacity, 0n);
  if (amount === 0n) return undefined;
  const tx = ccc.Transaction.from({ outputs: [{ lock: to, capacity: 0n }] });
  await tx.completeInputsAll(from);
  await tx.completeFeeChangeToOutput(from, 0);
  return { hash: await from.sendTransaction(tx), amount };
}

/** A JSON-RPC call to the node as-is, for answers CCC reshapes (get_live_cell's status, tx_pool_info). */
export async function rawRpc<T = unknown>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

/** get_live_cell's own status ("live", "dead", "unknown") with and without the pool. */
export async function liveStatus(url: string, op: ccc.OutPointLike): Promise<{ withPool: string; withoutPool: string }> {
  const o = ccc.OutPoint.from(op);
  const arg = { tx_hash: o.txHash, index: ccc.numToHex(o.index) };
  const [a, b] = await Promise.all([
    rawRpc<{ status: string }>(url, "get_live_cell", [arg, false, true]),
    rawRpc<{ status: string }>(url, "get_live_cell", [arg, false, false]),
  ]);
  return { withPool: a.status, withoutPool: b.status };
}

export interface PoolInfo {
  minFeeRate: bigint;
  minRbfRate: bigint;
  rbf: boolean;
  pending: bigint;
  version?: string;
}

/** The node's fee and RBF settings: RBF is on when min_rbf_rate > min_fee_rate. */
export async function poolInfo(url: string): Promise<PoolInfo> {
  const info = await rawRpc<{ min_fee_rate: string; min_rbf_rate: string; pending: string }>(url, "tx_pool_info", []);
  const node = await rawRpc<{ version?: string }>(url, "local_node_info", []).catch(() => undefined);
  const minFeeRate = BigInt(info.min_fee_rate);
  const minRbfRate = BigInt(info.min_rbf_rate);
  return { minFeeRate, minRbfRate, rbf: minRbfRate > minFeeRate, pending: BigInt(info.pending), version: node?.version };
}

/** Waits until a subscription cell is at least `blocks` old (0 = a full period). */
export async function waitBlocks(client: ccc.Client, deployment: SessionLockDeployment, sub: Subscription, blocks: bigint): Promise<void> {
  // Testnet blocks can slow to minutes each (26 Oct): wait up to an hour.
  for (let i = 0; i < 720; i++) {
    const { nextChargeIn } = await findSubscriptionCells(client, deployment, sub);
    if (nextChargeIn !== undefined && (blocks === 0n ? nextChargeIn === 0n : sub.periodBlocks - nextChargeIn >= blocks)) return;
    await sleep(5000);
  }
  throw new Error("the subscription cell did not age in an hour");
}

export const outPointText = (op: ccc.OutPointLike) => {
  const o = ccc.OutPoint.from(op);
  return `${o.txHash}:${o.index}`;
};

// --- contention ------------------------------------------------------------

/** One send a payer's client made: the payout cell its transaction consumed, and what the node said. */
export interface SendRecord {
  hash: ccc.Hex;
  cell?: string;
  error?: string;
  kind?: Rejection;
}

/** A payer's round: its sends in order, its pool checks, and the payment's final hash. */
export interface PayerRound {
  payer: number;
  sends: SendRecord[];
  /** get_live_cell with include_tx_pool during the pick: cells asked, and those found spent. */
  checks: number;
  taken: number;
  final?: ccc.Hex;
  error?: string;
  committed: boolean;
}

export interface RoundAnalysis {
  /** Cells two or more payers' first sends consumed. */
  firstCollisions: { cell: string; payers: number[] }[];
  /** Cells two or more sends of the round consumed, at any attempt. */
  collisions: { cell: string; payers: number[] }[];
  /** Cells two accepted payments consumed: impossible on chain, a bug if seen. */
  doubleAccepted: string[];
  /** Payers refused at least once that still committed. */
  retriedToSuccess: number[];
  failed: number[];
  ok: boolean;
}

/**
 * Whether a round went as the library promises: every payment committed, and
 * either no two payers picked the same cell, or each payer that lost a cell was
 * refused and retried to a committed payment.
 */
export function analyseRound(round: PayerRound[]): RoundAnalysis {
  const group = (sends: { payer: number; cell?: string }[]) => {
    const by = new Map<string, number[]>();
    for (const s of sends) if (s.cell) by.set(s.cell, [...(by.get(s.cell) ?? []), s.payer]);
    return [...by].filter(([, p]) => p.length > 1).map(([cell, payers]) => ({ cell, payers }));
  };
  const first = round.flatMap((p) => (p.sends[0] ? [{ payer: p.payer, cell: p.sends[0].cell }] : []));
  const all = round.flatMap((p) => p.sends.map((s) => ({ payer: p.payer, cell: s.cell })));
  const accepted = round.flatMap((p) => p.sends.filter((s) => !s.error).map((s) => ({ payer: p.payer, cell: s.cell })));
  const failed = round.filter((p) => !p.committed || !p.final).map((p) => p.payer);
  const retriedToSuccess = round.filter((p) => p.committed && p.sends.some((s) => s.error)).map((p) => p.payer);
  const doubleAccepted = group(accepted).map((c) => c.cell);
  return {
    firstCollisions: group(first),
    collisions: group(all),
    doubleAccepted,
    retriedToSuccess,
    failed,
    ok: failed.length === 0 && doubleAccepted.length === 0,
  };
}

/**
 * Records what `client` sends and asks during a pick, while `sink()` returns a
 * record (between rounds it returns undefined and nothing is recorded):
 * each sendTransaction (the payout cell, from `isPayout`, and the refusal), and
 * each get_live_cell with include_tx_pool.
 */
export function instrument(
  client: ccc.Client,
  isPayout: (outPoint: string) => boolean,
  sink: () => PayerRound | undefined,
): void {
  const send = client.sendTransaction.bind(client);
  client.sendTransaction = (async (tx, validator, options) => {
    const t = ccc.Transaction.from(tx);
    const cell = t.inputs.map((i) => outPointText(i.previousOutput)).find(isPayout);
    const rec: SendRecord = { hash: t.hash(), ...(cell && { cell }) };
    try {
      const h = await send(tx, validator, options);
      sink()?.sends.push(rec);
      return h;
    } catch (e) {
      rec.error = errorText(e);
      rec.kind = classifyRejection(rec.error);
      sink()?.sends.push(rec);
      throw e;
    }
  }) as typeof client.sendTransaction;
  const live = client.getCellLive.bind(client);
  client.getCellLive = (async (op, withData, includeTxPool) => {
    const cell = await live(op, withData, includeTxPool);
    const r = sink();
    if (r && includeTxPool) {
      r.checks++;
      if (!cell) r.taken++;
    }
    return cell;
  }) as typeof client.getCellLive;
}
