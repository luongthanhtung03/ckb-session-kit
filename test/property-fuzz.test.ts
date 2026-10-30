/**
 * Differential fuzzing of the session lock against an independent model of its
 * documented rules (test/fuzz/harness.ts `model`), in the real CKB-VM.
 *
 * 1. Random transactions around one session lock: random args (valid layouts,
 *    boundary-heavy numbers), random group inputs (capacities, types, data
 *    lengths, since values), random outputs under the locks that matter. The lock
 *    must return exactly the model's code.
 * 2. Random args bytes of random length: the lock must give a defined error code
 *    (never a VM fault), and the model's code.
 *
 * Seeded: FUZZ_SEED and FUZZ_SCALE in the environment change the run; a failure
 * names the seed of its case, which `FUZZ_SEED=<seed> FUZZ_ONE=1` replays alone.
 */
import { ccc } from "@ckb-ccc/core";
import { describe, expect, it } from "vitest";
import { CKB, Cells, compare, DEPLOYMENT, Rng, SCALE, SEED, skipLock, U128_MAX, U64_MAX } from "./fuzz/harness.js";

const ONE = !!process.env.FUZZ_ONE;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;
const plain = (args: string) => ccc.Script.from({ codeHash: h("aa"), hashType: "type", args });
const OWNER = plain("0x01");
const KEY = plain("0x02");
const RECIPIENT = plain("0x03");
const STRANGER = plain("0x04");
const TOKEN = plain("0x7171");
const OTHER_TYPE = plain("0x7070");

const u64le = (v: bigint) => ccc.numLeToBytes(v, 8);
const u128le = (v: bigint) => ccc.numLeToBytes(v, 16);
const relativeBlocks = (n: bigint) => (1n << 63n) | n;
/** An input with a raw since: CCC's parser refuses flag patterns it has no name for, the lock must not. */
const withSince = (cell: ccc.Cell, since: bigint) => {
  const input = ccc.CellInput.from({ previousOutput: cell.outPoint });
  input.since = since;
  return input;
};

interface Case {
  args: Uint8Array;
  hashType: ccc.HashType;
}

function randomArgs(r: Rng): Case {
  const token = r.bool(0.45);
  const recipient = r.bool(0.5);
  const ownerHash = r.bool(0.05) ? KEY.hash() : OWNER.hash();
  const recipientHash = r.pick([RECIPIENT.hash(), RECIPIENT.hash(), RECIPIENT.hash(), OWNER.hash(), KEY.hash()]);
  const args = ccc.bytesConcat(
    ownerHash,
    KEY.hash(),
    u64le(r.edgy(0n, U64_MAX, [61n * CKB, 100n * CKB, 1n])),
    u64le(r.bool(0.4) ? 0n : r.edgy(0n, U64_MAX, [1n, 10n, (1n << 56n) - 1n, 1n << 56n])),
    ...(token ? [TOKEN.hash(), u128le(r.edgy(0n, U128_MAX, [1n, 1000n, U64_MAX]))] : []),
    ...(recipient ? [recipientHash] : []),
  );
  // Not "data" (VM version 0): the binary does not load there at all (see the last test).
  return { args, hashType: r.pick(["data2", "data2", "data2", "data1"] as const) };
}

const capacity = (r: Rng) =>
  r.bool(0.08) ? r.edgy(U64_MAX - 1000n * CKB, U64_MAX) : r.edgy(0n, 2000n * CKB, [61n * CKB, 100n * CKB, 500n * CKB]);

function typeAndData(r: Rng, tokenWeight: number): { type?: ccc.Script; data: Uint8Array } {
  const roll = r.float();
  const len = r.pick([16, 16, 16, 0, 15, 17, 32]);
  const amount = r.bool(0.1) ? r.edgy(U128_MAX - 1000n, U128_MAX) : r.edgy(0n, 5000n, [1000n]);
  const data = len >= 16 ? ccc.bytesConcat(u128le(amount), r.bytes(len - 16)) : r.bytes(len);
  if (roll < tokenWeight) return { type: TOKEN, data };
  if (roll < tokenWeight + 0.06) return { type: OTHER_TYPE, data };
  // An untyped cell may carry data too (the lock must never read an amount from it).
  return { data: r.bool(0.1) ? data : new Uint8Array() };
}

