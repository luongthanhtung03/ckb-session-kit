import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionLockScript, TESTNET_DEPLOYMENT as d } from "../src/lock.js";
import { assertSigningLock, openSession, recoverSessions, SessionBalanceError } from "../src/onchain.js";
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

/** An owner whose chain holds `cells`; `send` decides which transactions the node accepts. */
function fakeOwner(cells: ccc.Cell[], send: (tx: ccc.Transaction) => boolean) {
  const sent: ccc.Transaction[] = [];
  const owner = {
    client: {
      async *findCells(key: { script: ccc.ScriptLike }) {
        const prefix = ccc.Script.from(key.script).args;
        for (const c of cells) if (c.cellOutput.lock.args.startsWith(prefix)) yield c;
      },
    },
    getRecommendedAddressObj: async () => ({ script: ownerLock }),
    async *findCells() {
      yield ccc.Cell.from({ outPoint: op(9), cellOutput: { lock: ownerLock, capacity: 100n * CKB }, outputData: "0x" });
    },
    sendTransaction: async (tx: ccc.Transaction) => {
      if (!send(tx)) throw new Error("dead input");
      sent.push(tx);
      return h("e" + sent.length);
    },
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

  it("refuses anyone-can-pay, and Omnilock in anyone-can-pay mode", async () => {
    await expect(assertSigningLock(await known(ccc.KnownScript.AnyoneCanPay, "0x" + "11".repeat(20)), client)).rejects.toThrow(/anyone-can-pay/);
    await expect(assertSigningLock(await known(ccc.KnownScript.OmniLock, "0x00" + "11".repeat(20) + "02" + "0000"), client)).rejects.toThrow(/anyone-can-pay/);
  });
});

describe("openSession", () => {
  it("refuses a fee budget the key cell could not pay a single fee from", async () => {
    const { owner } = fakeOwner([], () => true);
    const s = createSession({ expiresAt: new Date(Date.now() + 60_000), scope: { maxPerTx: 5n * CKB } });
    await expect(openSession(owner, s, d, { budget: 200n * CKB, feeBudget: 61n * CKB })).rejects.toBeInstanceOf(
      SessionBalanceError,
    );
  });
});
