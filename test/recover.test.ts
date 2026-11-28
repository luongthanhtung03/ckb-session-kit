import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionLockScript, TESTNET_DEPLOYMENT as d, TESTNET_LEGACY_DEPLOYMENTS } from "../src/lock.js";
import {
  assertSigningLock,
  openSession,
  ownerSweep,
  recoverSessions,
  SendOutcomeUnknownError,
  SessionBalanceError,
  tokenData,
} from "../src/onchain.js";
import { sessionAddress } from "../src/transfer.js";
import { createSession } from "../src/session.js";

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;
const ownerLock = ccc.Script.from({ codeHash: h("aa"), hashType: "type", args: "0x" + "11".repeat(20) });
const op = (i: number) => ccc.OutPoint.from({ txHash: h("0" + (i % 10)), index: i });
const cell = (i: number, sessionKey: string, capacity: bigint) =>
  ccc.Cell.from({
    outPoint: op(i),
    cellOutput: {
      lock: sessionLockScript(d, { ownerLockHash: ownerLock.hash(), sessionLockHash: h(sessionKey), maxPerTx: 5n * CKB }),
      capacity,
    },
    outputData: "0x",
  });

/**
 * An owner whose chain holds `cells`; `send` decides which transactions the node
 * accepts, and with `lostReply` the node takes them but the reply never arrives.
 */
function fakeOwner(cells: ccc.Cell[], send: (tx: ccc.Transaction) => boolean, o: { lostReply?: boolean; plain?: boolean } = {}) {
  const sent: ccc.Transaction[] = [];
  const pool = new Set<string>();
  const sendTransaction = async (tx: ccc.Transaction) => {
    if (!send(tx)) throw new Error("dead input");
    sent.push(tx);
    pool.add(tx.hash());
    if (o.lostReply) throw new Error("request timed out");
    return tx.hash();
  };
  const owner = {
    client: {
      async *findCells(key: { script: ccc.ScriptLike; scriptSearchMode?: string }) {
        // The owner sweep's proof input: a plain cell under the owner's lock itself.
        if (key.scriptSearchMode === "exact") return yield* owner.findCells({}, true);
        const prefix = ccc.Script.from(key.script).args;
        for (const c of cells) if (c.cellOutput.lock.args.startsWith(prefix)) yield c;
      },
      sendTransaction,
      getTransaction: async (hash: ccc.HexLike) => (pool.has(ccc.hexFrom(hash)) ? { status: "pending" } : undefined),
    },
    getRecommendedAddressObj: async () => ({ script: ownerLock }),
    async *findCells() {
      if (o.plain === false) return;
      yield ccc.Cell.from({ outPoint: op(9), cellOutput: { lock: ownerLock, capacity: 100n * CKB }, outputData: "0x" });
    },
    signTransaction: async (tx: ccc.Transaction) => tx,
    sendTransaction,
  } as unknown as ccc.Signer;
  return { owner, sent };
}

afterEach(() => vi.restoreAllMocks());