function randomSince(r: Rng, minInterval: bigint): bigint {
  const roll = r.float();
  if (roll < 0.15) return 0n;
  if (roll < 0.6) return relativeBlocks(r.edgy(0n, (1n << 56n) - 1n, [minInterval]));
  if (roll < 0.75) return r.big(0n, U64_MAX); // any flags
  // The right value with one flag bit wrong, or a value bit above 56 set.
  const bit = r.pick([56n, 57n, 58n, 59n, 60n, 61n, 62n, 63n]);
  return (relativeBlocks(minInterval & ((1n << 56n) - 1n)) ^ (1n << bit)) & U64_MAX;
}

async function randomTxCase(seed: number) {
  const r = new Rng(seed);
  const cells = new Cells(r);
  const { args, hashType } = randomArgs(r);
  const session = ccc.Script.from({ codeHash: DEPLOYMENT.codeHash, hashType, args: ccc.hexFrom(args) });
  const sibling = ccc.Script.from({ ...session, args: ccc.hexFrom(ccc.bytesConcat(args.slice(0, 64), u64le(r.big(0n, U64_MAX)), args.slice(72))) });
  const minInterval = ccc.numLeFromBytes(args.slice(72, 80));
  const maxPerTx = ccc.numLeFromBytes(args.slice(64, 72));
  const hasToken = args.length >= 128;

  const tx = ccc.Transaction.default();
  const addInput = (lock: ccc.Script, tokenWeight: number, since = 0n) => {
    const { type, data } = typeAndData(r, tokenWeight);
    const cell = cells.add({ lock, capacity: capacity(r), type, data: ccc.hexFrom(data) });
    tx.inputs.push(withSince(cell, since));
    return cell;
  };
  const groupCount = r.int(1, 3);
  let spent = 0n;
  for (let i = 0; i < groupCount; i++) {
    spent += addInput(session, hasToken ? 0.6 : 0.08, randomSince(r, minInterval)).cellOutput.capacity;
  }
  if (r.bool(0.85)) addInput(KEY, hasToken ? 0.25 : 0.05);
  if (r.bool(0.08)) addInput(OWNER, 0.05);
  if (r.bool(0.1)) addInput(STRANGER, 0.1);
  if (r.bool(0.1)) addInput(RECIPIENT, 0.1);
  if (r.bool(0.1)) addInput(sibling, 0.3, randomSince(r, minInterval));
  // Input order should never matter to the lock: shuffle.
  for (let i = tx.inputs.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [tx.inputs[i], tx.inputs[j]] = [tx.inputs[j], tx.inputs[i]];
  }

  const outCount = r.int(0, 4);
  for (let i = 0; i < outCount; i++) {
    const lock = r.pick([session, session, KEY, RECIPIENT, OWNER, STRANGER, sibling]);
    const { type, data } = typeAndData(r, hasToken ? 0.5 : 0.05);
    let cap = capacity(r);
    // Change near the outflow boundary.
    if (lock === session && r.bool(0.6)) {
      const out = r.pick([maxPerTx, maxPerTx + 1n, maxPerTx === 0n ? 0n : maxPerTx - 1n, 0n]);
      cap = spent > out ? spent - out : r.big(spent, spent + 10n);
    }
    tx.outputs.push(ccc.CellOutput.from({ lock, capacity: cap & U64_MAX, ...(type && { type }) }));
    tx.outputsData.push(ccc.hexFrom(data));
  }
  return { cells, tx };
}

