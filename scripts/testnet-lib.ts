/**
 * Helpers shared by the testnet scripts (scripts/testnet-*.ts). Nothing here
 * touches the network or a key at import: the pure parts (option parsing,
 * plans, the contention analysis, key derivation) are unit-tested in
 * test/testnet-scripts.test.ts without a node.
 */
import { ccc } from "@ckb-ccc/core";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import {
  assertSigningLock,
  findSubscriptionCells,
  SessionPolicyError,
  type SessionLockDeployment,
  type Subscription,
} from "../src/index.js";

export const CKB = 100_000_000n;
export const explorer = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
/** Over HTTP: the default WebSocket connection has hung mid-run (26 Oct). */
export const rpcUrl = (env: NodeJS.ProcessEnv = process.env, fallback = "https://testnet.ckb.dev/") => env.CKB_RPC_URL || fallback;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- keys ------------------------------------------------------------------

/**
 * This repository's .env.smoke (scripts/..), wherever a script is run from: in
 * the current directory it could land outside this repository's .gitignore
 * (review W6 I4). The file's mode 0o600 has no effect on Windows.
 */
export const SMOKE_KEY_FILE = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), ".env.smoke");

/**
 * FUNDER_KEY and CREATOR_KEY from the environment, else from `defaultFile`
 * (`SMOKE_KEY_FILE`, gitignored), which is created with two fresh testnet keys
 * on first run. `created` means the funder has nothing yet: fund it from the faucet.
 * SMOKE_KEY_FILE in the environment names another key file (a worktree using the
 * main checkout's); that file must exist: a mistyped path never creates new keys.
 */
export function smokeKeys(
  env: NodeJS.ProcessEnv = process.env,
  defaultFile: string = SMOKE_KEY_FILE,
): { funderKey: string; creatorKey: string; created: boolean } {
  const hex = /^0x[0-9a-fA-F]{64}$/;
  if (env.FUNDER_KEY || env.CREATOR_KEY) {
    if (!hex.test(env.FUNDER_KEY ?? "") || !hex.test(env.CREATOR_KEY ?? ""))
      throw new Error("FUNDER_KEY and CREATOR_KEY must both be 0x + 64 hex characters (or unset both to use .env.smoke)");
    return { funderKey: env.FUNDER_KEY!, creatorKey: env.CREATOR_KEY!, created: false };
  }
  const file = env.SMOKE_KEY_FILE || defaultFile;
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    const funderKey = /^FUNDER_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(text)?.[1];
    const creatorKey = /^CREATOR_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(text)?.[1];
    if (!funderKey || !creatorKey) throw new Error(`${file} needs FUNDER_KEY=0x… and CREATOR_KEY=0x… lines; fix or remove it`);
    return { funderKey, creatorKey, created: false };
  }
  if (env.SMOKE_KEY_FILE) throw new Error(`SMOKE_KEY_FILE ${env.SMOKE_KEY_FILE} does not exist`);
  const funderKey = ccc.hexFrom(randomBytes(32));
  const creatorKey = ccc.hexFrom(randomBytes(32));
  writeFileSync(
    file,
    `# Testnet keys for smoke:contention and smoke:clear-planted. Testnet only. Never commit.
FUNDER_KEY=${funderKey}
CREATOR_KEY=${creatorKey}
`,
    { flag: "wx", mode: 0o600 },
  );
  return { funderKey, creatorKey, created: true };
}

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

// --- owner locks -----------------------------------------------------------

/** What assertSigningLock says about an owner lock: accepted, or the refusal's reason. */
export type OwnerLockVerdict = "accepted" | "owner-lock-unsafe" | "owner-lock-unreviewed";

/** Owner locks this script holds a key for (derived from the funder's), so it can open a real session. */
export type OwnerLockSigner = "secp256k1" | "multisig" | "omnilock-doge" | "nostr";

export interface OwnerLockCase {
  name: string;
  /** A known script with these args, a script of no known deployment, or the lock of a key this script holds. */
  lock: { known: ccc.KnownScript; args: string } | { script: ccc.ScriptLike } | { signer: OwnerLockSigner };
  expect: OwnerLockVerdict;
  /** Run with allowUnreviewedOwnerLock. */
  optIn?: boolean;
  /** Why, in a few words (the rule or the source). */
  why: string;
}

const a20 = "11".repeat(20);
/** A code hash nothing on testnet is deployed under. */
export const UNKNOWN_CODE_HASH = ("0x" + "ab".repeat(32)) as ccc.Hex;

