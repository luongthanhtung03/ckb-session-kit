/**
 * Property-test harness: a seeded random generator, a fake chain the library
 * builds real transactions against, a runner that executes the session lock
 * binary on any transaction in CKB-VM (ckb-testtool + ckb-debugger), and an
 * independent model of the lock's rules (from the doc comment in
 * contracts/session-lock/src/main.rs) to compare the lock against.
 *
 * Only the session lock's own script groups run: the other locks (secp256k1,
 * anyone-can-pay) and xUDT verify signatures and token totals, which the session
 * lock delegates and never reads. So the cell deps of a library transaction are
 * replaced by the session lock's code alone.
 */
import { ccc } from "@ckb-ccc/core";
import { filterCell } from "@ckb-ccc/core/advanced";
import { Resource, Verifier } from "ckb-testtool";
import { existsSync, readFileSync } from "node:fs";
import { TESTNET_DEPLOYMENT } from "../../src/lock.js";

export const BINARY = "contracts/session-lock/target/riscv64imac-unknown-none-elf/release/session-lock";
export const skipLock = !existsSync(BINARY) && !process.env.REQUIRE_LOCK_TESTS;
export const CKB = 100_000_000n;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;

/** Base seed; override with FUZZ_SEED=<n> to explore, a failure prints the seed of its case. */
export const SEED = Number(process.env.FUZZ_SEED ?? 20261030);
/** Scale every property's case count (FUZZ_SCALE=4 for a longer run). */
export const SCALE = Number(process.env.FUZZ_SCALE ?? 1);

/** Codes the lock defines (main.rs `Error`), and 0. Anything else is a crash. */
export const DEFINED_CODES = new Set([0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

// ---------------------------------------------------------------------------
// Seeded randomness (xorshift128+, BigInt-free core for speed).

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  constructor(readonly seed: number) {
    // splitmix32 to spread the seed
    let x = seed >>> 0;
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next() | 1;
  }
  /** xoshiro128** */
  u32(): number {
    const r = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return r;
  }
  float(): number {
    return this.u32() / 2 ** 32;
  }
  int(lo: number, hi: number): number {
    return lo + (this.u32() % (hi - lo + 1));
  }
  bool(p = 0.5): boolean {
    return this.float() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.u32() % xs.length];
  }
  bytes(n: number): Uint8Array {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = this.u32() & 0xff;
    return b;
  }
  /** A uniform bigint in [lo, hi]. */
  big(lo: bigint, hi: bigint): bigint {
    if (hi <= lo) return lo;
    const span = hi - lo + 1n;
    let r = 0n;
    for (let bits = 0n; bits < BigInt(span.toString(2).length) + 32n; bits += 32n) r = (r << 32n) | BigInt(this.u32());
    return lo + (r % span);
  }
  /** Mostly boundary values near lo, hi and a few anchors; else uniform. */
  edgy(lo: bigint, hi: bigint, anchors: bigint[] = []): bigint {
    const inRange = anchors.filter((a) => a >= lo && a <= hi);
    const r = this.float();
    if (r < 0.15) return lo;
    if (r < 0.3) return hi;
    if (r < 0.4 && lo + 1n <= hi) return lo + 1n;
    if (r < 0.5 && hi - 1n >= lo) return hi - 1n;
    if (r < 0.65 && inRange.length) {
      const a = this.pick(inRange);
      const d = this.pick([-1n, 0n, 0n, 1n]);
      return a + d < lo ? lo : a + d > hi ? hi : a + d;
    }
    return this.big(lo, hi);
  }
  hex(n: number): ccc.Hex {
    return ccc.hexFrom(this.bytes(n));
  }
}
const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

// ---------------------------------------------------------------------------
// Running the session lock in CKB-VM.

type TtTransaction = Parameters<Resource["deployCell"]>[1];
const LOCK_CODE = existsSync(BINARY) ? ccc.hexFrom(readFileSync(BINARY)) : "0x";
export const LOCK_CODE_HASH = ccc.hashCkb(LOCK_CODE);
export const DEPLOYMENT = TESTNET_DEPLOYMENT;
if (!skipLock && LOCK_CODE_HASH !== DEPLOYMENT.codeHash) {
  throw new Error("the built session lock is not the deployed one: run npm run check:lock-hash");
}
const DEP_OUT_POINT = ccc.OutPoint.from(DEPLOYMENT.cellDep.outPoint);
const opKey = (op: ccc.OutPointLike) => ccc.OutPoint.from(op).toBytes().toString();