async function randomArgsCase(seed: number) {
  const r = new Rng(seed);
  const cells = new Cells(r);
  const lengths = [0, 1, 32, 64, 79, 80, 81, 111, 112, 113, 127, 128, 129, 159, 160, 161, 200, 203, 204, 205, 220];
  const len = r.bool(0.8) ? r.pick(lengths) : r.int(0, 230);
  const args = r.bytes(len);
  // Sometimes make the owner or the key field real, so the parse is followed by more of the script.
  if (len >= 32 && r.bool(0.3)) args.set(ccc.bytesFrom(OWNER.hash()), 0);
  if (len >= 64 && r.bool(0.5)) args.set(ccc.bytesFrom(KEY.hash()), 32);
  const session = ccc.Script.from({ codeHash: DEPLOYMENT.codeHash, hashType: "data2", args: ccc.hexFrom(args) });
  const tx = ccc.Transaction.default();
  for (const lock of [session, ...(r.bool(0.7) ? [KEY] : []), ...(r.bool(0.2) ? [OWNER] : [])]) {
    const t = r.bool(0.2) ? TOKEN : undefined;
    const cell = cells.add({ lock, capacity: r.edgy(0n, U64_MAX, [100n * CKB]), type: t, data: t ? r.hex(r.pick([0, 16, 17])) : "0x" });
    tx.inputs.push(withSince(cell, r.bool() ? relativeBlocks(r.big(0n, 100n)) : 0n));
  }
  tx.outputs.push(ccc.CellOutput.from({ lock: r.pick([session, STRANGER, KEY]), capacity: r.edgy(0n, 200n * CKB) }));
  tx.outputsData.push("0x");
  return { cells, tx };
}

async function sweep(name: string, base: number, count: number, make: (seed: number) => Promise<{ cells: Cells; tx: ccc.Transaction }>) {
  const failures: string[] = [];
  const codes = new Map<number, number>();
  const seeds = ONE ? [SEED] : Array.from({ length: count }, (_, i) => base + i);
  for (const seed of seeds) {
    const { cells, tx } = await make(seed);
    const { problems, runs } = await compare(cells, tx);
    for (const r of runs) codes.set(r.code, (codes.get(r.code) ?? 0) + 1);
    if (problems.length) failures.push(`${name} seed ${seed}: ${problems.join("; ")}`);
  }
  return { failures, codes };
}

describe.skipIf(skipLock)("session lock, differential fuzzing against the documented rules", () => {
  it("random transactions: the lock returns the model's code", { timeout: 300_000 }, async () => {
    const { failures, codes } = await sweep("tx", SEED, Math.round(1200 * SCALE), randomTxCase);
    console.log("tx fuzz codes:", Object.fromEntries([...codes].sort((a, b) => a[0] - b[0])));
    expect(failures).toEqual([]);
    // The generator must reach every rule, or the property says little.
    if (!ONE) for (const c of [0, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) if (c !== 10) expect(codes.get(c) ?? 0).toBeGreaterThan(0);
  });

  it("random args bytes: only defined codes, never a VM fault", { timeout: 300_000 }, async () => {
    const { failures, codes } = await sweep("args", SEED + 1_000_000, Math.round(400 * SCALE), randomArgsCase);
    console.log("args fuzz codes:", Object.fromEntries([...codes].sort((a, b) => a[0] - b[0])));
    expect(failures).toEqual([]);
    if (!ONE) for (const c of [0, 10, 11]) expect(codes.get(c) ?? 0).toBeGreaterThan(0);
  });

  it("finding (info): under hash_type data (CKB-VM version 0) the lock faults before running, owner mode included", async () => {
    // Minimal case: owner mode, which must accept anything. Under data2 and data1 it does.
    const r = new Rng(1);
    const cells = new Cells(r);
    const args = ccc.bytesConcat(OWNER.hash(), KEY.hash(), u64le(100n * CKB), u64le(0n));
    const results: Record<string, number> = {};
    for (const hashType of ["data2", "data1", "data"] as const) {
      const session = ccc.Script.from({ codeHash: DEPLOYMENT.codeHash, hashType, args: ccc.hexFrom(args) });
      const tx = ccc.Transaction.default();
      for (const lock of [session, OWNER]) tx.inputs.push(withSince(cells.add({ lock, capacity: 200n * CKB }), 0n));
      tx.outputs.push(ccc.CellOutput.from({ lock: OWNER, capacity: 400n * CKB }));
      tx.outputsData.push("0x");
      const [run] = await cells.run(tx);
      results[hashType] = run.code;
      if (hashType === "data") expect(run.stdout).toMatch(/memory error: write on executable page/);
    }
    expect(results).toEqual({ data2: 0, data1: 0, data: Number.NaN });
  });
});
