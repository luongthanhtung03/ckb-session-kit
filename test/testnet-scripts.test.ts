// The testnet scripts' offline parts: options, plans, the contention analysis,
// rejection texts, derived keys, and each script's --dry-run (no key, no network).
import { ccc } from "@ckb-ccc/core";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MAX_SUBSCRIPTION_CELLS, subscriptionLock, TESTNET_DEPLOYMENT } from "../src/index.js";
import {
  analyseRound,
  CKB,
  classifyRejection,
  clearOptions,
  contentionCost,
  contentionOptions,
  deriveKey,
  logPath,
  plantPlan,
  type PayerRound,
} from "../scripts/testnet-lib.js";

describe("script options", () => {
  it("contention: defaults, flags over env, bounds", () => {
    expect(contentionOptions([], {})).toEqual({ payers: 4, rounds: 2, cells: 8 });
    expect(contentionOptions(["--payers=6"], { PAYERS: "3", ROUNDS: "1" })).toEqual({ payers: 6, rounds: 1, cells: 8 });
    expect(() => contentionOptions(["--payers=1"], {})).toThrow(RangeError);
    expect(() => contentionOptions([], { ROUNDS: "6" })).toThrow(/rounds/);
    expect(() => contentionOptions([], { CELLS: "65" })).toThrow(/1 to 64/);
    expect(() => contentionOptions(["--cells=x"], {})).toThrow(RangeError);
  });

  it("clear-planted: a period of 10 to 1000 blocks, 30 by default", () => {
    expect(clearOptions([], {})).toEqual({ period: 30 });
    expect(clearOptions(["--period=12"], {})).toEqual({ period: 12 });
    expect(clearOptions([], { PERIOD_BLOCKS: "50" })).toEqual({ period: 50 });
    expect(() => clearOptions(["--period=5"], {})).toThrow(RangeError);
  });

  it("LOG=1 names a dated file under docs/evidence; LOG=<path> is that path", () => {
    const now = new Date("2026-11-03T10:00:00Z");
    expect(logPath("smoke-contention", "1", now)).toBe("docs/evidence/2026-11-03-smoke-contention.log");
    expect(logPath("x", "out/run.log", now)).toBe("out/run.log");
    expect(logPath("x", undefined, now)).toBeUndefined();
    expect(logPath("x", "0", now)).toBeUndefined();
  });
});

describe("plans and costs", () => {
  it("a subscription cell holds 153 CKB at least, so 16 planted cells lock 2448 CKB", () => {
    const sub = {
      subscriberLockHash: ccc.hexFrom(new Uint8Array(32).fill(1)),
      chargerLockHash: ccc.hexFrom(new Uint8Array(32).fill(2)),
      payToLockHash: ccc.hexFrom(new Uint8Array(32).fill(3)),
      price: 10n * CKB,
      periodBlocks: 30n,
    };
    const size = ccc.CellOutput.from({ lock: subscriptionLock(TESTNET_DEPLOYMENT, sub) }, "0x").capacity;
    expect(size).toBe(153n * CKB);
    expect(plantPlan(1, size, MAX_SUBSCRIPTION_CELLS)).toEqual({ count: 16, locked: 2448n * CKB });
    expect(plantPlan(3, size, MAX_SUBSCRIPTION_CELLS).count).toBe(14);
    expect(plantPlan(40, size, MAX_SUBSCRIPTION_CELLS).count).toBe(1);
  });

  it("contention: lent, new payout cells and payments", () => {
    const o = { payers: 4, rounds: 2, cells: 8 };
    expect(contentionCost(o, 3)).toEqual({ lent: 1300n * CKB, payoutCells: 305n * CKB, created: 5, paid: 9n * CKB });
    expect(contentionCost(o, 10).created).toBe(0);
  });
});

describe("derived keys", () => {
  const seed = ccc.hexFrom(new Uint8Array(32).fill(7));
  it("are the same on every run, differ by label and index, and are valid secp256k1 keys", () => {
    const a = deriveKey(seed, "contention-payer", 1);
    expect(deriveKey(seed, "contention-payer", 1)).toBe(a);
    expect(deriveKey(seed, "contention-payer", 2)).not.toBe(a);
    expect(deriveKey(seed, "contention-session", 1)).not.toBe(a);
    expect(a).not.toBe(seed);
    expect(() => new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), a)).not.toThrow();
  });
});

