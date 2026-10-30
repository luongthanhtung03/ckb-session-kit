import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codeCellAt, TEST_DEPLOYMENT as d } from "./fixtures/deployment.js";
import { closeSession, openSession, SessionBalanceError } from "../src/onchain.js";
import { createSession } from "../src/session.js";
import { deserializeSession, indexedDbStore, memoryStore, serializeSession } from "../src/store.js";

/** Hardening review, 14 Oct: keys forgotten too early, key cells too small to return, sends that fail late. */

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;
const newSession = () => createSession({ expiresAt: new Date(Date.now() + 60_000), scope: { maxPerTx: 5n * CKB } });

afterEach(() => vi.restoreAllMocks());

/** An owner on testnet whose lock is `lock`; signing changes nothing, sending is `send`. */
async function owner(lock: (c: ccc.Client) => Promise<ccc.Script>, send: (tx: ccc.Transaction) => Promise<ccc.Hex>) {
  const client = new ccc.ClientPublicTestnet();
  const script = await lock(client);
  const signer = new ccc.SignerCkbPrivateKey(client, "0x" + "42".repeat(32));
  vi.spyOn(signer, "getRecommendedAddressObj").mockResolvedValue({ script } as never);
  vi.spyOn(signer, "signTransaction").mockImplementation(async (tx) => ccc.Transaction.from(tx));
  vi.spyOn(client, "sendTransaction").mockImplementation(async (tx) => send(ccc.Transaction.from(tx)));
  vi.spyOn(client, "getCellLive").mockImplementation(async (op) => codeCellAt(op));
  vi.spyOn(ccc.Transaction.prototype, "completeInputsByCapacity").mockResolvedValue(0 as never);
  vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
  return { client, signer };
}

const joyId = async (c: ccc.Client) => {
  const s = await c.getKnownScript(ccc.KnownScript.JoyId);
  return ccc.Script.from({ codeHash: s.codeHash, hashType: s.hashType, args: "0x0001" + "11".repeat(20) });
};
const secp = async (c: ccc.Client) => {
  const s = await c.getKnownScript(ccc.KnownScript.Secp256k1Blake160);
  return ccc.Script.from({ codeHash: s.codeHash, hashType: s.hashType, args: "0x" + "11".repeat(20) });
};

describe("openSession: the key cell can always go back to the owner (H2)", () => {
  it("sizes the default key cell for a JoyID owner, whose cell needs 63 CKB", async () => {
    let sent: ccc.Transaction | undefined;
    const { signer } = await owner(joyId, async (tx) => ((sent = tx), tx.hash()));
    await openSession(signer, newSession(), d, { budget: 200n * CKB });
    expect(sent!.outputs[1].capacity).toBe(64n * CKB);
  });

  it("keeps 62 CKB for a plain secp256k1 owner", async () => {
    let sent: ccc.Transaction | undefined;
    const { signer } = await owner(secp, async (tx) => ((sent = tx), tx.hash()));
    await openSession(signer, newSession(), d, { budget: 200n * CKB });
    expect(sent!.outputs[1].capacity).toBe(62n * CKB);
  });

  it("refuses a fee budget that could not return to a JoyID owner", async () => {
    const { signer } = await owner(joyId, async (tx) => tx.hash());
    await expect(openSession(signer, newSession(), d, { budget: 200n * CKB, feeBudget: 63n * CKB })).rejects.toBeInstanceOf(
      SessionBalanceError,
    );
  });
});

describe("openSession: the key is saved against the final hash before anything is sent (H1, M1)", () => {
  it("gives beforeSend the binding with openTx, the hash that is then sent", async () => {
    const order: string[] = [];
    let saved: ccc.Hex | undefined;
    const { signer } = await owner(secp, async (tx) => (order.push("send"), tx.hash()));
    const { txHash, binding } = await openSession(signer, newSession(), d, {
      budget: 200n * CKB,
      beforeSend: async (b) => {
        order.push("save");
        saved = b.openTx;
      },
    });
    expect(order).toEqual(["save", "send"]);
    expect(saved).toBe(txHash);
    expect(binding.openTx).toBe(txHash);
  });

  it("returns the hash when the send throws but the node did take the transaction", async () => {
    const { signer, client } = await owner(secp, async () => {
      throw new Error("socket hang up");
    });
    vi.spyOn(client, "getTransaction").mockResolvedValue({ status: "pending" } as never);
    const { txHash, binding } = await openSession(signer, newSession(), d, { budget: 200n * CKB });
    expect(binding.openTx).toBe(txHash);
  });

  it("rethrows when the node never saw it, so the caller may forget the key", async () => {
    const { signer, client } = await owner(secp, async () => {
      throw new Error("TransactionFailedToVerify");
    });
    vi.spyOn(client, "getTransaction").mockResolvedValue(undefined);
    await expect(openSession(signer, newSession(), d, { budget: 200n * CKB })).rejects.toThrow(/FailedToVerify/);
  });
});

describe("closeSession with nothing on-chain (H1)", () => {
  async function closing(openStatus: string | undefined) {
    const { signer, client } = await owner(secp, async (tx) => tx.hash());
    vi.spyOn(client, "findCellsByLock").mockImplementation(async function* () {} as never);
    vi.spyOn(client, "getTransaction").mockResolvedValue(openStatus ? ({ status: openStatus } as never) : undefined);
    const s = newSession();
    const binding = { ownerLock: await secp(client), minInterval: 0n, openTx: h("ab") };
    return closeSession(signer, s, d, binding);
  }

  it.each(["pending", "proposed", "committed"])("refuses to report nothing while the funding is %s", async (status) => {
    await expect(closing(status)).rejects.toBeInstanceOf(SessionBalanceError);
  });

  it.each([["rejected"], ["unknown"], [undefined]])("reports nothingFound when the funding is %s", async (status) => {
    expect(await closing(status)).toEqual({ nothingFound: true });
  });
});

describe("session store", () => {
  it("keeps openTx across a save and a load", () => {
    const s = { ...newSession(), onchain: { ownerLock: { codeHash: h("aa"), hashType: "type" as const, args: "0x" as ccc.Hex }, minInterval: 0n, openTx: h("cd") } };
    expect(deserializeSession(serializeSession(s)).onchain?.openTx).toBe(h("cd"));
  });

  it("never overwrites an unreadable stored value, and says why", async () => {
    const backing = new Map<string, unknown>([["current", "{not json"]]);
    const req = <T>(fn: () => T) => {
      const r: { result?: T; onsuccess?: () => void } = {};
      queueMicrotask(() => ((r.result = fn()), r.onsuccess?.()));
      return r;
    };
    const store = {
      get: (k: string) => req(() => backing.get(k)),
      put: (v: unknown, k: string) => req(() => void backing.set(k, v)),
      delete: (k: string) => req(() => void backing.delete(k)),
    };
    const db = {
      transaction: () => {
        const tx: { objectStore: () => typeof store; oncomplete?: () => void; abort: () => void } = { objectStore: () => store, abort: () => {} };
        setTimeout(() => tx.oncomplete?.(), 0);
        return tx;
      },
      close: () => {},
    };
    const idb = indexedDbStore({ open: () => req(() => db) } as unknown as IDBFactory);
    await expect(idb.save(newSession())).rejects.toThrow(/unreadable/);
    await expect(idb.load()).rejects.toThrow(/unreadable/);
    expect(backing.get("current")).toBe("{not json");
    await expect(memoryStore().load()).resolves.toBeUndefined();
  });
});
