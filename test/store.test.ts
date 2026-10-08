import { ccc } from "@ckb-ccc/core";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/session.js";
import { deserializeSession, memoryStore, serializeSession } from "../src/store.js";
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

  it("refuses an unknown storage version", () => {
    expect(() => deserializeSession('{"v":2}')).toThrow(/version/);
  });

  it("memory store saves, loads and clears", async () => {
    const store = memoryStore();
    expect(await store.load()).toBeUndefined();
    await store.save(session);
    expect(await store.load()).toEqual(session);
    await store.clear();
    expect(await store.load()).toBeUndefined();
  });
});

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