/** Any script running the session lock's code (data, data1 or data2: the VM version differs, the rules must not). */
export const isSessionLock = (s: ccc.Script) => s.codeHash === ccc.hexFrom(DEPLOYMENT.codeHash) && s.hashType !== "type";

export interface LockRun {
  lockHash: ccc.Hex;
  hashType: ccc.HashType;
  argsLength: number;
  code: number;
  /** ckb-debugger's process status (0 = script returned 0). */
  status: number | null;
  stdout: string;
}

/** A cell store shared by the fake client and the VM runner. */
export class Cells {
  readonly resource = Resource.default();
  private readonly ages = new Map<string, bigint>();
  constructor(private readonly rng: Rng) {
    const dep = ccc.Cell.from({
      outPoint: DEP_OUT_POINT,
      cellOutput: { lock: ccc.Script.from({ codeHash: "0x" + "00".repeat(32), hashType: "data", args: "0x" }), capacity: 0n },
      outputData: LOCK_CODE,
    });
    this.resource.cells.set(opKey(DEP_OUT_POINT), dep as never);
  }
  /** A live cell, `age` blocks old. */
  add(o: { lock: ccc.ScriptLike; capacity: bigint; type?: ccc.ScriptLike; data?: ccc.HexLike; age?: bigint }): ccc.Cell {
    const cell = ccc.Cell.from({
      outPoint: { txHash: this.rng.hex(32), index: this.rng.int(0, 3) },
      cellOutput: { lock: o.lock, capacity: o.capacity, ...(o.type && { type: o.type }) },
      outputData: o.data ?? "0x",
    });
    this.resource.cells.set(opKey(cell.outPoint), cell as never);
    this.ages.set(cell.outPoint.txHash, o.age ?? 1_000_000n);
    return cell;
  }
  get(op: ccc.OutPointLike): ccc.Cell | undefined {
    return this.resource.cells.get(opKey(op)) as unknown as ccc.Cell | undefined;
  }
  live(): ccc.Cell[] {
    return [...this.resource.cells.values()].map((c) => c as unknown as ccc.Cell).filter((c) => !c.outPoint.eq(DEP_OUT_POINT));
  }
  age(txHash: ccc.Hex): bigint | undefined {
    return this.ages.get(txHash);
  }

