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

/**
 * Lock names. Besides the cast above:
 * - "sibling": a second session-lock cell with its own scope (`Options.sibling`).
 * - "session-data1", "owner-data1", "recipient-data1": the same code and args as
 *   "session", "owner", "recipient", referenced with hash_type data1 instead of data2.
 * - "recipient-type": the recipient's code hash and args under hash_type type.
 * - "recipient-padded": the recipient's code and hash_type with one zero byte appended to its args.
 */
type LockName =
  | "session"
  | "owner"
  | "key"
  | "recipient"
  | "stranger"
  | "other-session"
  | "sibling"
  | "session-data1"
  | "owner-data1"
  | "recipient-data1"
  | "recipient-type"
  | "recipient-padded";

interface Cell {
  lock: LockName;
  capacity: bigint;
  since?: bigint;
  /** A type script on the cell that is not the session's token: one the session key controls. */
  typed?: boolean;
  /** Typed with the session's token, holding this amount (16-byte data unless `data` says otherwise). */
  token?: bigint;
  /**
   * With `token`: typed with the token's code and its args followed by these bytes
   * (hex, no 0x), a look-alike the indexer's prefix match lists with the token (review W6 M1).
   */
  tokenArgsSuffix?: string;
  /** Raw cell data, overriding the amount encoding. */
  data?: string;
  /** Typed with the real Nervos DAO type script (deposit data, 8 zero bytes). Its code is not in the tx: run the session group only. */
  dao?: boolean;
  /** Typed with a real Type ID type script. Run the session group only. */
  typeId?: boolean;
}

interface Options {
  argsOverride?: string;
  /** The token's type script: a stand-in (always success) by default, or the real xUDT binary. */
  xudt?: boolean;
  /** The recipient field holds the session key's own lock hash (a subscription paying its charger). */
  recipientIsKey?: boolean;
  /** The owner field holds the session key's own lock hash (args a malicious app could write). */
  ownerIsKey?: boolean;
  /** Scope of the "sibling" session lock; its owner is the real owner unless `owner: "stranger"`. */
  sibling?: Scope & { owner?: "owner" | "stranger" };
  /** Witnesses, as given. */
  witnesses?: string[];
  /** Cells under these locks added as cell deps (never as inputs). */
  depLocks?: LockName[];
}

