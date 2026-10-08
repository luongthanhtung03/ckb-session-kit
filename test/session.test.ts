import { describe, expect, it } from "vitest";
import { checkRequest, createSession, isActive, SessionPolicyError } from "../src/session.js";

const now = new Date("2026-10-08T00:00:00Z");
const later = new Date("2026-10-08T01:00:00Z");
const policy = { expiresAt: later, scope: { maxPerTx: 100_00000000n } };

describe("createSession", () => {
  it("creates a 32-byte key and a compressed public key", () => {
    const s = createSession(policy, { now });
    expect(s.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s.publicKey).toMatch(/^0x0[23][0-9a-f]{64}$/);
  });

  it("never reuses a key", () => {
    expect(createSession(policy, { now }).privateKey).not.toBe(
      createSession(policy, { now }).privateKey,
    );
  });

  it("rejects random bytes outside the curve order and draws again", () => {
    const draws = [new Uint8Array(32).fill(0xff), new Uint8Array(32).fill(0), new Uint8Array(32).fill(7)];
    const s = createSession(policy, { now, randomBytes: () => draws.shift()! });
    expect(s.privateKey).toBe("0x" + "07".repeat(32));
  });

  it.each([
    ["an expiry in the past", { ...policy, expiresAt: now }],
    ["a zero limit", { ...policy, scope: { maxPerTx: 0n } }],
    ["an empty recipient list", { ...policy, scope: { maxPerTx: 1n, recipients: [] } }],
  ])("refuses %s", (_, bad) => {
    expect(() => createSession(bad, { now })).toThrow(SessionPolicyError);
  });
});

describe("checkRequest", () => {
  const s = createSession({ ...policy, scope: { maxPerTx: 10n, recipients: ["ckt1alice"] } }, { now });

  it("allows an in-scope request", () => {
    expect(checkRequest(s, { to: "ckt1alice", amount: 10n }, now)).toEqual({ ok: true });
  });

  it.each([
    ["over the limit", { to: "ckt1alice", amount: 11n }, now],
    ["a zero amount", { to: "ckt1alice", amount: 0n }, now],
    ["an unknown recipient", { to: "ckt1mallory", amount: 1n }, now],
    ["an expired session", { to: "ckt1alice", amount: 1n }, later],
  ])("refuses %s", (_, req, at) => {
    expect(checkRequest(s, req, at).ok).toBe(false);
  });

  it("states the limit in CKB, not shannons", () => {
    const big = createSession({ ...policy, scope: { maxPerTx: 100_00000000n } }, { now });
    expect(checkRequest(big, { to: "ckt1x", amount: 150_00000000n }, now)).toEqual({
      ok: false,
      reason: "amount exceeds maxPerTx (100 CKB)",
    });
  });

  it("treats the expiry instant as expired", () => {
    expect(isActive(s, later)).toBe(false);
  });
});