  /**
   * Runs every session-lock group among `tx`'s inputs in CKB-VM. Inputs must be
   * cells of this store. Cell deps become the session lock's code alone.
   */
  async run(txLike: ccc.TransactionLike): Promise<LockRun[]> {
    // A shallow copy, not clone(): CCC's clone re-parses each since and refuses flag patterns it has no name for.
    const src = ccc.Transaction.from(txLike);
    const tx: ccc.Transaction = Object.assign(Object.create(Object.getPrototypeOf(src)), src, {
      cellDeps: [ccc.CellDep.from({ outPoint: DEP_OUT_POINT, depType: "code" })],
    });
    const groups: ccc.Hex[] = [];
    const scripts = new Map<ccc.Hex, ccc.Script>();
    for (const i of tx.inputs) {
      const cell = this.get(i.previousOutput);
      if (!cell) throw new Error(`input ${i.previousOutput.txHash}:${i.previousOutput.index} is not in the store`);
      const lock = cell.cellOutput.lock;
      if (isSessionLock(lock) && !groups.includes(lock.hash())) {
        groups.push(lock.hash());
        scripts.set(lock.hash(), lock);
      }
    }
    const verifier = Verifier.from(this.resource, tx as unknown as TtTransaction);
    const out: LockRun[] = [];
    for (const lockHash of groups) {
      for (const r of await verifier.verify({ codeHash: lockHash })) {
        let code: number;
        if (r.status === 0) code = 0;
        else {
          const m = r.stdout.match(/Run result: (-?\d+)/);
          code = m ? Number(m[1]) : Number.NaN;
        }
        const s = scripts.get(lockHash)!;
        out.push({ lockHash, hashType: s.hashType, argsLength: ccc.bytesFrom(s.args).length, code, status: r.status, stdout: r.stdout + r.stderr });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// A fake chain for the library: indexer, cells, tip and fee rate over `Cells`.

export const TIP = 1n << 57n; // beyond any min_interval a since can hold (2^56 - 1)

export function fakeClient(cells: Cells) {
  const sent: ccc.Transaction[] = [];
  const base = new ccc.ClientPublicTestnet();
  const find = async function* (key: Parameters<typeof filterCell>[0]) {
    for (const c of cells.live()) if (filterCell(key, c)) yield c;
  };
  const client = Object.assign(base, {
    findCells: find,
    findCellsOnChain: find,
    async *findTransactionsByLock() {},
    getCell: async (op: ccc.OutPointLike) => cells.get(op),
    getCellLive: async (op: ccc.OutPointLike) => cells.get(op),
    getTip: async () => TIP,
    getFeeRate: async () => 1000n,
    getTransaction: async (hash: ccc.HexLike) => {
      const age = cells.age(ccc.hexFrom(hash));
      if (age === undefined) return undefined;
      return { blockNumber: TIP - age, status: "committed", transaction: ccc.Transaction.default() };
    },
    sendTransaction: async (tx: ccc.TransactionLike) => {
      const t = ccc.Transaction.from(tx);
      sent.push(t);
      return t.hash();
    },
  });
  return { client: client as unknown as ccc.Client, sent };
}

// ---------------------------------------------------------------------------
// The model: what the lock should return, per its documented rules.

export interface ModelCell {
  lockHash: ccc.Hex;
  typeHash?: ccc.Hex;
  data: Uint8Array;
  capacity: bigint;
  since?: bigint;
}

const hexAt = (b: Uint8Array, at: number) => ccc.hexFrom(b.slice(at, at + 32));
const leAt = (b: Uint8Array, at: number, n: number) => ccc.numLeFromBytes(b.slice(at, at + n));

/**
 * The exit code the session lock should give for its group `ownHash` (whose
 * args are `args`). Rule order follows main.rs, so the first broken rule's code
 * is the one expected.
 */
export function model(args: Uint8Array, ownHash: ccc.Hex, inputs: ModelCell[], outputs: ModelCell[]): number {
  const layout = ({ 80: [false, false], 112: [false, true], 128: [true, false], 160: [true, true] } as const)[
    args.length as 80
  ];
  // A Script over 256 bytes (args over 203) does not fit the lock's buffer: also bad args.
  if (!layout) return 10;
  const [hasToken, hasRecipient] = layout;
  const owner = hexAt(args, 0);
  const key = hexAt(args, 32);
  const maxPerTx = leAt(args, 64, 8);
  const minInterval = leAt(args, 72, 8);
  const token = hasToken ? { typeHash: hexAt(args, 80), max: leAt(args, 112, 16) } : undefined;
  const recipient = hasRecipient ? hexAt(args, hasToken ? 128 : 80) : undefined;

  let ownerPresent = false;
  let keyPresent = false;
  for (const i of inputs) {
    if (i.lockHash === owner) ownerPresent = true;
    if (i.lockHash === key) keyPresent = true;
  }
  // key_in saturates (it is summed before the owner-mode return); with the
  // documented checked sums elsewhere, a u64 overflow of the key cells' total can
  // never be reached on-chain anyway (total supply is far below 2^64).
  let keyIn = 0n;
  if (recipient) for (const i of inputs) if (i.lockHash === key) keyIn = keyIn + i.capacity > U64_MAX ? U64_MAX : keyIn + i.capacity;
  if (ownerPresent) return 0;
  if (!keyPresent) return 11;

  const group = inputs.filter((i) => i.lockHash === ownHash);
  type Held = { kind: "untyped" } | { kind: "token"; amount?: bigint; len: number } | { kind: "other" };
  const held = (c: ModelCell): Held => {
    if (!c.typeHash) return { kind: "untyped" };
    if (!token || c.typeHash !== token.typeHash) return { kind: "other" };
    return { kind: "token", len: c.data.length, ...(c.data.length >= 16 && { amount: leAt(c.data, 0, 16) }) };
  };

  let tokenIn = 0n;
  for (const c of group) {
    const h = held(c);
    if (!token) {
      if (h.kind !== "untyped") return 18;
      continue;
    }
    if (h.kind === "other") return 18;
    if (h.kind === "token") {
      if (h.amount === undefined) return 19;
      tokenIn += h.amount;
      if (tokenIn > U128_MAX) return 15;
    }
  }
  if (minInterval > 0n) {
    for (const c of group) {
      const s = c.since ?? 0n;
      const relativeBlocks = s >> 61n === 0b100n;
      if (!relativeBlocks || (s & ((1n << 56n) - 1n)) < minInterval) return 14;
    }
  }
  let spent = 0n;
  for (const c of group) {
    spent += c.capacity;
    if (spent > U64_MAX) return 15;
  }
  let change = 0n;
  let changeCells = 0;
  let keyOut = 0n;
  let tokenChange = 0n;
  let keyTokenOut = 0n;
  for (const o of outputs) {
    const h = held(o);
    if (o.lockHash === ownHash) {
      if (++changeCells > 1) return 16;
      if (!token) {
        if (h.kind !== "untyped") return 18;
      } else if (h.kind === "other") return 18;
      else if (h.kind === "token") {
        if (h.len !== 16) return 19;
        tokenChange = h.amount!;
      }
      change += o.capacity;
      if (change > U64_MAX) return 15;
    } else if (recipient) {
      if (o.lockHash === key) {
        keyOut += o.capacity;
        if (keyOut > U64_MAX) return 15;
        if (token && h.kind === "token") {
          if (h.amount === undefined) return 19;
          keyTokenOut += h.amount;
          if (keyTokenOut > U128_MAX) return 15;
        }
      } else if (o.lockHash !== recipient && o.lockHash !== owner) {
        return 13;
      } else if (token ? h.kind === "other" : h.kind !== "untyped") {
        return 18;
      }
    }
  }
  if (keyOut > keyIn) return 17;
  if (spent - change > maxPerTx) return 12;
  if (token) {
    if (recipient) {
      let keyTokenIn = 0n;
      for (const i of inputs) {
        if (i.lockHash !== key) continue;
        const h = held(i);
        if (h.kind === "token" && h.amount !== undefined) {
          keyTokenIn += h.amount;
          if (keyTokenIn > U128_MAX) return 15;
        }
      }
      if (keyTokenOut > keyTokenIn) return 17;
    }
    if (tokenIn - tokenChange > token.max) return 20;
  }
  return 0;
}

/** The model's view of a transaction whose inputs are in `cells`. */
export function modelOf(cells: Cells, txLike: ccc.TransactionLike): { inputs: ModelCell[]; outputs: ModelCell[] } {
  const tx = ccc.Transaction.from(txLike);
  const inputs = tx.inputs.map((i) => {
    const c = cells.get(i.previousOutput)!;
    return {
      lockHash: c.cellOutput.lock.hash(),
      typeHash: c.cellOutput.type?.hash(),
      data: ccc.bytesFrom(c.outputData),
      capacity: c.cellOutput.capacity,
      since: i.since,
    };
  });
  const outputs = tx.outputs.map((o, k) => ({
    lockHash: o.lock.hash(),
    typeHash: o.type?.hash(),
    data: ccc.bytesFrom(tx.outputsData[k] ?? "0x"),
    capacity: o.capacity,
  }));
  return { inputs, outputs };
}

/** Expected code for every session-lock group of `tx`, from the model. */
export function expected(cells: Cells, tx: ccc.TransactionLike): Map<ccc.Hex, number> {
  const { inputs, outputs } = modelOf(cells, tx);
  const out = new Map<ccc.Hex, number>();
  for (const i of ccc.Transaction.from(tx).inputs) {
    const lock = cells.get(i.previousOutput)!.cellOutput.lock;
    if (!isSessionLock(lock) || out.has(lock.hash())) continue;
    out.set(lock.hash(), model(ccc.bytesFrom(lock.args), lock.hash(), inputs, outputs));
  }
  return out;
}

/** Runs `tx` in CKB-VM and in the model; returns a description of every disagreement or crash. */
export async function compare(cells: Cells, tx: ccc.TransactionLike): Promise<{ problems: string[]; runs: LockRun[]; want: Map<ccc.Hex, number> }> {
  const runs = await cells.run(tx);
  const want = expected(cells, tx);
  const problems: string[] = [];
  for (const r of runs) {
    if (!DEFINED_CODES.has(r.code)) problems.push(`CRASH group ${r.lockHash} (${r.hashType}, args ${r.argsLength} B): status ${r.status}, code ${r.code}\n${r.stdout.slice(-600)}`);
    else if (r.code !== want.get(r.lockHash)) problems.push(`lock ${r.code} != model ${want.get(r.lockHash)} for group ${r.lockHash} (${r.hashType}, args ${r.argsLength} B)`);
  }
  return { problems, runs, want };
}