/** The Nervos DAO type script (RFC 0023), as on mainnet and testnet. */
const DAO_TYPE = {
  codeHash: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e",
  hashType: "type",
  args: "0x",
} as const;
/** A Type ID type script (RFC 0022). */
const TYPE_ID = {
  codeHash: "0x00000000000000000000000000000000000000000000000000545950455f4944",
  hashType: "type",
  args: "0x" + "ab".repeat(32),
} as const;

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

  const argsOf = (sc: Scope, ownerHash: string) =>
    "0x" +
    ownerHash.slice(2) +
    key.hash().slice(2) +
    u64le(sc.maxPerTx) +
    u64le(sc.minInterval ?? 0n) +
    (sc.tokenMaxPerTx !== undefined ? tokenType.hash().slice(2) + u128le(sc.tokenMaxPerTx) : "") +
    (sc.recipient ? (opts.recipientIsKey ? key : recipient).hash().slice(2) : "");
  const args = argsOverride ?? argsOf(scope, (opts.ownerIsKey ? key : owner).hash());
  const session = ccc.Script.from({ codeHash: sessionCode.codeHash, hashType: sessionCode.hashType, args });
  // Same code, different scope: a different script group the test must not confuse.
  const otherSession = ccc.Script.from({ ...session, args: args.slice(0, -2) + (args.endsWith("ff") ? "00" : "ff") });
  const sib = opts.sibling;
  const sibling = ccc.Script.from({
    ...session,
    args: sib ? argsOf(sib, (sib.owner === "stranger" ? stranger : owner).hash()) : args.slice(0, -2) + "ee",
  });
  const rehash = (s: ccc.Script, hashType: ccc.HashTypeLike, extraArgs = "") =>
    ccc.Script.from({ codeHash: s.codeHash, hashType, args: s.args + extraArgs });

  const locks: Record<LockName, ccc.Script> = {
    session,
    owner,
    key,
    recipient,
    stranger,
    "other-session": otherSession,
    sibling,
    "session-data1": rehash(session, "data1"),
    "owner-data1": rehash(owner, "data1"),
    "recipient-data1": rehash(recipient, "data1"),
    "recipient-type": rehash(recipient, "type"),
    "recipient-padded": rehash(recipient, recipient.hashType, "00"),
  };
  const anyType = plain("0x7070");
  const typeOf = (c: Cell) =>
    c.dao
      ? asTt(ccc.Script.from(DAO_TYPE))
      : c.typeId
        ? asTt(ccc.Script.from(TYPE_ID))
        : c.typed
          ? asTt(anyType)
          : c.token !== undefined && c.tokenArgsSuffix !== undefined
            ? asTt(ccc.Script.from({ ...tokenType, args: tokenType.args + c.tokenArgsSuffix }))
            : c.token !== undefined
              ? asTt(tokenType)
              : undefined;
  const dataOf = (c: Cell) =>
    ccc.hexFrom(c.data ?? (c.dao ? "0x" + "00".repeat(8) : c.token !== undefined ? "0x" + u128le(c.token) : "0x"));
  for (const c of inputs) {
    const input = Resource.createCellInput(resource.mockCell(asTt(locks[c.lock]), typeOf(c), dataOf(c), c.capacity));
    if (c.since !== undefined) input.since = c.since;
    tx.inputs.push(input);
  }
  for (const c of outputs) {
    tx.outputs.push(Resource.createCellOutput(asTt(locks[c.lock]), typeOf(c), c.capacity));
    tx.outputsData.push(dataOf(c));
  }
  for (const name of opts.depLocks ?? []) {
    tx.cellDeps.push(Resource.createCellDep(resource.mockCell(asTt(locks[name]), undefined, "0x", 1000n * CKB), "code"));
  }
  if (opts.witnesses) tx.witnesses.push(...opts.witnesses.map((w) => ccc.hexFrom(w)));
  const hashes = Object.fromEntries(Object.entries(locks).map(([k, v]) => [k, v.hash()])) as Record<LockName, ccc.Hex>;
  // ckb-testtool's `codeHash` filter actually matches the full script hash.
  return {
    verifier: Verifier.from(resource, tx),
    sessionScriptHash: session.hash(),
    tokenScriptHash: tokenType.hash(),
    hashes,
  };
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

    // Code review, 14 Oct: a payment in a cell typed by a script the key controls
    // could be frozen after it lands.
    it("rejects paying the recipient in a typed cell", async () => {
      await fails(E.TYPED_CELL, scoped, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "recipient", capacity: 100n * CKB, typed: true },
        { lock: "session", capacity: 400n * CKB },
        KEY_CELL,
      ]);
    });

    // Code review, 14 Oct: nothing read before the owner-mode return may fail.
    it("owner mode ignores key cells whose capacities overflow a u64 together", async () => {
      const huge: Cell = { lock: "key", capacity: (1n << 63n) + 1n };
      await ok(scoped, [{ lock: "session", capacity: 500n * CKB }, huge, huge, { lock: "owner", capacity: 61n * CKB }], [
        { lock: "owner", capacity: 561n * CKB },
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

  // Subscriptions (docs/design/subscriptions.md): the subscriber is the owner, the
  // creator's charger key is the session key, max_per_tx is the price, min_interval
  // the period and the recipient the creator's payout address. Same binary, no change.
  describe("subscription shape", () => {
    const PERIOD = 20n;
    const sub: Scope = { maxPerTx: 10n * CKB, minInterval: PERIOD, recipient: true };
    const cell = (capacity: bigint, since?: bigint): Cell => ({ lock: "session", capacity, since });

    it("accepts one charge of the price after a full period, fee paid by the charger", async () => {
      await ok(
        sub,
        [cell(500n * CKB, relativeBlocks(PERIOD)), { lock: "recipient", capacity: 200n * CKB }, KEY_CELL],
        [{ lock: "recipient", capacity: 210n * CKB }, cell(490n * CKB), { lock: "key", capacity: 61n * CKB - 1000n }],
      );
    });

    it("rejects a second charge before the period has passed", async () => {
      await fails(
        E.RATE_LIMITED,
        sub,
        [cell(490n * CKB, relativeBlocks(PERIOD - 1n)), KEY_CELL],
        [{ lock: "recipient", capacity: 10n * CKB }, cell(480n * CKB), KEY_CELL],
      );
    });

    it("rejects charging more than the price", async () => {
      await fails(
        E.OUTFLOW_EXCEEDED,
        sub,
        [cell(500n * CKB, relativeBlocks(PERIOD)), KEY_CELL],
        [{ lock: "recipient", capacity: 10n * CKB + 1n }, cell(490n * CKB - 1n), KEY_CELL],
      );
    });

    it("rejects the charge going anywhere but the payout address", async () => {
      await fails(
        E.RECIPIENT_NOT_ALLOWED,
        sub,
        [cell(500n * CKB, relativeBlocks(PERIOD)), KEY_CELL],
        [{ lock: "stranger", capacity: 10n * CKB }, cell(490n * CKB), KEY_CELL],
      );
    });

    it("rejects a payout address equal to the charger key: the charge would grow the key cell", async () => {
      await fails(
        E.KEY_CELL_GREW,
        sub,
        [cell(500n * CKB, relativeBlocks(PERIOD)), KEY_CELL],
        [cell(490n * CKB), { lock: "key", capacity: 71n * CKB }],
        { recipientIsKey: true },
      );
    });

    it("lets the subscriber cancel alone, at any time, with no wait", async () => {
      await ok(sub, [cell(490n * CKB), { lock: "owner", capacity: 61n * CKB }], [{ lock: "owner", capacity: 551n * CKB }]);
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

      // Review W6 M1: the indexer lists cells by type-script args prefix. xUDT with a
      // zero flags word ignores the bytes after it, and a zero amount needs no input,
      // so anyone can plant such a look-alike under a session lock.
      const lookalike = (lock: Cell["lock"], capacity: bigint, suffix = "00000000" + "01"): Cell => ({
        lock,
        capacity,
        token: 0n,
        tokenArgsSuffix: suffix,
      });

      it("anyone can create a zero-amount look-alike (token args, zero flags, extra bytes) under the lock", async () => {
        await ok(
          tokRecipient,
          [{ lock: "recipient", capacity: 1000n * CKB }],
          [lookalike("session", 300n * CKB), { lock: "recipient", capacity: 700n * CKB }],
          xudt,
        );
      });

      it("but cannot put tokens in one: xUDT refuses minting it without the issuer", async () => {
        const { verifier } = build(
          tokRecipient,
          // Not the stranger: in this harness the stranger is the token's issuer.
          [{ lock: "recipient", capacity: 1000n * CKB }],
          [{ ...lookalike("session", 300n * CKB), token: 1n }, { lock: "recipient", capacity: 700n * CKB }],
          xudt,
        );
        await verifier.verifyFailure(-52); // xUDT ERROR_AMOUNT
      });

      it("the owner sweeps look-alikes back, keeping their type (clearPlantedCells, cancelSubscription)", async () => {
        await ok(
          tokRecipient,
          [lookalike("session", 300n * CKB), lookalike("session", 300n * CKB), { lock: "owner", capacity: 61n * CKB }],
          [lookalike("owner", 300n * CKB), { lock: "owner", capacity: 361n * CKB - 1000n }],
          xudt,
        );
      });
    });

    // Token subscriptions (docs/design/subscriptions.md, "Token subscriptions"): the
    // 160-byte layout with max_per_tx 0, so no CKB ever leaves; the price is
    // max_per_tx_token and the period min_interval. Real xUDT, deployed binary.
    describe.skipIf(!existsSync(XUDT_BINARY))("token subscription shape, with the real xUDT script", () => {
      const xudt = { xudt: true };
      const PERIOD = 20n;
      const PRICE = 10n * T;
      const sub: Scope = { maxPerTx: 0n, minInterval: PERIOD, tokenMaxPerTx: PRICE, recipient: true };
      // 282 CKB: a token subscription cell's own size; 142 CKB: the payout's token cell.
      const subCell = (amount: bigint, since?: bigint, capacity = 282n * CKB): Cell => ({
        lock: "session",
        capacity,
        token: amount,
        since,
      });
      const payout = (amount: bigint, capacity = 142n * CKB) => tokenCell("recipient", amount, capacity);

      it("accepts a charge of exactly the price after a full period, with no CKB leaving", async () => {
        await ok(
          sub,
          [subCell(100n * T, relativeBlocks(PERIOD)), payout(5n * T), KEY_CELL],
          [payout(15n * T), subCell(90n * T), KEY_FEE],
          xudt,
        );
      });

      it("rejects a charge before the period has passed", async () => {
        await fails(
          E.RATE_LIMITED,
          sub,
          [subCell(100n * T, relativeBlocks(PERIOD - 1n)), payout(5n * T), KEY_CELL],
          [payout(15n * T), subCell(90n * T), KEY_FEE],
          xudt,
        );
      });

      it("rejects one unit over the price", async () => {
        await fails(
          E.TOKEN_OUTFLOW_EXCEEDED,
          sub,
          [subCell(100n * T, relativeBlocks(PERIOD)), payout(5n * T), KEY_CELL],
          [payout(15n * T + 1n), subCell(90n * T - 1n), KEY_FEE],
          xudt,
        );
      });

      // A cell above its own size: one under 282 CKB would be refused for its size, not by the lock.
      it("rejects one shannon of CKB leaving the subscription, even with the price exact", async () => {
        await fails(
          E.OUTFLOW_EXCEEDED,
          sub,
          [subCell(100n * T, relativeBlocks(PERIOD), 300n * CKB), payout(5n * T), KEY_CELL],
          [payout(15n * T, 142n * CKB + 1n), subCell(90n * T, undefined, 300n * CKB - 1n), KEY_FEE],
          xudt,
        );
      });

      it("rejects the charge going to anyone but the payout address", async () => {
        await fails(
          E.RECIPIENT_NOT_ALLOWED,
          sub,
          [subCell(100n * T, relativeBlocks(PERIOD)), tokenCell("stranger", 5n * T, 142n * CKB), KEY_CELL],
          [tokenCell("stranger", 15n * T, 142n * CKB), subCell(90n * T), KEY_FEE],
          xudt,
        );
      });

      it("lets the subscriber cancel alone, at any time, sweeping the tokens back", async () => {
        await ok(
          sub,
          [subCell(90n * T), { lock: "owner", capacity: 61n * CKB }],
          [tokenCell("owner", 90n * T, 343n * CKB - 1000n)],
          xudt,
        );
      });
    });
  });

  // Week 7: attacks by someone holding a leaked session key, or by a malicious app that
  // builds the transactions. Each case is listed in docs/SECURITY-EVIDENCE.md,
  // "Adversarial cases (CKB-VM)", with its outcome.
  describe("adversarial (leaked key, malicious app)", () => {
    /** Runs the given lock group only, so scripts whose code is absent here (DAO, Type ID) are not run. */
    const okGroup = async (group: LockName, ...a: Parameters<typeof build>) => {
      const { verifier, hashes } = build(...a);
      return verifier.verifySuccess(false, { codeHash: hashes[group] });
    };
    const failsGroup = async (group: LockName, code: number, ...a: Parameters<typeof build>) => {
      const { verifier, hashes } = build(...a);
      await verifier.verifyFailure(code, false, { codeHash: hashes[group] });
    };
    const scoped: Scope = { ...scope100, recipient: true };
    const S = (capacity: bigint, since?: bigint): Cell => ({ lock: "session", capacity, since });
    const PAY: Cell[] = [{ lock: "stranger", capacity: 100n * CKB }, S(400n * CKB), KEY_CELL];

    describe("since tricks against the rate limit", () => {
      const limited: Scope = { ...scope100, minInterval: 10n };

      it("rejects a relative timestamp since, even with a large value", async () => {
        await fails(E.RATE_LIMITED, limited, [S(500n * CKB, (1n << 63n) | (1n << 62n) | 1_000_000n), KEY_CELL], PAY);
      });

      it("rejects metric bits 11 (no such metric)", async () => {
        await fails(E.RATE_LIMITED, limited, [S(500n * CKB, (0b111n << 61n) | 10n), KEY_CELL], PAY);
      });

      it("rejects reserved bits set above a too-small value: they do not raise it", async () => {
        await fails(E.RATE_LIMITED, limited, [S(500n * CKB, relativeBlocks(5n) | (0x1fn << 56n)), KEY_CELL], PAY);
      });

      // The lock reads the low 56 bits only. Reserved bits must be zero by consensus
      // (RFC 0017): the node refuses such an input before any script runs.
      it("ignores reserved bits when the value itself is old enough (the node refuses the since)", async () => {
        await ok(limited, [S(500n * CKB, relativeBlocks(10n) | (1n << 56n)), KEY_CELL], PAY);
      });

      it("rejects one young cell merged with a mature one", async () => {
        await fails(
          E.RATE_LIMITED,
          limited,
          [S(300n * CKB, relativeBlocks(10n)), S(300n * CKB), KEY_CELL],
          [{ lock: "stranger", capacity: 100n * CKB }, S(500n * CKB), KEY_CELL],
        );
      });

      it("rejects a since on the key cell instead of the session cell", async () => {
        await fails(E.RATE_LIMITED, limited, [S(500n * CKB), { ...KEY_CELL, since: relativeBlocks(10n) }], PAY);
      });

      // A malicious app could open a session no key can ever spend; the owner still can.
      it("min_interval of 2^56 or more: session mode can never pass, the owner still sweeps", async () => {
        const never: Scope = { ...scope100, minInterval: 1n << 56n };
        await fails(E.RATE_LIMITED, never, [S(500n * CKB, relativeBlocks((1n << 56n) - 1n)), KEY_CELL], PAY);
        await ok(never, [S(500n * CKB), { lock: "owner", capacity: 61n * CKB }], [{ lock: "owner", capacity: 561n * CKB }]);
      });
    });

    describe("several session cells with different scopes in one transaction", () => {
      // Same owner, same key, ten times the limit.
      const loose = { sibling: { maxPerTx: 1000n * CKB } };

      it("rejects moving a tight session's balance into a looser sibling session", async () => {
        await fails(E.OUTFLOW_EXCEEDED, scope100, [S(500n * CKB), KEY_CELL], [{ lock: "sibling", capacity: 500n * CKB }, KEY_CELL], loose);
      });

      it("rejects paying a sibling session from a recipient-scoped session", async () => {
        await fails(
          E.RECIPIENT_NOT_ALLOWED,
          scoped,
          [S(500n * CKB), KEY_CELL],
          [{ lock: "sibling", capacity: 50n * CKB }, S(450n * CKB), KEY_CELL],
          loose,
        );
      });

      it("accepts spending both, each within its own limit", async () => {
        await ok(
          scope100,
          [S(500n * CKB), { lock: "sibling", capacity: 2000n * CKB }, KEY_CELL],
          [{ lock: "stranger", capacity: 1000n * CKB }, S(400n * CKB), { lock: "sibling", capacity: 1100n * CKB }, KEY_CELL],
          loose,
        );
      });

      it("does not pool limits: the sibling's unused headroom does not cover this session", async () => {
        await fails(
          E.OUTFLOW_EXCEEDED,
          scope100,
          [S(500n * CKB), { lock: "sibling", capacity: 2000n * CKB }, KEY_CELL],
          [{ lock: "stranger", capacity: 150n * CKB }, S(350n * CKB), { lock: "sibling", capacity: 2000n * CKB }, KEY_CELL],
          loose,
        );
      });

      it("does not count a sibling's growth as this session's change", async () => {
        await fails(
          E.OUTFLOW_EXCEEDED,
          scope100,
          [S(500n * CKB), { lock: "sibling", capacity: 500n * CKB }, KEY_CELL],
          [S(350n * CKB), { lock: "sibling", capacity: 650n * CKB }, KEY_CELL],
          loose,
        );
      });

      // The attacker opens a session of their own (owner: the attacker) under the same code.
      it("an attacker's own session cell, spent in its owner mode, does not authorise the victim's", async () => {
        await fails(
          E.NOT_AUTHORIZED,
          scope100,
          [S(500n * CKB), { lock: "sibling", capacity: 100n * CKB }, { lock: "stranger", capacity: 61n * CKB }],
          [{ lock: "stranger", capacity: 661n * CKB }],
          { sibling: { maxPerTx: 0n, owner: "stranger" } },
        );
      });
    });

    describe("recipient and owner lookalikes (lock hashes compare the whole script)", () => {
      it.each([
        ["the recipient's code and args under hash_type data1", "recipient-data1"],
        ["the recipient's code hash and args under hash_type type", "recipient-type"],
        ["the recipient's script with one zero byte of args padding", "recipient-padded"],
        ["the owner's code and args under hash_type data1", "owner-data1"],
      ] as const)("rejects paying %s", async (_, lock) => {
        await fails(E.RECIPIENT_NOT_ALLOWED, scoped, [S(500n * CKB), KEY_CELL], [{ lock, capacity: 100n * CKB }, S(400n * CKB), KEY_CELL]);
      });

      it("an input under the owner's code and args with another hash_type does not grant owner mode", async () => {
        await fails(E.NOT_AUTHORIZED, scope100, [S(500n * CKB), { lock: "owner-data1", capacity: 61n * CKB }], [
          { lock: "stranger", capacity: 561n * CKB },
        ]);
      });

      it("the same lookalike next to the key leaves the spend in session mode", async () => {
        await fails(E.OUTFLOW_EXCEEDED, scope100, [S(500n * CKB), { lock: "owner-data1", capacity: 61n * CKB }, KEY_CELL], [
          { lock: "stranger", capacity: 561n * CKB },
          KEY_CELL,
        ]);
      });

      it("an owner-locked output grants nothing: returning funds to the owner is still outflow", async () => {
        await fails(E.OUTFLOW_EXCEEDED, scope100, [S(500n * CKB), KEY_CELL], [{ lock: "owner", capacity: 200n * CKB }, S(300n * CKB), KEY_CELL]);
      });

      it("an owner-locked cell in cell deps does not grant owner mode", async () => {
        await fails(E.NOT_AUTHORIZED, scope100, [S(500n * CKB)], [{ lock: "stranger", capacity: 500n * CKB }], { depLocks: ["owner"] });
      });

      it("an owner-locked cell in cell deps, with the key present, leaves the spend in session mode", async () => {
        await fails(E.OUTFLOW_EXCEEDED, scope100, [S(500n * CKB), KEY_CELL], [{ lock: "stranger", capacity: 500n * CKB }, KEY_CELL], {
          depLocks: ["owner", "session"],
        });
      });

      // Args a malicious app could write when it builds the opening transaction. The lock
      // cannot tell; openSession generates the key itself, so its args never do this.
      it("args whose owner is the key's own lock give the key owner mode (an opening the library never builds)", async () => {
        await ok(scope100, [S(500n * CKB), KEY_CELL], [{ lock: "stranger", capacity: 561n * CKB }], { ownerIsKey: true });
      });
    });

    describe("capacity overflow and zero capacity", () => {
      it("rejects session inputs whose capacities overflow a u64 together", async () => {
        await fails(E.CAPACITY_OVERFLOW, scope100, [S(1n << 63n), S(1n << 63n), KEY_CELL], [S(500n * CKB), KEY_CELL]);
      });

      it("rejects key-locked outputs whose capacities overflow a u64 together (recipient set)", async () => {
        await fails(E.CAPACITY_OVERFLOW, scoped, [S(500n * CKB), KEY_CELL], [
          S(500n * CKB),
          { lock: "key", capacity: 1n << 63n },
          { lock: "key", capacity: 1n << 63n },
        ]);
      });

      it("rejects a zero-capacity payment to a third party (recipient set)", async () => {
        await fails(E.RECIPIENT_NOT_ALLOWED, scoped, [S(500n * CKB), KEY_CELL], [{ lock: "stranger", capacity: 0n }, S(500n * CKB), KEY_CELL]);
      });

      it("rejects a zero-capacity second change cell", async () => {
        await fails(E.TOO_MANY_CHANGE_CELLS, scope100, [S(500n * CKB), KEY_CELL], [S(500n * CKB), S(0n), KEY_CELL]);
      });

      it("max_per_tx 0: rejects one shannon of outflow", async () => {
        await fails(E.OUTFLOW_EXCEEDED, { maxPerTx: 0n }, [S(500n * CKB), KEY_CELL], [S(500n * CKB - 1n), KEY_CELL]);
      });

      it("max_per_tx 0: accepts a spend that moves nothing, fee paid by the key cell", async () => {
        await ok({ maxPerTx: 0n }, [S(500n * CKB), KEY_CELL], [S(500n * CKB), { lock: "key", capacity: 61n * CKB - 1000n }]);
      });
    });

    describe("witnesses and cell deps", () => {
      const junk = [
        ccc.hexFrom(ccc.WitnessArgs.from({ lock: "0x" + "01".repeat(65) }).toBytes()),
        "0xdeadbeef",
        "0x",
      ];

      it("ignores witnesses: a forged signature at the session input changes nothing", async () => {
        await fails(E.OUTFLOW_EXCEEDED, scope100, [S(500n * CKB), KEY_CELL], [{ lock: "stranger", capacity: 101n * CKB }, S(399n * CKB), KEY_CELL], {
          witnesses: junk,
        });
        await fails(E.NOT_AUTHORIZED, scope100, [S(500n * CKB)], [{ lock: "stranger", capacity: 500n * CKB }], { witnesses: junk });
      });

      it("the same binary under hash_type data1 (VM v1) enforces the same limit", async () => {
        const v1 = (c: bigint, since?: bigint): Cell => ({ lock: "session-data1", capacity: c, since });
        await okGroup("session-data1", scope100, [v1(500n * CKB), KEY_CELL], [{ lock: "stranger", capacity: 100n * CKB }, v1(400n * CKB), KEY_CELL]);
        await failsGroup("session-data1", E.OUTFLOW_EXCEEDED, scope100, [v1(500n * CKB), KEY_CELL], [
          { lock: "stranger", capacity: 101n * CKB },
          v1(399n * CKB),
          KEY_CELL,
        ]);
      });

      it("change under the same code and args but hash_type data2 is not change for a data1 session", async () => {
        await failsGroup("session-data1", E.OUTFLOW_EXCEEDED, scope100, [{ lock: "session-data1", capacity: 500n * CKB }, KEY_CELL], [
          S(500n * CKB),
          KEY_CELL,
        ]);
      });
    });

    // The real DAO and Type ID scripts are not in these transactions, so only the
    // session lock's group runs; every outcome below is the session lock's own.
    describe("Nervos DAO deposits and Type ID cells", () => {
      it("rejects change turned into a DAO deposit", async () => {
        await fails(E.TYPED_CELL, scope100, [S(500n * CKB), KEY_CELL], [{ ...S(500n * CKB), dao: true }, KEY_CELL]);
      });

      it("rejects paying the recipient in a DAO deposit (recipient set)", async () => {
        await fails(E.TYPED_CELL, scoped, [S(500n * CKB), KEY_CELL], [{ lock: "recipient", capacity: 100n * CKB, dao: true }, S(400n * CKB), KEY_CELL]);
      });

      it("rejects returning funds to the owner as a DAO deposit (recipient set)", async () => {
        await fails(E.TYPED_CELL, scoped, [S(500n * CKB), KEY_CELL], [{ lock: "owner", capacity: 100n * CKB, dao: true }, S(400n * CKB), KEY_CELL]);
      });

      it("no recipient: a DAO deposit for a third party is a payment like any other, capped by max_per_tx", async () => {
        await okGroup("session", scope100, [S(500n * CKB), KEY_CELL], [{ lock: "stranger", capacity: 100n * CKB, dao: true }, S(400n * CKB), KEY_CELL]);
        await fails(E.OUTFLOW_EXCEEDED, scope100, [S(500n * CKB), KEY_CELL], [
          { lock: "stranger", capacity: 101n * CKB, dao: true },
          S(399n * CKB),
          KEY_CELL,
        ]);
      });

      it("a session cell deposited in the DAO: the key cannot withdraw it, the owner can", async () => {
        const deposit: Cell = { ...S(500n * CKB), dao: true };
        await fails(E.TYPED_CELL, scope100, [deposit, KEY_CELL], [{ lock: "stranger", capacity: 100n * CKB }, S(400n * CKB), KEY_CELL]);
        await okGroup("session", scope100, [deposit, { lock: "owner", capacity: 61n * CKB }], [{ lock: "owner", capacity: 561n * CKB }]);
      });

      it("rejects change given a real Type ID type script (the CKB-VM twin of testnet step 8)", async () => {
        await fails(E.TYPED_CELL, scoped, [S(500n * CKB), KEY_CELL], [{ ...S(500n * CKB), typeId: true }, { lock: "key", capacity: 61n * CKB - 1000n }]);
      });

      it("rejects paying the recipient in a Type ID cell (recipient set)", async () => {
        await fails(E.TYPED_CELL, scoped, [S(500n * CKB), KEY_CELL], [{ lock: "recipient", capacity: 100n * CKB, typeId: true }, S(400n * CKB), KEY_CELL]);
      });

      it("rejects spending a session cell that carries a Type ID", async () => {
        await fails(E.TYPED_CELL, scope100, [{ ...S(500n * CKB), typeId: true }, KEY_CELL], PAY);
      });
    });

    describe("oversized args", () => {
      // The lock reads its script into a 256-byte buffer; anything larger is refused, not overrun.
      it.each([204, 1000])("rejects %i-byte args without reading past its buffer", async (n) => {
        await fails(E.BAD_ARGS, scope100, [S(500n * CKB), KEY_CELL], [KEY_CELL], { argsOverride: "0x" + "00".repeat(n) });
      });
    });
  });

  // Audit, 30 Oct 2026. Accepted behaviour of the deployed lock, documented in the
  // README ("If a session key leaks") and docs/API.md (`openSession`).
  describe("audit 30 Oct: what the recipient rule does not cover", () => {
    const scoped: Scope = { maxPerTx: 100n * CKB, recipient: true };

    // The fee is not an output, so the recipient rule never sees it: up to max_per_tx can
    // go to the miner. Accepted; the docs say so and recommend a rate limit with a recipient.
    it("AUDIT-1 (accepted, documented): with a recipient, up to max_per_tx can still leave as the miner fee", async () => {
      await ok(scoped, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "session", capacity: 400n * CKB },
        KEY_CELL,
      ]);
    });

    // The session cell's own witness is covered by no signature: the key's secp256k1
    // sighash_all signs only its own group's witnesses and those past the last input.
    // The lock reads no witness, so anyone relaying the transaction can put a WitnessArgs
    // with an inputType there without changing the tx hash or invalidating it.
    it("AUDIT-2: accepts an unsigned WitnessArgs carrying an inputType at the session input", async () => {
      const injected = ccc.hexFrom(ccc.WitnessArgs.from({ inputType: "0x" + "72".repeat(10) }).toBytes());
      await ok(scope100, [{ lock: "session", capacity: 500n * CKB }, KEY_CELL], [
        { lock: "stranger", capacity: 100n * CKB },
        { lock: "session", capacity: 400n * CKB },
        KEY_CELL,
      ], { witnesses: [injected, ccc.hexFrom(ccc.WitnessArgs.from({ inputType: "0x01", lock: "0x" + "00".repeat(65) }).toBytes())] });
    });
  });
  // Mentor review, 2 Nov 2026 (CKBuilder-projects#47): aggregate outflow across several
  // inputs. A script group is every input under the same lock script (same code, same
  // args), so cells of one session or one subscription are checked together, against one
  // limit per transaction; cells with other args are other groups, each checked on its own
  // against the whole transaction. Listed in docs/SECURITY-EVIDENCE.md, "Aggregate outflow".
  describe("aggregate outflow across inputs (review 2 Nov)", () => {
    /** Build once; check the session group and the sibling group separately. */
    const both = (...a: Parameters<typeof build>) => {
      const { verifier, hashes } = build(...a);
      return {
        session: { ok: () => verifier.verifySuccess(false, { codeHash: hashes.session }), fails: (code: number) => verifier.verifyFailure(code, false, { codeHash: hashes.session }) },
        sibling: { ok: () => verifier.verifySuccess(false, { codeHash: hashes.sibling }), fails: (code: number) => verifier.verifyFailure(code, false, { codeHash: hashes.sibling }) },
      };
    };
    const S = (capacity: bigint, since?: bigint): Cell => ({ lock: "session", capacity, since });
    const B = (capacity: bigint, since?: bigint): Cell => ({ lock: "sibling", capacity, since });
    const OWNER: Cell = { lock: "owner", capacity: 61n * CKB };
    const KEY_FEE: Cell = { lock: "key", capacity: 61n * CKB - 1000n };
    const T = 1_000_000n;

    describe("cells with the same args: one limit per transaction, not per cell", () => {
      it("refuses max_per_tx taken from each of three cells (300 out, limit 100)", async () => {
        await fails(
          E.OUTFLOW_EXCEEDED,
          scope100,
          [S(200n * CKB), S(200n * CKB), S(200n * CKB), KEY_CELL],
          [{ lock: "stranger", capacity: 300n * CKB }, S(300n * CKB), KEY_CELL],
        );
      });

      it("refuses cells taken whole with no change when together they pass the limit", async () => {
        await fails(E.OUTFLOW_EXCEEDED, scope100, [S(61n * CKB), S(61n * CKB), KEY_CELL], [
          { lock: "stranger", capacity: 122n * CKB },
          KEY_CELL,
        ]);
      });

      it("accepts exactly max_per_tx across three cells merged into one change cell", async () => {
        await ok(
          scope100,
          [S(200n * CKB), S(200n * CKB), S(200n * CKB), KEY_CELL],
          [{ lock: "stranger", capacity: 100n * CKB }, S(500n * CKB), KEY_CELL],
        );
      });

      it("token session: refuses max_per_tx_token taken from each of two cells", async () => {
        const tok: Scope = { maxPerTx: 100n * CKB, tokenMaxPerTx: 10n * T };
        await fails(
          E.TOKEN_OUTFLOW_EXCEEDED,
          tok,
          [{ ...S(200n * CKB), token: 50n * T }, { ...S(200n * CKB), token: 50n * T }, KEY_CELL],
          [{ lock: "stranger", capacity: 1n * CKB, token: 20n * T }, { ...S(399n * CKB), token: 80n * T }, KEY_CELL],
        );
      });

      it("token session: accepts exactly max_per_tx_token across two cells", async () => {
        const tok: Scope = { maxPerTx: 100n * CKB, tokenMaxPerTx: 10n * T };
        await ok(
          tok,
          [{ ...S(200n * CKB), token: 50n * T }, { ...S(200n * CKB), token: 50n * T }, KEY_CELL],
          [{ lock: "stranger", capacity: 1n * CKB, token: 10n * T }, { ...S(399n * CKB), token: 90n * T }, KEY_CELL],
        );
      });

      // What the min_interval = 0 warning is about: each spend is within the limit, and
      // the change of one can be spent again at once, so spends repeat until the cell is dry.
      it("min_interval 0: the change of a spend can be spent again at once, with no since", async () => {
        await ok(scope100, [S(400n * CKB), KEY_CELL], [{ lock: "stranger", capacity: 100n * CKB }, S(300n * CKB), KEY_CELL]);
        await ok(scope100, [S(300n * CKB), KEY_CELL], [{ lock: "stranger", capacity: 100n * CKB }, S(200n * CKB), KEY_CELL]);
        await fails(E.RATE_LIMITED, { ...scope100, minInterval: 10n }, [S(300n * CKB), KEY_CELL], [
          { lock: "stranger", capacity: 100n * CKB },
          S(200n * CKB),
          KEY_CELL,
        ]);
      });
    });

    describe("one subscription, mature cells merged in one charge", () => {
      const PERIOD = 20n;
      const PRICE = 10n * CKB;
      const sub: Scope = { maxPerTx: PRICE, minInterval: PERIOD, recipient: true };
      const mature = (capacity: bigint) => S(capacity, relativeBlocks(PERIOD));

      it("accepts two mature cells merged, one price in total", async () => {
        await ok(
          sub,
          [mature(300n * CKB), mature(200n * CKB), KEY_CELL],
          [{ lock: "recipient", capacity: PRICE }, S(490n * CKB), KEY_FEE],
        );
      });

      it("refuses one price from each of two mature cells (two prices in one charge)", async () => {
        await fails(
          E.OUTFLOW_EXCEEDED,
          sub,
          [mature(300n * CKB), mature(200n * CKB), KEY_CELL],
          [{ lock: "recipient", capacity: 2n * PRICE }, S(480n * CKB), KEY_FEE],
        );
      });

      it("refuses two prices paid as two outputs to the payout address", async () => {
        await fails(
          E.OUTFLOW_EXCEEDED,
          sub,
          [mature(300n * CKB), mature(200n * CKB), KEY_CELL],
          [{ lock: "recipient", capacity: PRICE }, { lock: "recipient", capacity: PRICE }, S(480n * CKB), KEY_FEE],
        );
      });

      it("refuses merging a young cell with a mature one", async () => {
        await fails(
          E.RATE_LIMITED,
          sub,
          [mature(300n * CKB), S(200n * CKB, relativeBlocks(PERIOD - 1n)), KEY_CELL],
          [{ lock: "recipient", capacity: PRICE }, S(490n * CKB), KEY_FEE],
        );
      });

      describe.skipIf(!existsSync(XUDT_BINARY))("token subscription, real xUDT", () => {
        const xudt = { xudt: true };
        const tokSub: Scope = { maxPerTx: 0n, minInterval: PERIOD, tokenMaxPerTx: 10n * T, recipient: true };
        const subCell = (amount: bigint, since?: bigint): Cell => ({ lock: "session", capacity: 282n * CKB, token: amount, since });
        const payout = (amount: bigint): Cell => ({ lock: "recipient", capacity: 142n * CKB, token: amount });

        it("accepts two mature token cells merged, one price in total, no CKB out", async () => {
          await ok(
            tokSub,
            [subCell(50n * T, relativeBlocks(PERIOD)), subCell(50n * T, relativeBlocks(PERIOD)), payout(0n), KEY_CELL],
            [payout(10n * T), { ...subCell(90n * T), capacity: 564n * CKB }, KEY_FEE],
            xudt,
          );
        });

        it("refuses one price from each of two mature token cells", async () => {
          await fails(
            E.TOKEN_OUTFLOW_EXCEEDED,
            tokSub,
            [subCell(50n * T, relativeBlocks(PERIOD)), subCell(50n * T, relativeBlocks(PERIOD)), payout(0n), KEY_CELL],
            [payout(20n * T), { ...subCell(80n * T), capacity: 564n * CKB }, KEY_FEE],
            xudt,
          );
        });
      });
    });

    describe("cells with different args: each checked on its own", () => {
      // Two subscriptions of one creator: same charger key and payout address, two subscribers.
      const PERIOD = 20n;
      const PRICE = 10n * CKB;
      const sub: Scope = { maxPerTx: PRICE, minInterval: PERIOD, recipient: true };
      const other = { sibling: { ...sub, owner: "stranger" as const } };
      const m = relativeBlocks(PERIOD);

      it("two subscriptions charged in one transaction with change: both refuse, 13 (the other's change is anyone else)", async () => {
        const g = both(
          sub,
          [S(500n * CKB, m), B(500n * CKB, m), KEY_CELL],
          [{ lock: "recipient", capacity: 2n * PRICE }, S(490n * CKB), B(490n * CKB), KEY_FEE],
          other,
        );
        await g.session.fails(E.RECIPIENT_NOT_ALLOWED);
        await g.sibling.fails(E.RECIPIENT_NOT_ALLOWED);
      });

      // Possible only when no change is left (cells at most the price, L1), but it shows each group alone.
      it("two subscriptions taken whole in one transaction, each within its own price: both accept", async () => {
        const g = both(
          sub,
          [S(PRICE, m), B(PRICE, m), KEY_CELL],
          [{ lock: "recipient", capacity: 2n * PRICE }, KEY_FEE],
          other,
        );
        await g.session.ok();
        await g.sibling.ok();
      });

      it("no pooling: one subscription's unused price does not cover the other's overcharge", async () => {
        const g = both(
          sub,
          [S(PRICE + 5n * CKB, m), B(5n * CKB, m), KEY_CELL],
          [{ lock: "recipient", capacity: 2n * PRICE }, KEY_FEE],
          other,
        );
        await g.session.fails(E.OUTFLOW_EXCEEDED);
        await g.sibling.ok();
      });

      it("a recipient-scoped session spent next to an unrestricted one: the payment to a stranger is refused by the scoped one, 13", async () => {
        const g = both(
          { ...scope100, recipient: true },
          [S(500n * CKB), B(500n * CKB), KEY_CELL],
          [{ lock: "recipient", capacity: 100n * CKB }, { lock: "stranger", capacity: 100n * CKB }, S(400n * CKB), B(400n * CKB), KEY_CELL],
          { sibling: { maxPerTx: 1000n * CKB } },
        );
        await g.sibling.ok(); // no recipient of its own: within its limit, it accepts
        await g.session.fails(E.RECIPIENT_NOT_ALLOWED);
      });

      it("an unrestricted sibling's rate limit of 0 does not lift this session's: its young cell is refused, 14", async () => {
        const g = both(
          { ...scope100, minInterval: 10n },
          [S(500n * CKB, relativeBlocks(9n)), B(500n * CKB), KEY_CELL],
          [{ lock: "stranger", capacity: 200n * CKB }, S(400n * CKB), B(400n * CKB), KEY_CELL],
          { sibling: { maxPerTx: 100n * CKB } },
        );
        await g.session.fails(E.RATE_LIMITED);
        await g.sibling.ok();
      });

      it("token sessions: moving tokens into a looser sibling token session is outflow, 20", async () => {
        const tok: Scope = { maxPerTx: 100n * CKB, tokenMaxPerTx: 10n * T };
        const g = both(
          tok,
          [{ ...S(200n * CKB), token: 100n * T }, { ...B(200n * CKB), token: 0n }, KEY_CELL],
          [{ ...S(200n * CKB), token: 50n * T }, { ...B(200n * CKB), token: 50n * T }, KEY_CELL],
          { sibling: { maxPerTx: 100n * CKB, tokenMaxPerTx: 1000n * T } },
        );
        await g.session.fails(E.TOKEN_OUTFLOW_EXCEEDED);
        await g.sibling.ok();
      });
    });

    describe("owner mode with several cells (cancel, recovery)", () => {
      it("sweeps three same-args cells in one transaction: young, rate-limited, recipient-scoped, no since", async () => {
        await ok(
          { ...scope100, minInterval: 10n, recipient: true },
          [S(500n * CKB), S(200n * CKB), S(153n * CKB), OWNER],
          [{ lock: "owner", capacity: 914n * CKB }],
        );
      });

      it("a subscriber cancels with two subscription cells and a planted one, in one transaction", async () => {
        await ok(
          { maxPerTx: 10n * CKB, minInterval: 20n, recipient: true },
          [S(490n * CKB, relativeBlocks(20n)), S(300n * CKB), S(61n * CKB), OWNER],
          [{ lock: "owner", capacity: 912n * CKB }],
        );
      });

      it("recovery sweeps two sessions with different args of one owner in one transaction (both groups accept)", async () => {
        await ok(
          { ...scope100, minInterval: 10n },
          [S(500n * CKB), S(300n * CKB), B(200n * CKB), B(200n * CKB), OWNER],
          [{ lock: "owner", capacity: 1261n * CKB }],
          { sibling: { maxPerTx: 1n * CKB, recipient: true } },
        );
      });

      it("one owner's input does not give owner mode to another owner's session in the same transaction", async () => {
        const g = both(
          scope100,
          [S(500n * CKB), B(500n * CKB), OWNER],
          [{ lock: "owner", capacity: 1061n * CKB }],
          { sibling: { maxPerTx: 100n * CKB, owner: "stranger" } },
        );
        await g.session.ok();
        await g.sibling.fails(E.NOT_AUTHORIZED);
      });

      describe.skipIf(!existsSync(XUDT_BINARY))("token subscription, real xUDT", () => {
        it("the subscriber cancels two token cells of one subscription in one transaction, every token back", async () => {
          await ok(
            { maxPerTx: 0n, minInterval: 20n, tokenMaxPerTx: 10n * T, recipient: true },
            [
              { ...S(282n * CKB, relativeBlocks(20n)), token: 60n * T },
              { ...S(282n * CKB), token: 30n * T },
              OWNER,
            ],
            [{ lock: "owner", capacity: 625n * CKB - 1000n, token: 90n * T }],
            { xudt: true },
          );
        });
      });
    });
  });
});
