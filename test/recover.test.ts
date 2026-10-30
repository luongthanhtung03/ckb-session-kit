import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionLockScript, TESTNET_DEPLOYMENT as d } from "../src/lock.js";
import { assertSigningLock, openSession, recoverSessions, SessionBalanceError } from "../src/onchain.js";
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
      async *findCells(key: { script: ccc.ScriptLike }) {
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
    await expect(assertSigningLock(await known(ccc.KnownScript.AlwaysSuccess, "0x"), client)).rejects.toThrow(/not one known/);
    const unknown = ccc.Script.from({ codeHash: h("ab"), hashType: "data1", args: "0x" });
    await expect(assertSigningLock(unknown, client)).rejects.toThrow(/not one known/);
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