describe("recoverSessions", () => {
  // Audit round 2, 31 Oct: new sessions refuse legacy deployments; recovery must not.
  it("still sweeps a session under a legacy deployment (no code-cell or legacy check on the way out)", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    const legacy = TESTNET_LEGACY_DEPLOYMENTS[0];
    const old = ccc.Cell.from({
      outPoint: op(4),
      cellOutput: { lock: sessionLockScript(legacy, { ownerLockHash: ownerLock.hash(), sessionLockHash: h("b4"), maxPerTx: 5n * CKB }), capacity: 300n * CKB },
      outputData: "0x",
    });
    const { owner, sent } = fakeOwner([old], () => true);
    expect(await recoverSessions(owner, legacy)).toMatchObject({ recovered: 300n * CKB, cells: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].cellDeps.some((c) => c.outPoint.eq(ccc.OutPoint.from(legacy.cellDep.outPoint)))).toBe(true);
  });

  it("sweeps everything in one transaction when it can", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    const { owner, sent } = fakeOwner([cell(1, "b1", 400n * CKB), cell(2, "b2", 200n * CKB)], () => true);
    expect(await recoverSessions(owner, d)).toMatchObject({ recovered: 600n * CKB, cells: 2, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  // Found in review: anyone can plant a session cell with this owner's hash and
  // their own key, then spend it ahead of the sweep. One shared transaction would
  // then fail and recover nothing; each session swept alone, only that one fails.
  it("falls back to one sweep per session when a planted cell is spent first", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    const planted = cell(3, "a7", 121n * CKB);
    const { owner, sent } = fakeOwner([cell(1, "b1", 400n * CKB), planted, cell(2, "b2", 200n * CKB)], (tx) =>
      tx.inputs.every((i) => !i.previousOutput.eq(planted.outPoint)),
    );
    expect(await recoverSessions(owner, d)).toMatchObject({ recovered: 600n * CKB, cells: 2, failed: 1 });
    expect(sent).toHaveLength(2);
  });

  // Review, 28 Oct: a sweep the node took, whose reply was lost, is a success.
  it("reports a sweep the node accepted as recovered when the reply times out", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    const { owner, sent } = fakeOwner([cell(1, "b1", 400n * CKB), cell(2, "b2", 200n * CKB)], () => true, { lostReply: true });
    expect(await recoverSessions(owner, d)).toEqual({ txHashes: [sent[0].hash()], recovered: 600n * CKB, cells: 2, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  // Review, 28 Oct: a fault no retry can fix is thrown, not hidden behind one failed sweep per session.
  it("throws when the owner has no plain cell, instead of retrying each session", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    const { owner } = fakeOwner([cell(1, "b1", 400n * CKB), cell(2, "b2", 200n * CKB)], () => true, { plain: false });
    await expect(recoverSessions(owner, d)).rejects.toThrow(/plain cell to prove ownership/);
  });

  it("the no-plain-cell refusal carries reason no-owner-cell, from recoverSessions and ownerSweep", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    const cells = [cell(1, "b1", 400n * CKB), cell(2, "b2", 200n * CKB)];
    const { owner, sent } = fakeOwner(cells, () => true, { plain: false });
    const e = await recoverSessions(owner, d).catch((x) => x);
    expect(e).toBeInstanceOf(SessionBalanceError);
    expect(e).toMatchObject({ reason: "no-owner-cell", message: "the owner needs one plain cell to prove ownership" });
    await expect(ownerSweep(owner, d, cells)).rejects.toMatchObject({ reason: "no-owner-cell" });
    expect(sent).toHaveLength(0);
  });

  // Review, 26 Nov: a fault thrown by the one-session-at-a-time sweeps after an
  // earlier sweep was sent lost that sweep's hash; the caller saw nothing happen.
  it("returns the sweeps already sent when a later session hits no-owner-cell", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    const cells = [cell(1, "b1", 400n * CKB), cell(2, "b2", 200n * CKB), cell(3, "b3", 100n * CKB)];
    // The combined sweep (every session at once) is refused, so each is swept alone.
    const { owner, sent } = fakeOwner(cells, (tx) => tx.inputs.length < 3);
    // The owner's plain cell is found for the combined attempt and the first
    // session's sweep only (spent by it, its change not yet indexed).
    const plain = owner.findCells.bind(owner);
    let calls = 0;
    (owner as { findCells: unknown }).findCells = async function* (...a: Parameters<typeof plain>) {
      if (++calls <= 2) yield* plain(...a);
    };
    const r = await recoverSessions(owner, d);
    expect(sent).toHaveLength(1);
    expect(r).toMatchObject({ txHashes: [sent[0].hash()], recovered: 400n * CKB, cells: 1, failed: 2 });
    expect(r.error).toBeInstanceOf(SessionBalanceError);
    expect(r.error).toMatchObject({ reason: "no-owner-cell" });
  });

  it("returns the sweeps already sent when a later session's send is refused", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    const b2 = cell(2, "b2", 200n * CKB);
    const { owner, sent } = fakeOwner([cell(1, "b1", 400n * CKB), b2], (tx) =>
      tx.inputs.every((i) => !i.previousOutput.eq(b2.outPoint)),
    );
    const r = await recoverSessions(owner, d);
    expect(r).toEqual({ txHashes: [sent[0].hash()], recovered: 400n * CKB, cells: 1, failed: 1 });
    expect(sent).toHaveLength(1);
  });

  it("still throws no-owner-cell from the one-at-a-time sweeps when nothing was sent", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    const { owner, sent } = fakeOwner([cell(1, "b1", 400n * CKB), cell(2, "b2", 200n * CKB)], (tx) => tx.inputs.length < 3);
    const plain = owner.findCells.bind(owner);
    let calls = 0;
    (owner as { findCells: unknown }).findCells = async function* (...a: Parameters<typeof plain>) {
      if (++calls <= 1) yield* plain(...a);
    };
    await expect(recoverSessions(owner, d)).rejects.toMatchObject({ reason: "no-owner-cell" });
    expect(sent).toHaveLength(0);
  });

  // Review, 26 Nov: a one-session sweep whose outcome was unknown (send failed,
  // status lookup failed) was only counted in `failed`; its hash, which may still
  // commit, was lost.
  it("returns the hash of a one-session sweep whose outcome is unknown", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    const b2 = cell(2, "b2", 200n * CKB);
    let b2Hash: ccc.Hex | undefined;
    const { owner, sent } = fakeOwner([cell(1, "b1", 400n * CKB), b2, cell(3, "b3", 300n * CKB)], (tx) => {
      if (tx.inputs.length > 2) return false; // the combined sweep: refused, known
      if (!tx.inputs.some((i) => i.previousOutput.eq(b2.outPoint))) return true;
      b2Hash = tx.hash();
      return false;
    });
    // b2's sweep fails and the node cannot then be asked about it.
    const known = owner.client.getTransaction.bind(owner.client);
    (owner.client as { getTransaction: unknown }).getTransaction = async (hash: ccc.HexLike) => {
      if (ccc.hexFrom(hash) === b2Hash) throw new Error("node unreachable");
      return known(hash);
    };
    const r = await recoverSessions(owner, d);
    expect(sent).toHaveLength(2);
    expect(r).toMatchObject({ txHashes: sent.map((t) => t.hash()), recovered: 700n * CKB, cells: 2, failed: 1 });
    expect(r.error).toBeUndefined();
    expect(r.unknown).toHaveLength(1);
    expect(r.unknown?.[0]).toBeInstanceOf(SendOutcomeUnknownError);
    expect(r.unknown?.[0].txHash).toBe(b2Hash);
  });

  it("returns, not throws, a later no-owner-cell when the combined sweep's outcome is unknown", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    let combined: ccc.Hex | undefined;
    const { owner, sent } = fakeOwner([cell(1, "b1", 400n * CKB), cell(2, "b2", 200n * CKB)], (tx) => {
      combined = tx.hash();
      return false;
    });
    (owner.client as { getTransaction: unknown }).getTransaction = async () => {
      throw new Error("node unreachable");
    };
    // The combined sweep may have spent the owner's plain cell: none is found after it.
    const plain = owner.findCells.bind(owner);
    let calls = 0;
    (owner as { findCells: unknown }).findCells = async function* (...a: Parameters<typeof plain>) {
      if (++calls <= 1) yield* plain(...a);
    };
    const r = await recoverSessions(owner, d);
    expect(sent).toHaveLength(0);
    expect(r).toMatchObject({ txHashes: [], recovered: 0n, cells: 0, failed: 2 });
    expect(r.error).toMatchObject({ reason: "no-owner-cell" });
    expect(r.unknown?.map((e) => e.txHash)).toEqual([combined]);
  });

  // Review, 27 Nov (L2): the two paths below had no test.
  it("keeps an unknown combined sweep in `unknown` when every one-session sweep then lands", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    let combined: ccc.Hex | undefined;
    const { owner, sent } = fakeOwner([cell(1, "b1", 400n * CKB), cell(2, "b2", 200n * CKB)], (tx) => {
      if (tx.inputs.length < 3) return true;
      combined = tx.hash();
      return false;
    });
    const known = owner.client.getTransaction.bind(owner.client);
    (owner.client as { getTransaction: unknown }).getTransaction = async (hash: ccc.HexLike) => {
      if (ccc.hexFrom(hash) === combined) throw new Error("node unreachable");
      return known(hash);
    };
    const r = await recoverSessions(owner, d);
    expect(sent).toHaveLength(2);
    expect(r).toMatchObject({ txHashes: sent.map((t) => t.hash()), recovered: 600n * CKB, cells: 2, failed: 0 });
    expect(r.error).toBeUndefined();
    expect(r.unknown?.map((e) => e.txHash)).toEqual([combined]);
  });

  it("returns, not throws, a later no-owner-cell after a one-session sweep whose outcome is unknown", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    const b1 = cell(1, "b1", 400n * CKB);
    let b1Hash: ccc.Hex | undefined;
    const { owner, sent } = fakeOwner([b1, cell(2, "b2", 200n * CKB)], (tx) => {
      if (tx.inputs.length === 2 && tx.inputs.some((i) => i.previousOutput.eq(b1.outPoint))) b1Hash = tx.hash();
      return false; // the combined sweep refused (known), b1's sweep lost (unknown)
    });
    const known = owner.client.getTransaction.bind(owner.client);
    (owner.client as { getTransaction: unknown }).getTransaction = async (hash: ccc.HexLike) => {
      if (ccc.hexFrom(hash) === b1Hash) throw new Error("node unreachable");
      return known(hash);
    };
    // Plain owner cell for the combined attempt and b1's sweep only: b2's finds none.
    const plain = owner.findCells.bind(owner);
    let calls = 0;
    (owner as { findCells: unknown }).findCells = async function* (...a: Parameters<typeof plain>) {
      if (++calls <= 2) yield* plain(...a);
    };
    const r = await recoverSessions(owner, d);
    expect(sent).toHaveLength(0);
    expect(r).toMatchObject({ txHashes: [], recovered: 0n, cells: 0, failed: 2 });
    expect(r.error).toMatchObject({ reason: "no-owner-cell" });
    expect(r.unknown?.map((e) => e.txHash)).toEqual([b1Hash]);
  });
});

