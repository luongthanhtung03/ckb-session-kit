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
  CAPACITY_OVERFLOW: 15,
  TOO_MANY_CHANGE_CELLS: 16,
  KEY_CELL_GREW: 17,
  TYPED_CELL: 18,
  TOKEN_DATA: 19,
  TOKEN_OUTFLOW_EXCEEDED: 20,
} as const;

const CKB = 100_000_000n;
const relativeBlocks = (n: bigint) => (1n << 63n) | n;

const u64le = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return ccc.hexFrom(b).slice(2);
};
/** u128 LE, no 0x: an xUDT amount (RFC 0052). */
const u128le = (v: bigint) => u64le(v & ((1n << 64n) - 1n)) + u64le(v >> 64n);

interface Scope {
  maxPerTx: bigint;
  minInterval?: bigint;
  recipient?: boolean;
  /** A token session: most token units one spend may move. */
  tokenMaxPerTx?: bigint;
}

interface Cell {
  lock: "session" | "owner" | "key" | "recipient" | "stranger" | "other-session";
  capacity: bigint;
  since?: bigint;
  /** A type script on the cell that is not the session's token: one the session key controls. */
  typed?: boolean;
  /** Typed with the session's token, holding this amount (16-byte data unless `data` says otherwise). */
  token?: bigint;
  /** Raw cell data, overriding the amount encoding. */
  data?: string;
}

interface Options {
  argsOverride?: string;
  /** The token's type script: a stand-in (always success) by default, or the real xUDT binary. */
  xudt?: boolean;
}

const XUDT_BINARY = "test/fixtures/xudt_rce";

// ckb-testtool's types point at CCC's CommonJS build and ours at its ESM build:
// the same classes at runtime, two copies of the types. Bridge them here.
type TtTransaction = Parameters<Resource["deployCell"]>[1];
type TtScript = Parameters<Resource["mockCell"]>[0];
const asTt = (s: ccc.Script) => s as unknown as TtScript;

