import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTNET_DEPLOYMENT as d } from "../src/lock.js";
import { closeSession, sessionLockOf } from "../src/onchain.js";
import { createSession } from "../src/session.js";

/**
 * Round 2 of the 30 Oct audit (browser side). These tests describe the wanted
 * behaviour; they failed before the fix and pass since the fixes of 31 Oct.
 *
 * R2-1. closeSession takes the connected wallet as the owner without checking it
 * against binding.ownerLock (cancelSubscription does check: "this signer is not
 * the subscriber"). The demo pages guard with an `isOwner` check, but its
 * ownerLockHash comes from a getRecommendedAddressObj().then() with no stale
 * guard, so after a wallet switch A -> B it can still hold A's hash while B is
 * the signer. Then wallet B is asked to sign a sweep of A's session cells to B's
 * own lock. The session lock rejects it on-chain (owner mode needs A's lock in
 * the inputs), so nothing is lost, but the wrong wallet is shown a transaction
 * that moves someone else's session to itself, and the user gets a network
 * error instead of "connect the wallet that opened it".
 */

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;
const lockA = ccc.Script.from({ codeHash: h("aa"), hashType: "type", args: "0x" + "11".repeat(20) });
const lockB = ccc.Script.from({ codeHash: h("aa"), hashType: "type", args: "0x" + "22".repeat(20) });

afterEach(() => vi.restoreAllMocks());

describe("R2-1: closeSession with a wallet that is not the session's owner", () => {
  it("refuses before asking the wrong wallet to sign", async () => {
    const client = new ccc.ClientPublicTestnet();
    const session = createSession({ expiresAt: new Date(Date.now() + 60_000), scope: { maxPerTx: 5n * CKB } });
    const binding = { ownerLock: lockA, minInterval: 0n };
    const lock = await sessionLockOf(session, client, d, binding);
    const sessionCell = ccc.Cell.from({
      outPoint: { txHash: h("01"), index: 0 },
      cellOutput: { lock, capacity: 200n * CKB },
      outputData: "0x",
    });
    vi.spyOn(client, "findCellsByLock").mockImplementation(async function* (l: ccc.ScriptLike) {
      if (ccc.Script.from(l).eq(lock)) yield sessionCell;
    } as never);
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);

    // Wallet B: connected now, not the owner.
    const signed: ccc.Transaction[] = [];
    const walletB = {
      client,
      getRecommendedAddressObj: async () => ({ script: lockB }),
      async *findCells() {
        yield ccc.Cell.from({ outPoint: { txHash: h("09"), index: 0 }, cellOutput: { lock: lockB, capacity: 100n * CKB }, outputData: "0x" });
      },
      signTransaction: async (tx: ccc.Transaction) => (signed.push(tx), tx),
      sendTransaction: async (tx: ccc.Transaction) => (signed.push(tx), tx.hash()),
    } as unknown as ccc.Signer;
    vi.spyOn(client, "sendTransaction").mockImplementation(async (tx) => ccc.Transaction.from(tx).hash());

    const outcome = await closeSession(walletB, session, d, binding).then(
      () => "asked wallet B to sign",
      (e: Error) => e.message,
    );
    // Before the fix: wallet B was handed a sweep that spends A's 200 CKB session cell
    // (its change, filled in by completeFeeBy, goes to B's lock).
    const spent = signed.flatMap((t) => t.inputs.map((i) => i.previousOutput.txHash));
    expect(spent, "session cells wallet B was asked to sweep").not.toContain(h("01"));
    expect(outcome).toMatch(/not the (session'?s )?owner/i);
  });
});
