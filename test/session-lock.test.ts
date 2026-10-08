/**
 * The session lock, run in the real CKB-VM (via ckb-testtool and ckb-debugger)
 * against mocked transactions. No node needed.
 *
 * "Owner" and "session key" are stand-in always-success locks with distinct
 * args: the session lock only checks *which* lock hashes are present among the
 * inputs — the real secp256k1 locks verify the signatures — so a stand-in with
 * the right hash is exactly what the session lock sees on chain.
 *
 * Most tests assert a rejection *and its error code*, so a test cannot pass
 * because the script failed for an unrelated reason.
 */
import { ccc } from "@ckb-ccc/core";
import { DEFAULT_SCRIPT_ALWAYS_SUCCESS, Resource, Verifier } from "ckb-testtool";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BINARY = "contracts/session-lock/target/riscv64imac-unknown-none-elf/release/session-lock";

/** Error codes from contracts/session-lock/src/main.rs. */
const E = {
  BAD_ARGS: 10,
  NOT_AUTHORIZED: 11,
  OUTFLOW_EXCEEDED: 12,
  RECIPIENT_NOT_ALLOWED: 13,
  RATE_LIMITED: 14,
} as const;

const CKB = 100_000_000n;
const relativeBlocks = (n: bigint) => (1n << 63n) | n;

const u64le = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return ccc.hexFrom(b).slice(2);
};

interface Scope {
  maxPerTx: bigint;
  minInterval?: bigint;
  recipient?: boolean;
}

interface Cell {
  lock: "session" | "owner" | "key" | "recipient" | "stranger" | "other-session";
  capacity: bigint;
  since?: bigint;
}

// ckb-testtool's types point at CCC's CommonJS build and ours at its ESM build:
// the same classes at runtime, two copies of the types. Bridge them here.
type TtTransaction = Parameters<Resource["deployCell"]>[1];
type TtScript = Parameters<Resource["mockCell"]>[0];
const asTt = (s: ccc.Script) => s as unknown as TtScript;

function build(scope: Scope, inputs: Cell[], outputs: Cell[], argsOverride?: string) {
  const resource = Resource.default();
  const tx = ccc.Transaction.default() as unknown as TtTransaction;

  const always = resource.deployCell(ccc.hexFrom(readFileSync(DEFAULT_SCRIPT_ALWAYS_SUCCESS)), tx, false);
  const sessionCode = resource.deployCell(ccc.hexFrom(readFileSync(BINARY)), tx, false);
  const plain = (args: string) => ccc.Script.from({ codeHash: always.codeHash, hashType: always.hashType, args });

  const owner = plain("0x01");
  const key = plain("0x02");
  const recipient = plain("0x03");
  const stranger = plain("0x04");

  const args =
    argsOverride ??
    "0x" +
      owner.hash().slice(2) +
      key.hash().slice(2) +
      u64le(scope.maxPerTx) +
      u64le(scope.minInterval ?? 0n) +
      (scope.recipient ? recipient.hash().slice(2) : "");
  const session = ccc.Script.from({ codeHash: sessionCode.codeHash, hashType: sessionCode.hashType, args });
  // Same code, different scope: a different script group the test must not confuse.
  const otherSession = ccc.Script.from({ ...session, args: args.slice(0, -2) + (args.endsWith("ff") ? "00" : "ff") });

  const locks = { session, owner, key, recipient, stranger, "other-session": otherSession };
  for (const c of inputs) {
    const input = Resource.createCellInput(resource.mockCell(asTt(locks[c.lock]), undefined, "0x", c.capacity));
    if (c.since !== undefined) input.since = c.since;
    tx.inputs.push(input);
  }
  for (const c of outputs) {
    tx.outputs.push(Resource.createCellOutput(asTt(locks[c.lock]), undefined, c.capacity));
    tx.outputsData.push("0x");
  }
  // ckb-testtool's `codeHash` filter actually matches the full script hash.
  return { verifier: Verifier.from(resource, tx), sessionScriptHash: session.hash() };
}

const ok = async (...a: Parameters<typeof build>) => {
  const { verifier } = build(...a);
  return verifier.verifySuccess();
};
const fails = async (code: number, ...a: Parameters<typeof build>) => {
  const { verifier, sessionScriptHash } = build(...a);
  await verifier.verifyFailure(code, false, { codeHash: sessionScriptHash });
};

const scope100: Scope = { maxPerTx: 100n * CKB };
const KEY_CELL: Cell = { lock: "key", capacity: 61n * CKB };

// Skipped only where the contract has not been built; CI sets REQUIRE_LOCK_TESTS so
// a missing binary fails there instead of passing silently.
const skip = !existsSync(BINARY) && !process.env.REQUIRE_LOCK_TESTS;