function build(scope: Scope, inputs: Cell[], outputs: Cell[], opts: Options = {}) {
  const { argsOverride } = opts;
  const resource = Resource.default();
  const tx = ccc.Transaction.default() as unknown as TtTransaction;

  const always = resource.deployCell(ccc.hexFrom(readFileSync(DEFAULT_SCRIPT_ALWAYS_SUCCESS)), tx, false);
  const sessionCode = resource.deployCell(ccc.hexFrom(readFileSync(BINARY)), tx, false);
  const plain = (args: string) => ccc.Script.from({ codeHash: always.codeHash, hashType: always.hashType, args });

  const owner = plain("0x01");
  const key = plain("0x02");
  const recipient = plain("0x03");
  const stranger = plain("0x04");

  // The token. As an xUDT its args are the issuer's lock hash: the stranger's here, so
  // owner mode (minting) never applies by accident.
  let tokenType = plain("0x7171");
  if (opts.xudt) {
    const xudt = resource.deployCell(ccc.hexFrom(readFileSync(XUDT_BINARY)), tx, false);
    tokenType = ccc.Script.from({ codeHash: xudt.codeHash, hashType: xudt.hashType, args: stranger.hash() });
  }

  const args =
    argsOverride ??
    "0x" +
      owner.hash().slice(2) +
      key.hash().slice(2) +
      u64le(scope.maxPerTx) +
      u64le(scope.minInterval ?? 0n) +
      (scope.tokenMaxPerTx !== undefined ? tokenType.hash().slice(2) + u128le(scope.tokenMaxPerTx) : "") +
      (scope.recipient ? recipient.hash().slice(2) : "");
  const session = ccc.Script.from({ codeHash: sessionCode.codeHash, hashType: sessionCode.hashType, args });
  // Same code, different scope: a different script group the test must not confuse.
  const otherSession = ccc.Script.from({ ...session, args: args.slice(0, -2) + (args.endsWith("ff") ? "00" : "ff") });

  const locks = { session, owner, key, recipient, stranger, "other-session": otherSession };
  const anyType = plain("0x7070");
  const typeOf = (c: Cell) => (c.typed ? asTt(anyType) : c.token !== undefined ? asTt(tokenType) : undefined);
  const dataOf = (c: Cell) => ccc.hexFrom(c.data ?? (c.token !== undefined ? "0x" + u128le(c.token) : "0x"));
  for (const c of inputs) {
    const input = Resource.createCellInput(resource.mockCell(asTt(locks[c.lock]), typeOf(c), dataOf(c), c.capacity));
    if (c.since !== undefined) input.since = c.since;
    tx.inputs.push(input);
  }
  for (const c of outputs) {
    tx.outputs.push(Resource.createCellOutput(asTt(locks[c.lock]), typeOf(c), c.capacity));
    tx.outputsData.push(dataOf(c));
  }
  // ckb-testtool's `codeHash` filter actually matches the full script hash.
  return { verifier: Verifier.from(resource, tx), sessionScriptHash: session.hash(), tokenScriptHash: tokenType.hash() };
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

    // The key cell may pay the fee but not grow. Otherwise a leaked key moves
    // max_per_tx into its own cell each spend and pays anyone from there.
    it("accepts the key cell coming back smaller (it paid the fee)", async () => {
      await ok(scoped, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "recipient", capacity: 100n * CKB },
        { lock: "session", capacity: 400n * CKB },
        { lock: "key", capacity: 61n * CKB - 1000n },
      ]);
    });

    it("rejects moving session funds into the key cell", async () => {
      await fails(E.KEY_CELL_GREW, scoped, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "session", capacity: 400n * CKB },
        { lock: "key", capacity: 161n * CKB },
      ]);
    });

    it("rejects a new key-locked cell funded from the session", async () => {
      await fails(E.KEY_CELL_GREW, scoped, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "key", capacity: 100n * CKB },
        { lock: "session", capacity: 400n * CKB },
        KEY_CELL,
      ]);
    });
  });

  // Found in review: the limits count capacity only, so type scripts must stay out.
  describe("no type scripts (session mode)", () => {
    // The whole balance comes back as change (outflow 0) under a type the key
    // controls; upgraded to always-fail, it would refuse even the owner's sweep.
    it("rejects change given a type script, even at zero outflow", async () => {
      await fails(E.TYPED_CELL, { ...scope100, recipient: true }, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "session", capacity: 500n * CKB, typed: true },
        { lock: "key", capacity: 61n * CKB - 1000n },
      ]);
    });

    // A token in a session cell would move at zero CKB outflow.
    it("rejects spending a typed session cell", async () => {
      await fails(E.TYPED_CELL, scope100, [{ lock: "session", capacity: 200n * CKB, typed: true }, KEY_CELL], [
        { lock: "session", capacity: 200n * CKB },
        { lock: "stranger", capacity: 61n * CKB, typed: true },
      ]);
    });

    it("owner mode may still sweep a typed cell (the type script decides for itself)", async () => {
      await ok(scope100, [{ lock: "session", capacity: 200n * CKB, typed: true }, { lock: "owner", capacity: 61n * CKB }], [
        { lock: "owner", capacity: 261n * CKB, typed: true },
      ]);
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

  // min_interval is per cell. If the key could split one cell into many (zero
  // outflow: it all stays under this lock), it could wait one interval and then
  // spend every piece in parallel, in the same block. So a session spend may
  // leave at most one change cell: cells can merge, never multiply.
  describe("no splitting (session mode)", () => {
    const limited: Scope = { ...scope100, minInterval: 10n };
    const mature = (capacity: bigint): Cell => ({ lock: "session", capacity, since: relativeBlocks(10n) });

    it("rejects splitting one session cell into two, even with zero outflow", async () => {
      await fails(
        E.TOO_MANY_CHANGE_CELLS,
        limited,
        [mature(500n * CKB), KEY_CELL],
        [{ lock: "session", capacity: 250n * CKB }, { lock: "session", capacity: 250n * CKB }, KEY_CELL],
      );
    });

    it("rejects a payment that also splits the change", async () => {
      await fails(
        E.TOO_MANY_CHANGE_CELLS,
        scope100,
        [{ lock: "session", capacity: 500n * CKB }, KEY_CELL],
        [
          { lock: "stranger", capacity: 100n * CKB },
          { lock: "session", capacity: 200n * CKB },
          { lock: "session", capacity: 200n * CKB },
          KEY_CELL,
        ],
      );
    });

    it("accepts merging two mature cells into one, outflow summed across both", async () => {
      await ok(
        limited,
        [mature(300n * CKB), mature(300n * CKB), KEY_CELL],
        [{ lock: "stranger", capacity: 100n * CKB }, { lock: "session", capacity: 500n * CKB }, KEY_CELL],
      );
    });

    it("rejects two mature cells in one transaction moving more than max_per_tx together", async () => {
      await fails(
        E.OUTFLOW_EXCEEDED,
        limited,
        [mature(300n * CKB), mature(300n * CKB), KEY_CELL],
        [{ lock: "stranger", capacity: 200n * CKB }, { lock: "session", capacity: 400n * CKB }, KEY_CELL],
      );
    });

    it("still lets the owner split, since owner mode ignores the scope", async () => {
      await ok(
        limited,
        [{ lock: "session", capacity: 500n * CKB }, { lock: "owner", capacity: 100n * CKB }],
        [{ lock: "session", capacity: 250n * CKB }, { lock: "session", capacity: 250n * CKB }, { lock: "owner", capacity: 100n * CKB }],
      );
    });
  });

  describe("args", () => {
    it.each([
      ["too short", "0x" + "00".repeat(79)],
      ["between the two valid lengths", "0x" + "00".repeat(96)],
      ["between the plain and the token lengths", "0x" + "00".repeat(113)],
      ["between the two token lengths", "0x" + "00".repeat(144)],
      ["too long", "0x" + "00".repeat(161)],
    ])("rejects args that are %s", async (_, args) => {
      await fails(E.BAD_ARGS, scope100, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [KEY_CELL], {
        argsOverride: args,
      });
    });
  });

  // Token sessions (docs/design/token-sessions.md). The token here is a stand-in type
  // that always succeeds, so every rejection below is the session lock's own; the last
  // block runs the real xUDT binary alongside.
  describe("token sessions", () => {
    const T = 1_000_000n; // token units
    const tok: Scope = { maxPerTx: 100n * CKB, tokenMaxPerTx: 10n * T };
    const tokRecipient: Scope = { ...tok, recipient: true };
    const tokenCell = (lock: Cell["lock"], amount: bigint, capacity = 200n * CKB): Cell => ({ lock, capacity, token: amount });
    const KEY_FEE: Cell = { lock: "key", capacity: 61n * CKB - 1000n };

    it("accepts paying max_per_tx_token, token change back to the session", async () => {
      await ok(tokRecipient, [tokenCell("session", 100n * T), tokenCell("recipient", 5n * T), KEY_CELL], [
        tokenCell("recipient", 15n * T),
        tokenCell("session", 90n * T),
        KEY_FEE,
      ]);
    });

    // Threat 1: tokens leave while capacity stays put.
    it("rejects one unit over max_per_tx_token, at zero CKB outflow", async () => {
      await fails(E.TOKEN_OUTFLOW_EXCEEDED, tok, [tokenCell("session", 100n * T), tokenCell("stranger", 0n), KEY_CELL], [
        tokenCell("stranger", 10n * T + 1n),
        tokenCell("session", 90n * T - 1n),
        KEY_CELL,
      ]);
    });

    it("sums tokens across every session cell in the group", async () => {
      await fails(
        E.TOKEN_OUTFLOW_EXCEEDED,
        tok,
        [tokenCell("session", 50n * T), tokenCell("session", 50n * T), KEY_CELL],
        [{ lock: "stranger", capacity: 1n * CKB, token: 20n * T }, tokenCell("session", 80n * T, 399n * CKB), KEY_CELL],
      );
    });

    it("rejects dropping all tokens into untyped change", async () => {
      await fails(E.TOKEN_OUTFLOW_EXCEEDED, tok, [tokenCell("session", 100n * T), KEY_CELL], [
        { lock: "stranger", capacity: 1n * CKB, token: 100n * T },
        { lock: "session", capacity: 199n * CKB },
        KEY_CELL,
      ]);
    });

    it("accepts spending the last tokens and keeping untyped change", async () => {
      await ok(tok, [tokenCell("session", 10n * T), KEY_CELL], [
        tokenCell("stranger", 10n * T, 1n * CKB),
        { lock: "session", capacity: 199n * CKB },
        KEY_CELL,
      ]);
    });

    // Found in review: an amount is only ever read from a token-typed cell.
    it("does not read an amount from untyped change (ff..ff would underflow into a top-up)", async () => {
      await fails(E.TOKEN_OUTFLOW_EXCEEDED, tok, [tokenCell("session", 100n * T), KEY_CELL], [
        tokenCell("stranger", 100n * T, 1n * CKB),
        { lock: "session", capacity: 199n * CKB, data: "0x" + "ff".repeat(16) },
        KEY_CELL,
      ]);
    });

    it("treats a token top-up of the session as zero outflow", async () => {
      await ok(tok, [tokenCell("session", 10n * T), tokenCell("key", 50n * T, 261n * CKB)], [
        tokenCell("session", 60n * T, 400n * CKB),
        KEY_CELL,
      ]);
    });

    it("still caps CKB outflow (T5)", async () => {
      await fails(E.OUTFLOW_EXCEEDED, tok, [tokenCell("session", 100n * T, 500n * CKB), KEY_CELL], [
        { lock: "stranger", capacity: 101n * CKB },
        tokenCell("session", 100n * T, 399n * CKB),
        KEY_CELL,
      ]);
    });

    // Threat 2 / T1: no type other than the token, in or out.
    it("rejects change typed with a script the key controls", async () => {
      await fails(E.TYPED_CELL, tok, [tokenCell("session", 100n * T), KEY_CELL], [
        { lock: "session", capacity: 200n * CKB, typed: true },
        tokenCell("stranger", 100n * T, 1n * CKB),
        KEY_FEE,
      ]);
    });

    it("rejects spending a session cell typed with something other than the token", async () => {
      await fails(E.TYPED_CELL, tok, [{ lock: "session", capacity: 200n * CKB, typed: true }, KEY_CELL], [
        { lock: "session", capacity: 200n * CKB },
        KEY_CELL,
      ]);
    });

    // Threat 5 / T3: change data is exactly the amount.
    it("rejects token change carrying extension data", async () => {
      await fails(E.TOKEN_DATA, tok, [tokenCell("session", 100n * T), KEY_CELL], [
        { lock: "session", capacity: 200n * CKB, token: 100n * T, data: "0x" + u128le(100n * T) + "00" },
        KEY_CELL,
      ]);
    });

    it("rejects token change with under 16 data bytes", async () => {
      await fails(E.TOKEN_DATA, tok, [tokenCell("session", 100n * T), KEY_CELL], [
        { lock: "session", capacity: 200n * CKB, token: 0n, data: "0x" + "00".repeat(15) },
        tokenCell("stranger", 100n * T),
        KEY_CELL,
      ]);
    });

    // Threat 9: a token-typed session input with short data.
    it("rejects a token-typed session input with under 16 data bytes", async () => {
      await fails(E.TOKEN_DATA, tok, [{ lock: "session", capacity: 200n * CKB, token: 0n, data: "0x00" }, KEY_CELL], [
        { lock: "session", capacity: 200n * CKB },
        KEY_CELL,
      ]);
    });

    // Threat 3 / T4: the key cell cannot collect tokens and pay anyone later.
    it("rejects moving session tokens into the key cell (recipient set)", async () => {
      await fails(E.KEY_CELL_GREW, tokRecipient, [tokenCell("session", 100n * T), KEY_CELL], [
        tokenCell("session", 95n * T),
        { lock: "key", capacity: 61n * CKB - 1000n, token: 5n * T },
      ]);
    });

    it("rejects a key-locked token output with short data (recipient set)", async () => {
      await fails(E.TOKEN_DATA, tokRecipient, [tokenCell("session", 100n * T), KEY_CELL], [
        tokenCell("session", 95n * T),
        tokenCell("recipient", 5n * T),
        { lock: "key", capacity: 61n * CKB - 1000n, token: 0n, data: "0x01" },
      ]);
    });

    it("lets the key cell keep tokens it already held (recipient set)", async () => {
      await ok(tokRecipient, [tokenCell("session", 100n * T), tokenCell("key", 3n * T, 200n * CKB)], [
        tokenCell("session", 95n * T),
        tokenCell("recipient", 5n * T),
        tokenCell("key", 3n * T, 200n * CKB - 1000n),
      ]);
    });

    it("rejects paying the recipient in a cell typed by another script (recipient set)", async () => {
      await fails(E.TYPED_CELL, tokRecipient, [tokenCell("session", 100n * T), KEY_CELL], [
        { lock: "recipient", capacity: 100n * CKB, typed: true },
        tokenCell("session", 100n * T, 100n * CKB),
        KEY_CELL,
      ]);
    });

    // Threat 4: rule 3 holds for token change too.
    it("rejects splitting token change", async () => {
      await fails(E.TOO_MANY_CHANGE_CELLS, tok, [tokenCell("session", 100n * T, 400n * CKB), KEY_CELL], [
        tokenCell("session", 50n * T),
        tokenCell("session", 50n * T),
        KEY_CELL,
      ]);
    });

    // Threat 10: checked sums.
    it("rejects inputs whose token amounts overflow u128", async () => {
      await fails(
        E.CAPACITY_OVERFLOW,
        tok,
        [tokenCell("session", (1n << 128n) - 1n), tokenCell("session", 1n), KEY_CELL],
        [tokenCell("session", 0n), KEY_CELL],
      );
    });

    // Threat 7 + review: token reads happen after the owner-mode return, so planted junk
    // never stops the owner's sweep at this lock.
    it("owner mode sweeps a malformed token cell and a foreign-typed cell", async () => {
      await ok(
        tokRecipient,
        [
          { lock: "session", capacity: 200n * CKB, token: 0n, data: "0x01" },
          { lock: "session", capacity: 200n * CKB, typed: true },
          { lock: "owner", capacity: 61n * CKB },
        ],
        [{ lock: "owner", capacity: 461n * CKB }],
      );
    });

    it("a plain (80/112-byte) session still refuses a token cell", async () => {
      await fails(E.TYPED_CELL, scope100, [tokenCell("session", 100n * T), KEY_CELL], [
        { lock: "session", capacity: 200n * CKB },
        KEY_CELL,
      ]);
    });

    describe.skipIf(!existsSync(XUDT_BINARY))("with the real xUDT script", () => {
      const xudt = { xudt: true };

      it("pays the recipient's token cell (an anyone-can-pay style top-up)", async () => {
        await ok(
          tokRecipient,
          [tokenCell("session", 100n * T), tokenCell("recipient", 5n * T), KEY_CELL],
          [tokenCell("recipient", 15n * T), tokenCell("session", 90n * T), KEY_FEE],
          xudt,
        );
      });

      it("the session lock still refuses one unit over the limit", async () => {
        await fails(
          E.TOKEN_OUTFLOW_EXCEEDED,
          tokRecipient,
          [tokenCell("session", 100n * T), tokenCell("recipient", 5n * T), KEY_CELL],
          [tokenCell("recipient", 15n * T + 1n), tokenCell("session", 90n * T - 1n), KEY_FEE],
          xudt,
        );
      });

      // The lock lets it through (no tokens left the session); the token script does not.
      it("xUDT itself refuses minting in a session spend", async () => {
        const { verifier, sessionScriptHash, tokenScriptHash } = build(
          tok,
          [tokenCell("session", 100n * T), KEY_CELL],
          [tokenCell("stranger", 5n * T), tokenCell("session", 100n * T), KEY_CELL],
          xudt,
        );
        await verifier.verifySuccess(false, { codeHash: sessionScriptHash });
        await verifier.verifyFailure(-52, false, { codeHash: tokenScriptHash }); // xUDT ERROR_AMOUNT
      });

      it("the owner sweeps every token back", async () => {
        await ok(
          tokRecipient,
          [tokenCell("session", 100n * T), { lock: "owner", capacity: 61n * CKB }],
          [tokenCell("owner", 100n * T, 261n * CKB)],
          xudt,
        );
      });
    });
  });
});