const XUDT = { codeHash: h("cd"), hashType: "type" as const };
const XUDT_DEP = { outPoint: { txHash: h("ce"), index: 0 }, depType: "code" as const };

/**
 * A node that tracks live and spent cells, with replace-by-fee on, and an
 * indexer that lags: it lists the owner's plain cells in `indexed` and never
 * the outputs of a sweep sent in the call. No client cache, and `getCell`
 * answers for indexed cells only, never for an output still in the pool. A
 * spend of a cell spent by a committed transaction is refused with `Dead`, one
 * spent by a transaction in the pool with an RBF refusal (as CKB with RBF on),
 * one the node does not know with `Unknown`. `verdict` can refuse a sweep for
 * other reasons ("refuse"), lose it ("unknown": the send fails and the node
 * cannot be asked), or answer as a fallback node that does not know `cell`.
 * CCC's own `completeFeeBy` runs against it.
 */
function chainOwner(
  cells: ccc.Cell[],
  o: {
    committed?: ccc.OutPoint[];
    pooled?: ccc.OutPoint[];
    indexed?: ccc.Cell[];
    live?: ccc.Cell[];
    lostReply?: boolean;
    verdict?: (tx: ccc.Transaction) => "ok" | "refuse" | "unknown" | { unknownCell: ccc.OutPoint };
    afterSend?: (tx: ccc.Transaction) => void;
  } = {},
) {
  const key = (p: ccc.OutPointLike) => ccc.hexFrom(ccc.OutPoint.from(p).toBytes());
  const plain = ccc.Cell.from({ outPoint: op(9), cellOutput: { lock: ownerLock, capacity: 100n * CKB }, outputData: "0x" });
  const indexed = o.indexed ?? [plain];
  const onChain = new Map([...cells, ...indexed, ...(o.live ?? [])].map((c) => [key(c.outPoint), c]));
  const live = new Set(onChain.keys());
  const spent = new Map<string, "pool" | "committed">([
    ...(o.committed ?? []).map((p) => [key(p), "committed"] as const),
    ...(o.pooled ?? []).map((p) => [key(p), "pool"] as const),
  ]);
  const sent: ccc.Transaction[] = [];
  let signed = 0;
  const pool = new Set<string>();
  const lost = new Set<string>();
  const sendTransaction = async (tx: ccc.Transaction) => {
    const verdict = o.verdict?.(tx) ?? "ok";
    for (const i of tx.inputs) {
      const k = key(i.previousOutput);
      const unknownHere = typeof verdict === "object" && i.previousOutput.eq(verdict.unknownCell);
      if (spent.get(k) === "committed") throw new Error(`PoolRejectedTransactionByOutputsValidator: Resolve(Dead(OutPoint(${k})))`);
      if (spent.get(k) === "pool") {
        throw new ccc.ErrorClientRBFRejected({ code: -1111, message: "PoolRejectedRBF", data: "RBFRejected" }, 1000, 2000);
      }
      if (!live.has(k) || unknownHere) {
        throw new ccc.ErrorClientResolveUnknown({ code: -301, message: "TransactionFailedToResolve", data: "" }, i.previousOutput);
      }
    }
    if (verdict === "unknown") {
      lost.add(tx.hash());
      throw new Error("request timed out");
    }
    if (verdict === "refuse") throw new Error("refused");
    for (const i of tx.inputs) spent.set(key(i.previousOutput), "pool");
    tx.outputs.forEach((_, index) => live.add(key({ txHash: tx.hash(), index })));
    sent.push(tx);
    pool.add(tx.hash());
    o.afterSend?.(tx);
    if (o.lostReply) throw new Error("request timed out");
    return tx.hash();
  };
  const owner = {
    client: {
      async *findCells(k: { script: ccc.ScriptLike; scriptSearchMode?: string }) {
        if (k.scriptSearchMode === "exact") {
          for (const c of indexed) yield c; // stale: spent cells stay listed, new change is not
          return;
        }
        const prefix = ccc.Script.from(k.script).args;
        for (const c of cells) if (c.cellOutput.lock.args.startsWith(prefix)) yield c;
      },
      sendTransaction,
      getTransaction: async (hash: ccc.HexLike) => {
        if (lost.has(ccc.hexFrom(hash))) throw new Error("node unreachable");
        return pool.has(ccc.hexFrom(hash)) ? { status: "pending" } : undefined;
      },
      getCell: async (p: ccc.OutPointLike) => onChain.get(key(p)),
      getFeeRate: async () => 1000n,
      getKnownScript: async (s: ccc.KnownScript) =>
        s === ccc.KnownScript.XUdt ? { ...XUDT, cellDeps: [{ cellDep: XUDT_DEP }] } : { codeHash: h("cf"), hashType: "type", cellDeps: [] },
      getCellDeps: async (...infos: ccc.CellDepInfoLike[][]) => infos.flat().map((i) => ccc.CellDepInfo.from(i).cellDep),
    },
    getRecommendedAddressObj: async () => ({ script: ownerLock }),
    async *findCells() {}, // the owner's other cells: none (fees come from the sweep)
    prepareTransaction: async (tx: ccc.Transaction) => tx,
    signTransaction: async (tx: ccc.Transaction) => {
      signed++;
      return tx;
    },
    sendTransaction,
  } as unknown as ccc.Signer;
  return {
    owner,
    sent,
    indexed,
    signatures: () => signed,
    spentElsewhere: (p: ccc.OutPointLike, how: "pool" | "committed") => spent.set(key(p), how),
  };
}