describe.skipIf(skip)("session lock", () => {
  describe("authorisation", () => {
    it("rejects a spend with neither the owner nor the session key present", async () => {
      await fails(E.NOT_AUTHORIZED, scope100, [{ lock: "session", capacity: 500n * CKB }], [
        { lock: "stranger", capacity: 500n * CKB },
      ]);
    });

    it("rejects a stranger's input posing as authorisation", async () => {
      await fails(
        E.NOT_AUTHORIZED,
        scope100,
        [{ lock: "session", capacity: 500n * CKB }, { lock: "stranger", capacity: 61n * CKB }],
        [{ lock: "stranger", capacity: 561n * CKB }],
      );
    });

    it("owner mode: the owner may sweep everything, ignoring the scope", async () => {
      await ok(
        { ...scope100, recipient: true, minInterval: 10n },
        [{ lock: "session", capacity: 500n * CKB }, { lock: "owner", capacity: 61n * CKB }],
        [{ lock: "stranger", capacity: 561n * CKB }],
      );
    });
  });

  describe("outflow limit (session mode)", () => {
    it("accepts a spend of exactly max_per_tx, change back to the session", async () => {
      const cycles = await ok(scope100, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "stranger", capacity: 100n * CKB },
        { lock: "session", capacity: 400n * CKB },
        KEY_CELL,
      ]);
      expect(cycles).toBeGreaterThan(0);
    });

    it("rejects one shannon over max_per_tx", async () => {
      await fails(E.OUTFLOW_EXCEEDED, scope100, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "stranger", capacity: 100n * CKB + 1n },
        { lock: "session", capacity: 400n * CKB - 1n },
        KEY_CELL,
      ]);
    });

    it("counts the fee as outflow, so it cannot be used to drain the cell", async () => {
      // 500 in, 350 back: 150 gone, of which only 100 is visible as a payment.
      await fails(E.OUTFLOW_EXCEEDED, scope100, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "stranger", capacity: 100n * CKB },
        { lock: "session", capacity: 350n * CKB },
        KEY_CELL,
      ]);
    });

    it("sums every session cell in the group", async () => {
      await fails(
        E.OUTFLOW_EXCEEDED,
        scope100,
        [{ lock: "session", capacity: 300n * CKB }, { lock: "session", capacity: 300n * CKB }, KEY_CELL],
        [{ lock: "stranger", capacity: 200n * CKB }, { lock: "session", capacity: 400n * CKB }, KEY_CELL],
      );
    });

    it("does not count change sent to a different session lock as change", async () => {
      await fails(E.OUTFLOW_EXCEEDED, scope100, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "other-session", capacity: 500n * CKB },
        KEY_CELL,
      ]);
    });

    it("treats topping the session up as zero outflow", async () => {
      await ok(scope100, [{ lock: "session", capacity: 100n * CKB }, { ...KEY_CELL, capacity: 461n * CKB }], [
        { lock: "session", capacity: 500n * CKB },
        KEY_CELL,
      ]);
    });
  });

  describe("recipient allowlist (session mode)", () => {
    const scoped: Scope = { ...scope100, recipient: true };

    it("accepts paying the allowed recipient", async () => {
      await ok(scoped, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "recipient", capacity: 100n * CKB },
        { lock: "session", capacity: 400n * CKB },
        KEY_CELL,
      ]);
    });

    it("accepts returning funds to the owner", async () => {
      await ok(scoped, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "owner", capacity: 100n * CKB },
        { lock: "session", capacity: 400n * CKB },
        KEY_CELL,
      ]);
    });

    it("rejects paying anyone else, even within the limit", async () => {
      await fails(E.RECIPIENT_NOT_ALLOWED, scoped, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "stranger", capacity: 61n * CKB },
        { lock: "session", capacity: 439n * CKB },
        KEY_CELL,
      ]);
    });

    // Micropayments: the recipient's existing (anyone-can-pay) cell is consumed and
    // recreated larger. Only what leaves the session counts, not the recipient's
    // cell size, so a 1 CKB payment works and a large recipient cell is no obstacle.
    it("accepts a 1 CKB top-up of the recipient's existing cell", async () => {
      await ok(
        scoped,
        [{ lock: "session", capacity: 500n * CKB }, { lock: "recipient", capacity: 200n * CKB }, KEY_CELL],
        [{ lock: "recipient", capacity: 201n * CKB }, { lock: "session", capacity: 499n * CKB }, KEY_CELL],
      );
    });

    it("rejects a top-up larger than max_per_tx", async () => {
      await fails(
        E.OUTFLOW_EXCEEDED,
        scoped,
        [{ lock: "session", capacity: 500n * CKB }, { lock: "recipient", capacity: 61n * CKB }, KEY_CELL],
        [{ lock: "recipient", capacity: 162n * CKB }, { lock: "session", capacity: 399n * CKB }, KEY_CELL],
      );
    });
  });

  describe("rate limit (session mode)", () => {
    const limited: Scope = { ...scope100, minInterval: 10n };
    const spend = (since?: bigint): Cell[] => [{ lock: "session", capacity: 500n * CKB, since }, KEY_CELL];
    const out: Cell[] = [
      { lock: "stranger", capacity: 100n * CKB },
      { lock: "session", capacity: 400n * CKB },
      KEY_CELL,
    ];

    it("accepts an input aged at least min_interval blocks", async () => {
      await ok(limited, spend(relativeBlocks(10n)), out);
    });

    it("rejects an input with no since", async () => {
      await fails(E.RATE_LIMITED, limited, spend(), out);
    });

    it("rejects an input one block too young", async () => {
      await fails(E.RATE_LIMITED, limited, spend(relativeBlocks(9n)), out);
    });

    it("rejects an absolute since, which says nothing about the cell's age", async () => {
      await fails(E.RATE_LIMITED, limited, spend(10_000_000n), out);
    });

    it("rejects a relative epoch since: the interval is in blocks", async () => {
      await fails(E.RATE_LIMITED, limited, spend((1n << 63n) | (1n << 61n) | 10n), out);
    });
  });

  describe("args", () => {
    it.each([
      ["too short", "0x" + "00".repeat(79)],
      ["between the two valid lengths", "0x" + "00".repeat(96)],
      ["too long", "0x" + "00".repeat(113)],
    ])("rejects args that are %s", async (_, args) => {
      await fails(E.BAD_ARGS, scope100, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [KEY_CELL], args);
    });
  });
});