describe("node rejections", () => {
  const op = "0x" + "ab".repeat(36);
  it.each([
    [`ErrorClientBase code -301: TransactionFailedToResolve: Resolve failed Dead(OutPoint(${op}))`, "dead"],
    [`ErrorClientBase code -301: TransactionFailedToResolve: Resolve failed Unknown(OutPoint(${op}))`, "unknown"],
    ["ErrorClientRBFRejected code -1111: PoolRejectedRBF: RBF rejected: Tx's current fee is 1000, expect it to >= 2500 to replace old txs", "rbf"],
    ["ErrorClientBase code -1111: something new", "rbf"],
    ["ErrorClientDuplicatedTransaction code -1107: PoolRejectedDuplicatedTransaction", "duplicated"],
    ["Error: fetch failed", "other"],
  ] as const)("%s → %s", (text, kind) => expect(classifyRejection(text)).toBe(kind));
});

describe("analyseRound", () => {
  const h = (n: number) => ccc.hexFrom(new Uint8Array(32).fill(n));
  const payer = (payer: number, sends: { cell: string; error?: string }[], committed = true): PayerRound => ({
    payer,
    sends: sends.map((s, i) => ({ hash: h(payer * 10 + i), ...s })),
    checks: 4,
    taken: 0,
    final: committed ? h(payer * 10 + sends.length - 1) : undefined,
    committed,
  });

  it("no two payers on one cell: ok, no collision", () => {
    const a = analyseRound([payer(1, [{ cell: "c1" }]), payer(2, [{ cell: "c2" }])]);
    expect(a).toMatchObject({ ok: true, firstCollisions: [], retriedToSuccess: [], failed: [] });
  });

  it("a collision refused and retried to another cell: ok", () => {
    const a = analyseRound([payer(1, [{ cell: "c1" }]), payer(2, [{ cell: "c1", error: "Dead(OutPoint(" }, { cell: "c3" }])]);
    expect(a.ok).toBe(true);
    expect(a.firstCollisions).toEqual([{ cell: "c1", payers: [1, 2] }]);
    expect(a.retriedToSuccess).toEqual([2]);
  });

  it("a payer that never committed fails the round", () => {
    const a = analyseRound([payer(1, [{ cell: "c1" }]), payer(2, [{ cell: "c1", error: "RBFRejected" }], false)]);
    expect(a.ok).toBe(false);
    expect(a.failed).toEqual([2]);
  });

  it("two accepted sends on one cell are flagged", () => {
    const a = analyseRound([payer(1, [{ cell: "c1" }]), payer(2, [{ cell: "c1" }])]);
    expect(a.doubleAccepted).toEqual(["c1"]);
    expect(a.ok).toBe(false);
  });
});

describe("--dry-run", () => {
  const env = { ...process.env, FUNDER_KEY: "", CREATOR_KEY: "", LOG: "" };
  const run = (script: string, ...args: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", script, "--dry-run", ...args], { env, encoding: "utf8" });

  it("smoke:contention prints the plan and the cost, with no key and no network", () => {
    const out = run("scripts/testnet-contention.ts", "--payers=3");
    expect(out).toMatch(/dry run: nothing is sent/);
    expect(out).toMatch(/payers 3, rounds 2, payout cells wanted 8/);
    expect(out).toMatch(/lent by the funder for the run: 1000 CKB/);
  });

  it("smoke:clear-planted prints the plan and the cost, with no key and no network", () => {
    const out = run("scripts/testnet-clear-planted.ts", "--period=20");
    expect(out).toMatch(/period 20 blocks/);
    expect(out).toMatch(/planted: 16 cells x 153 = 2448 CKB/);
  });

  it("a bad option is refused before anything else", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/testnet-contention.ts", "--dry-run", "--rounds=9"], {
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/rounds \(--rounds= or ROUNDS\) must be an integer from 1 to 5, got 9/);
  });
});