/** One row per owner-lock class of the allowlist (src/onchain.ts, assertSigningLock). */
export const OWNER_LOCK_CASES: OwnerLockCase[] = [
  { name: "secp256k1-blake160", lock: { signer: "secp256k1" }, expect: "accepted", why: "signature over the whole tx" },
  { name: "secp256k1 multisig v2, 1 of 1", lock: { signer: "multisig" }, expect: "accepted", why: "signatures over the whole tx" },
  { name: "Omnilock, Dogecoin auth 0x05", lock: { signer: "omnilock-doge" }, expect: "accepted", why: "signing auth flag, no mode" },
  { name: "Nostr lock, signing mode (args[0]=0)", lock: { signer: "nostr" }, expect: "accepted", why: "Schnorr signature" },
  { name: "Omnilock, Ethereum auth 0x12", lock: { known: ccc.KnownScript.OmniLock, args: "0x12" + a20 + "00" }, expect: "accepted", why: "signing auth flag, no mode" },
  { name: "JoyID", lock: { known: ccc.KnownScript.JoyId, args: "0x0001" + a20 }, expect: "accepted", why: "reviewed from its docs" },
  { name: "anyone-can-pay (RFC 0026)", lock: { known: ccc.KnownScript.AnyoneCanPay, args: "0x" + a20 }, expect: "owner-lock-unsafe", why: "opens with no signature" },
  { name: "PW-Lock", lock: { known: ccc.KnownScript.PWLock, args: "0x" + a20 }, expect: "owner-lock-unsafe", why: "deployed build is anyone-can-pay" },
  { name: "PW-Lock, with the opt-in", lock: { known: ccc.KnownScript.PWLock, args: "0x" + a20 }, expect: "owner-lock-unsafe", optIn: true, why: "the opt-in never covers a known signature-free lock" },
  { name: "always-success", lock: { known: ccc.KnownScript.AlwaysSuccess, args: "0x" }, expect: "owner-lock-unsafe", why: "opens with no signature" },
  { name: "Omnilock, anyone-can-pay mode 0x02", lock: { known: ccc.KnownScript.OmniLock, args: "0x00" + a20 + "02" + "0000" }, expect: "owner-lock-unsafe", why: "opens with no signature" },
  { name: "Omnilock, administrator mode 0x01", lock: { known: ccc.KnownScript.OmniLock, args: "0x00" + a20 + "01" + "22".repeat(32) }, expect: "owner-lock-unsafe", why: "an admin can unlock it" },
  { name: "Nostr lock, PoW mode (args[0]=0x10)", lock: { known: ccc.KnownScript.NostrLock, args: "0x10" + "00".repeat(20) }, expect: "owner-lock-unsafe", why: "work, not a key, unlocks it" },
  { name: "Omnilock, auth 0xFC (owner lock)", lock: { known: ccc.KnownScript.OmniLock, args: "0xfc" + a20 + "00" }, expect: "owner-lock-unreviewed", why: "hands the check to another lock" },
  { name: "Omnilock, auth 0xFC, with the opt-in", lock: { known: ccc.KnownScript.OmniLock, args: "0xfc" + a20 + "00" }, expect: "accepted", optIn: true, why: "refusal turned into a warning" },
  { name: "unknown code hash", lock: { script: { codeHash: UNKNOWN_CODE_HASH, hashType: "data1", args: "0x" + a20 } }, expect: "owner-lock-unreviewed", why: "not on the allowlist" },
  { name: "unknown code hash, with the opt-in", lock: { script: { codeHash: UNKNOWN_CODE_HASH, hashType: "data1", args: "0x" + a20 } }, expect: "accepted", optIn: true, why: "refusal turned into a warning" },
];

/** The verdict an assertSigningLock (or openSession) outcome amounts to; other errors are rethrown. */
export function ownerLockVerdict(error?: unknown): OwnerLockVerdict {
  if (error === undefined) return "accepted";
  if (error instanceof SessionPolicyError && (error.reason === "owner-lock-unsafe" || error.reason === "owner-lock-unreviewed")) {
    return error.reason;
  }
  throw error;
}

/** assertSigningLock on `lock`, with the warnings it printed (offline for every known script: CCC's tables). */
export async function checkOwnerLock(
  lock: ccc.Script,
  client: ccc.Client,
  optIn = false,
): Promise<{ verdict: OwnerLockVerdict; message?: string; warnings: string[] }> {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    await assertSigningLock(lock, client, { allowUnreviewedOwnerLock: optIn });
    return { verdict: "accepted", warnings };
  } catch (e) {
    return { verdict: ownerLockVerdict(e), message: (e as Error).message, warnings };
  } finally {
    console.warn = warn;
  }
}

/** What each owner this script can sign for gets: a 130 CKB session, a key cell, a change cell (61+) and fees. */
export const OWNER_FUNDING = 300n * CKB;
export const OWNER_BUDGET = 130n * CKB;
/** The PW-Lock proof: a 61 CKB cell (20-byte args), topped up by 1 CKB with no signature; both stay under PW-Lock. */
export const PW_CELL = 61n * CKB;
export const PW_TOP_UP = 1n * CKB;

