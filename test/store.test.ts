import { ccc } from "@ckb-ccc/core";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/session.js";
import { deserializeSession, indexedDbStore, memoryStore, serializeSession, SessionStoreConflict } from "../src/store.js";
import { ScopeError, sendInScope } from "../src/transfer.js";

const now = new Date("2026-10-08T00:00:00Z");
const session = createSession(
  {
    expiresAt: new Date("2026-10-09T00:00:00Z"),
    scope: { maxPerTx: 123_00000000n, recipients: ["ckt1alice"] },
  },
  { now },
);

describe("session storage", () => {
  it("round-trips bigints, dates and recipients", () => {
    expect(deserializeSession(serializeSession(session))).toEqual(session);
  });

  it("round-trips a session with no recipient list", () => {
    const open = createSession({ expiresAt: session.policy.expiresAt, scope: { maxPerTx: 1n } }, { now });
    const back = deserializeSession(serializeSession(open));
    expect(back).toEqual(open);
    expect("recipients" in back.policy.scope).toBe(false);
  });

  it("round-trips the on-chain binding", () => {
    const bound = {
      ...session,
      onchain: {
        ownerLock: { codeHash: ("0x" + "11".repeat(32)) as `0x${string}`, hashType: "type" as const, args: "0xabcd" as `0x${string}` },
        minInterval: 3n,
        recipientLockHash: ("0x" + "22".repeat(32)) as `0x${string}`,
      },
    };
    expect(deserializeSession(serializeSession(bound))).toEqual(bound);
  });

  it("refuses an unknown storage version", () => {
    expect(() => deserializeSession('{"v":2}')).toThrow(/version/);
  });

  it("memory store saves, loads and clears", async () => {
    const store = memoryStore();
    expect(await store.load()).toBeUndefined();
    await store.save(session);
    expect(await store.load()).toEqual(session);
    await store.clear(session);
    expect(await store.load()).toBeUndefined();
  });

  // Found in review: two tabs share one slot. A second session must not replace a
  // stored one (its key may hold funds), and a stale tab's close must not delete
  // a newer session's key.
  const other = createSession({ expiresAt: new Date("2026-10-09T00:00:00Z"), scope: { maxPerTx: 1n } }, { now });

  it.each([
    ["memory", () => [memoryStore()].flatMap((s) => [s, s])],
    ["IndexedDB, two tabs", () => { const idb = fakeIdb(); return [indexedDbStore(idb), indexedDbStore(idb)]; }],
  ])("%s: refuses to replace a different stored session", async (_, stores) => {
    const [tabA, tabB] = stores();
    await tabA.save(session);
    await expect(tabB.save(other)).rejects.toBeInstanceOf(SessionStoreConflict);
    await tabA.save(session); // the same session may be saved again
    expect((await tabB.load())?.privateKey).toBe(session.privateKey);
  });

  it.each([
    ["memory", () => [memoryStore()].flatMap((s) => [s, s])],
    ["IndexedDB, two tabs", () => { const idb = fakeIdb(); return [indexedDbStore(idb), indexedDbStore(idb)]; }],
  ])("%s: a stale clear does not delete a newer session", async (_, stores) => {
    const [tabA, tabB] = stores();
    await tabA.save(session);
    await tabA.clear(session);
    await tabA.save(other);
    await tabB.clear(session); // tab B still shows the old session
    expect((await tabA.load())?.privateKey).toBe(other.privateKey);
  });

  // Review, 28 Oct: a stale tab that never saw the funding must not drop the binding
  // that finds the funds under the key.
  it.each([
    ["memory", () => [memoryStore()].flatMap((s) => [s, s])],
    ["IndexedDB, two tabs", () => { const idb = fakeIdb(); return [indexedDbStore(idb), indexedDbStore(idb)]; }],
  ])("%s: a stale save of the same key does not drop its on-chain binding", async (_, stores) => {
    const [tabA, tabB] = stores();
    const bound = {
      ...session,
      onchain: {
        ownerLock: { codeHash: ("0x" + "11".repeat(32)) as `0x${string}`, hashType: "type" as const, args: "0xabcd" as `0x${string}` },
        minInterval: 0n,
        openTx: ("0x" + "33".repeat(32)) as `0x${string}`,
      },
    };
    await tabA.save(session);
    await tabA.save(bound); // funded in tab A
    await expect(tabB.save(session)).rejects.toBeInstanceOf(SessionStoreConflict); // tab B still holds the draft
    expect((await tabA.load())?.onchain).toEqual(bound.onchain);
  });

  it("refuses an invalid expiry date", () => {
    expect(() => createSession({ expiresAt: new Date(NaN), scope: { maxPerTx: 1n } }, { now })).toThrow(/valid date/);
  });
});

/** Just enough of IndexedDB for the store: one object store, async requests. */
function fakeIdb(): IDBFactory {
  const backing = new Map<string, unknown>();
  const req = <T>(fn: () => T) => {
    const r: { result?: T; onsuccess?: () => void } = {};
    queueMicrotask(() => {
      r.result = fn();
      r.onsuccess?.();
    });
    return r;
  };
  const store = {
    get: (k: string) => req(() => backing.get(k)),
    put: (v: unknown, k: string) => req(() => void backing.set(k, v)),
    delete: (k: string) => req(() => void backing.delete(k)),
  };
  // A transaction completes once the requests made on it have run.
  const db = {
    transaction: () => {
      const tx: { objectStore: () => typeof store; oncomplete?: () => void; abort: () => void } = {
        objectStore: () => store,
        abort: () => {},
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
    close: () => {},
  };
  return { open: () => req(() => db) } as unknown as IDBFactory;
}

describe("sendInScope", () => {
  // Refusals must happen before any network access, so a client that throws on
  // use proves nothing was built or signed.
  const offline = new Proxy({} as ccc.Client, {
    get: () => {
      throw new Error("network touched");
    },
  });

  it.each([
    ["over the limit", { to: "ckt1alice", amount: 124_00000000n }, now],
    ["an unknown recipient", { to: "ckt1mallory", amount: 1n }, now],
    ["an expired session", { to: "ckt1alice", amount: 1n }, new Date("2026-10-10T00:00:00Z")],
  ])("refuses %s without touching the network", async (_, req, at) => {
    await expect(sendInScope(session, offline, req, at)).rejects.toBeInstanceOf(ScopeError);
  });
});