const ownerPlain = (tx: ccc.Transaction) =>
  tx.outputs.findIndex((o, i) => !o.type && o.lock.eq(ownerLock) && ccc.bytesFrom(tx.outputsData[i]).length === 0);
/** The change of `tx`: its one plain output under the owner's lock. */
const changeOf = (tx: ccc.Transaction) => ccc.OutPoint.from({ txHash: tx.hash(), index: ownerPlain(tx) });
const spends = (tx: ccc.Transaction, p: ccc.OutPoint) => tx.inputs.some((i) => i.previousOutput.eq(p));
/** The combined sweep: every session at once, refused. */
const combinedRefused = (n: number) => (tx: ccc.Transaction) => (tx.inputs.length >= n + 1 ? "refuse" : "ok");

// Follow-up to 2.4.0 (28 Nov): each one-session sweep spends the owner's plain
// cell and makes its change a new one, not indexed yet. Searched for again, the
// spent cell came back and every later sweep failed: one session per call.
describe("recoverSessions, one session at a time, chained", () => {
  it.each([
    ["replies arrive", false],
    ["every reply is lost", true],
  ])("recovers several sessions in one call, each sweep spending the last one's change (%s)", async (_, lostReply) => {
    const planted = cell(3, "a7", 121n * CKB);
    const cells = [cell(1, "b1", 400n * CKB), planted, cell(2, "b2", 200n * CKB), cell(4, "b4", 300n * CKB)];
    // Someone's spend of the planted cell committed: the combined sweep is refused, as is its session's own.
    const { owner, sent, signatures } = chainOwner(cells, { committed: [planted.outPoint], lostReply });
    const r = await recoverSessions(owner, d);
    expect(sent).toHaveLength(3);
    expect(r).toEqual({ txHashes: sent.map((t) => t.hash()), recovered: 900n * CKB, cells: 3, failed: 1 });
    expect(spends(sent[0], op(9))).toBe(true);
    expect(spends(sent[1], changeOf(sent[0]))).toBe(true);
    expect(spends(sent[2], changeOf(sent[1]))).toBe(true);
    // The real completeFeeBy paid a fee from each sweep and made its change.
    for (const t of sent) expect(ownerPlain(t)).toBe(t.outputs.length - 1);
    expect(signatures()).toBe(5); // combined, b1, planted, b2, b4: no search retry
  });

  it("a token session's sweep chains too: its change follows the token output", async () => {
    const type = ccc.Script.from({ ...XUDT, args: h("71") });
    const token = ccc.Cell.from({
      outPoint: op(5),
      cellOutput: {
        lock: sessionLockScript(d, {
          ownerLockHash: ownerLock.hash(),
          sessionLockHash: h("b5"),
          maxPerTx: 5n * CKB,
          token: { typeHash: type.hash(), maxPerTx: 10n },
        }),
        type,
        capacity: 300n * CKB,
      },
      outputData: tokenData(1000n),
    });
    const { owner, sent } = chainOwner([token, cell(1, "b1", 400n * CKB), cell(2, "b2", 200n * CKB)], {
      verdict: combinedRefused(3),
    });
    const r = await recoverSessions(owner, d);
    expect(r).toEqual({ txHashes: sent.map((t) => t.hash()), recovered: 900n * CKB, cells: 3, failed: 0 });
    const swept = sent.find((t) => spends(t, token.outPoint))!;
    expect(swept.outputs[0].type?.eq(type)).toBe(true); // the tokens, back to the owner
    expect(ownerPlain(swept)).toBe(1); // the change, after them
    const next = sent[sent.indexOf(swept) + 1];
    expect(spends(next, changeOf(swept))).toBe(true);
    expect(spends(next, ccc.OutPoint.from({ txHash: swept.hash(), index: 0 }))).toBe(false);
  });

  it("returns the sweeps already sent when the chained change's other spend committed and no plain cell is left", async () => {
    const cells = [cell(1, "b1", 400n * CKB), cell(2, "b2", 200n * CKB), cell(4, "b4", 300n * CKB)];
    const chain = chainOwner(cells, {
      verdict: combinedRefused(3),
      // b1's change is spent elsewhere, and this node has committed that spend (`Dead`).
      afterSend: (tx) => chain.spentElsewhere(changeOf(tx), "committed"),
    });
    const r = await recoverSessions(chain.owner, d);
    expect(chain.sent).toHaveLength(1);
    expect(r).toMatchObject({ txHashes: [chain.sent[0].hash()], recovered: 400n * CKB, cells: 1, failed: 2 });
    expect(r.error).toBeInstanceOf(SessionBalanceError);
    expect(r.error).toMatchObject({ reason: "no-owner-cell" }); // op(9) is still listed, but b1's sweep spent it
    expect(r.unknown).toBeUndefined();
  });

  // Review M1, 28 Nov: on a node with RBF on, another tab's pending spend of the
  // change is a pool conflict, not `Dead`.
  it("searches once on a pool conflict over the chained change, then chains off the cell it finds", async () => {
    const cells = [cell(1, "b1", 400n * CKB), cell(2, "b2", 200n * CKB), cell(4, "b4", 300n * CKB)];
    const other = ccc.Cell.from({ outPoint: op(8), cellOutput: { lock: ownerLock, capacity: 90n * CKB }, outputData: "0x" });
    let first = true;
    const chain = chainOwner(cells, {
      live: [other],
      verdict: combinedRefused(3),
      afterSend: (tx) => {
        if (!first) return;
        first = false;
        chain.spentElsewhere(changeOf(tx), "pool"); // another tab, still pending
        chain.indexed.push(other); // and the indexer now lists another plain cell
      },
    });
    const r = await recoverSessions(chain.owner, d);
    expect(chain.sent).toHaveLength(3);
    expect(r).toEqual({ txHashes: chain.sent.map((t) => t.hash()), recovered: 900n * CKB, cells: 3, failed: 0 });
    expect(spends(chain.sent[1], other.outPoint)).toBe(true);
    expect(spends(chain.sent[2], changeOf(chain.sent[1]))).toBe(true);
  });

  // Review M3, 28 Nov: the search must not take the cell an earlier sweep spent.
  it("on a pool conflict with no other plain cell, never re-spends an earlier sweep's input and keeps the chain", async () => {
    const cells = [cell(1, "b1", 400n * CKB), cell(2, "b2", 200n * CKB), cell(4, "b4", 300n * CKB)];
    const chain = chainOwner(cells, {
      verdict: combinedRefused(3),
      afterSend: (tx) => chain.spentElsewhere(changeOf(tx), "pool"),
    });
    const r = await recoverSessions(chain.owner, d);
    expect(chain.sent).toHaveLength(1);
    expect(r).toEqual({ txHashes: [chain.sent[0].hash()], recovered: 400n * CKB, cells: 1, failed: 2 });
    expect(chain.signatures()).toBe(4); // combined, b1, b2, b4: the searches found nothing to sign
  });

  it("a pool conflict on a planted session cell costs no extra signature without another plain cell", async () => {
    const planted = cell(3, "a7", 121n * CKB);
    const cells = [cell(1, "b1", 400n * CKB), planted, cell(2, "b2", 200n * CKB)];
    // The planter's spend of the planted cell is still pending: an RBF refusal, which names no cell.
    const { owner, sent, signatures } = chainOwner(cells, { pooled: [planted.outPoint] });
    const r = await recoverSessions(owner, d);
    expect(r).toEqual({ txHashes: sent.map((t) => t.hash()), recovered: 600n * CKB, cells: 2, failed: 1 });
    expect(spends(sent[1], changeOf(sent[0]))).toBe(true); // the chain survived the planted session
    expect(signatures()).toBe(4); // combined, b1, planted, b2
  });

  it("keeps the chain when a fallback node does not know the chained change yet (Unknown)", async () => {
    const b2 = cell(2, "b2", 200n * CKB);
    let firstChange: ccc.OutPoint | undefined;
    const chain = chainOwner([cell(1, "b1", 400n * CKB), b2, cell(4, "b4", 300n * CKB)], {
      verdict: (tx) => {
        if (tx.inputs.length >= 4) return "refuse";
        // b2's sweep reaches a node that has not seen b1's sweep.
        if (spends(tx, b2.outPoint) && firstChange) return { unknownCell: firstChange };
        return "ok";
      },
      afterSend: (tx) => (firstChange ??= changeOf(tx)),
    });
    const r = await recoverSessions(chain.owner, d);
    expect(r).toEqual({ txHashes: chain.sent.map((t) => t.hash()), recovered: 700n * CKB, cells: 2, failed: 1 });
    expect(chain.sent.filter((t) => spends(t, op(9)))).toHaveLength(1); // no second spend of b1's input
    expect(spends(chain.sent[1], firstChange!)).toBe(true);
    expect(chain.signatures()).toBe(4); // combined, b1, b2, b4: no search
  });

  it("chains past a one-session sweep whose outcome is unknown, off the last sweep sent", async () => {
    const b2 = cell(2, "b2", 200n * CKB);
    let b2Hash: ccc.Hex | undefined;
    const { owner, sent } = chainOwner([cell(1, "b1", 400n * CKB), b2, cell(4, "b4", 300n * CKB)], {
      verdict: (tx) => {
        if (tx.inputs.length >= 4) return "refuse"; // the combined sweep: refused, known
        if (!spends(tx, b2.outPoint)) return "ok";
        b2Hash = tx.hash();
        return "unknown"; // the node did not take it, and cannot be asked
      },
    });
    const r = await recoverSessions(owner, d);
    expect(sent).toHaveLength(2);
    expect(r).toMatchObject({ txHashes: sent.map((t) => t.hash()), recovered: 700n * CKB, cells: 2, failed: 1 });
    expect(r.error).toBeUndefined();
    expect(r.unknown?.map((e) => e.txHash)).toEqual([b2Hash]);
    expect(spends(sent[1], changeOf(sent[0]))).toBe(true);
  });
});

