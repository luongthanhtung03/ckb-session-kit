/**
 * Library audit, 30 Oct. Each test here FAILS on the current src/ and shows one
 * finding; it should pass once the finding is fixed. Mocked chain only.
 */
import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionLockScript, TESTNET_DEPLOYMENT as d } from "../src/lock.js";
import { keyLockOf, recoverSessions, sessionLockOf, spendInSession, type OnChainBinding } from "../src/onchain.js";
import { createSession } from "../src/session.js";

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;

afterEach(() => vi.restoreAllMocks());

describe("recoverSessions: a planted foreign-typed cell sharing the victim's session key hash", () => {
  const ownerLock = ccc.Script.from({ codeHash: h("aa"), hashType: "type", args: "0x" + "11".repeat(20) });
  const op = (i: number) => ccc.OutPoint.from({ txHash: h("0" + (i % 10)), index: i });
  const plainCell = (i: number, key: string, capacity: bigint) =>
    ccc.Cell.from({
      outPoint: op(i),
      cellOutput: {
        lock: sessionLockScript(d, { ownerLockHash: ownerLock.hash(), sessionLockHash: h(key), maxPerTx: 5n * CKB }),
        capacity,
      },
      outputData: "0x",
    });

  // Anyone can create this cell: the session lock never runs on outputs. Its args are
  // the 128-byte token layout with the victim's owner hash and the victim's (public)
  // session key hash, and a token hash equal to a type script the attacker picked
  // (sUDT, or anything else that is not in the sweep's cell deps). `sweepable` accepts
  // it, and recoverSessions groups it with the victim's real session by bytes 32..64.
  const foreign = ccc.Script.from({ codeHash: h("cc"), hashType: "data1", args: h("dd") });
  const planted = ccc.Cell.from({
    outPoint: op(7),
    cellOutput: {
      lock: sessionLockScript(d, {
        ownerLockHash: ownerLock.hash(),
        sessionLockHash: h("b1"),
        maxPerTx: 0n,
        token: { typeHash: foreign.hash(), maxPerTx: 1n },
      }),
      type: foreign,
      capacity: 250n * CKB,
    },
    outputData: ccc.hexFrom(ccc.numLeToBytes(1n, 16)),
  });

  it("still recovers the victim's own session cells", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    vi.spyOn(ccc.Transaction.prototype, "addCellDepsOfKnownScripts").mockResolvedValue(undefined as never);
    const real = [plainCell(1, "b1", 400n * CKB), plainCell(2, "b2", 200n * CKB)];
    const cells = [real[0], planted, real[1]];
    const sent: ccc.Transaction[] = [];
    // The node refuses any transaction spending the planted cell: its type script's
    // code is not among the cell deps (or the script refuses to be consumed).
    const sendTransaction = async (tx: ccc.Transaction) => {
      if (tx.inputs.some((i) => i.previousOutput.eq(planted.outPoint))) throw new Error("ScriptNotFound");
      sent.push(tx);
      return tx.hash();
    };
    const owner = {
      client: {
        async *findCells(key: { script: ccc.ScriptLike }) {
          const prefix = ccc.Script.from(key.script).args;
          for (const c of cells) if (c.cellOutput.lock.args.startsWith(prefix)) yield c;
        },
        sendTransaction,
        getTransaction: async () => undefined,
      },
      getRecommendedAddressObj: async () => ({ script: ownerLock }),
      async *findCells() {
        yield ccc.Cell.from({ outPoint: op(9), cellOutput: { lock: ownerLock, capacity: 100n * CKB }, outputData: "0x" });
      },
      signTransaction: async (tx: ccc.Transaction) => tx,
      sendTransaction,
    } as unknown as ccc.Signer;

    const result = await recoverSessions(owner, d);
    const swept = sent.flatMap((tx) => tx.inputs.map((i) => i.previousOutput));
    // Today: recovered 200 CKB, failed 1; the victim's 400 CKB session is never swept,
    // on every retry, for as long as the planted cell stays (and only the victim's
    // owner could ever spend it).
    expect(swept.some((o) => o.eq(real[0].outPoint))).toBe(true);
    expect(result.recovered).toBe(600n * CKB);
  });
});

describe("spendInSession: the key cell that pays the fee", () => {
  const ownerLock = ccc.Script.from({ codeHash: h("aa"), hashType: "type", args: "0x" + "11".repeat(20) });
  const client = new ccc.ClientPublicTestnet();
  let n = 0;
  const cellOf = (lock: ccc.Script, capacity: bigint) =>
    ccc.Cell.from({
      outPoint: { txHash: h("1" + (n++ % 10)), index: n },
      cellOutput: { lock, capacity },
      outputData: "0x",
    });

  // The indexer lists cells oldest first (CCC's cache aside). The key cell is
  // re-created by every spend, so any other plain cell under the key's address is
  // older and comes first: a 61 CKB cell anyone sent there, or the original key cell
  // once it ran low and the user "topped it up" as the error message says (a send to
  // the key address is a new cell). spendInSession only ever tries keyCells[0].
  it.each([
    ["a 61 CKB cell a stranger sent to the key address", 61n * CKB],
    ["the old key cell, run down to its floor before a top-up", 61n * CKB + 500n],
  ])("pays from a key cell that can cover the fee when the first one found is %s", async (_, firstCapacity) => {
    const acp = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
    const recipientLock = ccc.Script.from({ codeHash: acp.codeHash, hashType: acp.hashType, args: "0x" + "44".repeat(20) });
    const recipient = ccc.Address.fromScript(recipientLock, client).toString();
    const session = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: 5n * CKB } });
    const binding: OnChainBinding = {
      ownerLock: { codeHash: ownerLock.codeHash, hashType: ownerLock.hashType, args: ownerLock.args },
      minInterval: 0n,
    };
    const lock = await sessionLockOf(session, client, d, binding);
    const keyLock = await keyLockOf(session, client);
    const first = cellOf(keyLock, firstCapacity);
    const funded = cellOf(keyLock, 100n * CKB);
    const cells = [cellOf(lock, 300n * CKB), first, funded, cellOf(recipientLock, 61n * CKB)];
    vi.spyOn(client, "findCellsByLock").mockImplementation(async function* (l: ccc.ScriptLike) {
      for (const c of cells) if (c.cellOutput.lock.eq(l)) yield c;
    } as never);
    // A fee of 1000 shannons, taken from the key cell the transaction spends.
    vi.spyOn(ccc.Transaction.prototype, "completeFeeChangeToOutput").mockImplementation(async function (
      this: ccc.Transaction,
      _signer: unknown,
      index: ccc.NumLike,
    ) {
      const keyIn = cells.find((c) => c.outPoint.eq(this.inputs[this.inputs.length - 1].previousOutput))!;
      this.outputs[Number(index)].capacity = keyIn.cellOutput.capacity - 1000n;
      return true;
    } as never);
    vi.spyOn(ccc.SignerCkbPrivateKey.prototype, "signTransaction").mockImplementation(async (tx) => ccc.Transaction.from(tx));
    vi.spyOn(client, "sendTransaction").mockResolvedValue(h("ee"));

    // Today this throws "the key cell cannot cover another fee; top it up", although a
    // 100 CKB key cell is live, and keeps throwing after every further top-up.
    await expect(spendInSession(session, client, d, binding, { to: recipient, amount: 1n * CKB, topUp: true })).resolves.toBe(
      h("ee"),
    );
  });
});