export interface OwnerLockOptions {
  /** Open and close a real session for each owner lock this script can sign for. */
  open: boolean;
  /** Spend a PW-Lock cell with no witness (costs PW_CELL + PW_TOP_UP for good). */
  pwProof: boolean;
}

export function ownerLockOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): OwnerLockOptions {
  return {
    open: !(argv.includes("--no-open") || env.NO_OPEN === "1"),
    pwProof: !(argv.includes("--no-pw-proof") || env.NO_PW_PROOF === "1"),
  };
}

export function ownerLockCost(o: OwnerLockOptions, cases: OwnerLockCase[] = OWNER_LOCK_CASES) {
  const openers = o.open ? cases.filter((c) => "signer" in c.lock).length : 0;
  return {
    openers,
    /** Out of the funder for the run, swept back at the end (less fees). */
    lent: BigInt(openers) * OWNER_FUNDING,
    /** Left under PW-Lock args nobody holds a key for. */
    spent: o.pwProof ? PW_CELL + PW_TOP_UP : 0n,
  };
}

// --- pool lag (smoke:pool-lag) ---------------------------------------------

/** How each RPC call reaches the node: Node's fetch, one kept-alive socket, or a new socket per call. */
export type PoolLagMode = "fetch" | "pinned" | "fresh";
export const POOL_LAG_MODES: readonly PoolLagMode[] = ["fetch", "pinned", "fresh"];

export interface PoolLagOptions {
  sends: number;
  intervalMs: number;
  timeoutMs: number;
  modes: PoolLagMode[];
}

export function poolLagOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): PoolLagOptions {
  const flag = argv.find((a) => a.startsWith("--modes="));
  const raw = flag ? flag.slice("--modes=".length) : env.MODES || "fetch,pinned";
  const modes = raw.split(",").map((m) => m.trim()).filter(Boolean);
  const bad = modes.filter((m) => !POOL_LAG_MODES.includes(m as PoolLagMode));
  if (!modes.length || bad.length) throw new RangeError(`modes (--modes= or MODES) must be a list of ${POOL_LAG_MODES.join(", ")}, got ${raw}`);
  return {
    sends: intOption("sends", "SENDS", argv, env, 10, 1, 50),
    intervalMs: intOption("interval", "INTERVAL_MS", argv, env, 50, 10, 1000),
    timeoutMs: intOption("timeout", "TIMEOUT_MS", argv, env, 10_000, 1000, 60_000),
    modes: [...new Set(modes)] as PoolLagMode[],
  };
}

/** One poll after a send: ms since send_transaction answered, get_live_cell (include_tx_pool) status, who answered. */
export interface PoolPoll {
  ms: number;
  status: string;
  node?: string;
}

export interface PoolLagSend {
  /** node_id that answered send_transaction (same HTTP request, JSON-RPC batch). */
  sendNode?: string;
  polls: PoolPoll[];
}

export interface PoolLagResult {
  /** ms until the first poll that no longer shows the input live; undefined if it never did. */
  firstGone?: number;
  /** ms from which every later poll showed it not live; undefined if the last poll still showed it live. */
  settled?: number;
  /** A poll showed it live again after one showed it gone (two views of the pool). */
  flipped: boolean;
  /** Polls answered by another node than the one that took the send. */
  otherNodePolls: number;
  /** Polls whose answer showed the input live, by answering node: same node as the send, or another. */
  liveOnSendNode: number;
  liveOnOtherNode: number;
  nodes: string[];
}

export function poolLagResult(send: PoolLagSend): PoolLagResult {
  // A poll that failed (status "error") says nothing either way and is left out.
  const gone = (p: PoolPoll) => p.status !== "live";
  const polls = send.polls.filter((p) => p.status !== "error");
  const first = polls.findIndex(gone);
  let lastLive = -1;
  polls.forEach((p, i) => {
    if (!gone(p)) lastLive = i;
  });
  const other = (p: PoolPoll) => send.sendNode !== undefined && p.node !== undefined && p.node !== send.sendNode;
  return {
    firstGone: first === -1 ? undefined : polls[first].ms,
    settled: lastLive === polls.length - 1 ? undefined : (polls[lastLive + 1]?.ms ?? undefined),
    flipped: first !== -1 && lastLive > first,
    otherNodePolls: polls.filter(other).length,
    liveOnSendNode: polls.filter((p) => !gone(p) && !other(p)).length,
    liveOnOtherNode: polls.filter((p) => !gone(p) && other(p)).length,
    nodes: [...new Set(polls.map((p) => p.node).filter((n): n is string => !!n))],
  };
}

/** Median and max of the defined values (ms), for the summary line. */
export function msStats(values: (number | undefined)[]): { n: number; median?: number; max?: number } {
  const v = values.filter((x): x is number => x !== undefined).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const mid = Math.floor(v.length / 2);
  return { n: v.length, median: v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2), max: v[v.length - 1] };
}