describe("assertSigningLock", () => {
  // Found in review: an owner lock that needs no signature hands owner mode to anyone.
  const client = new ccc.ClientPublicTestnet();
  const known = async (k: ccc.KnownScript, args: string) =>
    ccc.Script.from({ ...(await client.getKnownScript(k)), args });

  it("accepts a plain secp256k1 owner and a signing Omnilock", async () => {
    await expect(assertSigningLock(await known(ccc.KnownScript.Secp256k1Blake160, "0x" + "11".repeat(20)), client)).resolves.toBeUndefined();
    await expect(assertSigningLock(await known(ccc.KnownScript.OmniLock, "0x00" + "11".repeat(20) + "00"), client)).resolves.toBeUndefined();
  });

  it("accepts JoyID and an Ethereum-signing Omnilock (the demo's wallets)", async () => {
    await expect(assertSigningLock(await known(ccc.KnownScript.JoyId, "0x0001" + "11".repeat(20)), client)).resolves.toBeUndefined();
    await expect(assertSigningLock(await known(ccc.KnownScript.OmniLock, "0x01" + "11".repeat(20) + "00"), client)).resolves.toBeUndefined();
  });

  // Wallet matrix, 26 Oct: CCC gives MetaMask and OKX (EVM) users auth flag 0x12.
  it("accepts the Omnilock CCC derives for an EVM wallet (auth 0x12)", async () => {
    const evm = new (class extends ccc.SignerEvm {
      async connect() {}
      async isConnected() {
        return true;
      }
      async getEvmAccount() {
        return ("0x" + "ab".repeat(20)) as ccc.Hex;
      }
    })(client);
    const lock = (await evm.getRecommendedAddressObj()).script;
    expect(ccc.bytesFrom(lock.args)[0]).toBe(0x12);
    await expect(assertSigningLock(lock, client)).resolves.toBeUndefined();
  });

  // Code review, 14 Oct: an allowlist, not a blocklist.
  it("refuses an Omnilock with an administrator or a delegated auth, and any unknown lock", async () => {
    await expect(assertSigningLock(await known(ccc.KnownScript.OmniLock, "0x00" + "11".repeat(20) + "01" + "22".repeat(32)), client)).rejects.toThrow(/administrator/);
    for (const auth of ["fc", "fd", "fe"]) {
      await expect(assertSigningLock(await known(ccc.KnownScript.OmniLock, "0x" + auth + "11".repeat(20) + "00"), client)).rejects.toThrow(/does not verify/);
    }
    await expect(assertSigningLock(await known(ccc.KnownScript.AlwaysSuccess, "0x"), client)).rejects.toThrow(/always-success/);
    const unknown = ccc.Script.from({ codeHash: h("ab"), hashType: "data1", args: "0x" });
    await expect(assertSigningLock(unknown, client)).rejects.toThrow(/not one this kit has reviewed/);
  });

  it("refuses anyone-can-pay, and Omnilock in anyone-can-pay mode", async () => {
    await expect(assertSigningLock(await known(ccc.KnownScript.AnyoneCanPay, "0x" + "11".repeat(20)), client)).rejects.toThrow(/anyone-can-pay/);
    await expect(assertSigningLock(await known(ccc.KnownScript.OmniLock, "0x00" + "11".repeat(20) + "02" + "0000"), client)).rejects.toThrow(/anyone-can-pay/);
  });
});

describe("openSession", () => {
  it("refuses a fee budget the key cell could not pay a single fee from", async () => {
    const owner = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), "0x" + "42".repeat(32));
    const s = createSession({ expiresAt: new Date(Date.now() + 60_000), scope: { maxPerTx: 5n * CKB } });
    await expect(openSession(owner, s, d, { budget: 200n * CKB, feeBudget: 61n * CKB })).rejects.toBeInstanceOf(
      SessionBalanceError,
    );
  });

  // Code review, 14 Oct: a recipient equal to the key's own lock would let the key pay itself, then anyone.
  it("refuses a recipient that is the session key itself", async () => {
    const client = new ccc.ClientPublicTestnet();
    const owner = new ccc.SignerCkbPrivateKey(client, "0x" + "42".repeat(32));
    const s = createSession({ expiresAt: new Date(Date.now() + 60_000), scope: { maxPerTx: 5n * CKB } });
    s.policy.scope.recipients = [await sessionAddress(s, client)];
    await expect(openSession(owner, s, d, { budget: 200n * CKB })).rejects.toThrow(/session key itself/);
  });
});
