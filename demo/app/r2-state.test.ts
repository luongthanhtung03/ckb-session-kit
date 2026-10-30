/**
 * Audit round 2 (31 Oct): the demo's client code over time. Each test here
 * failed before the fix and shows one finding; they pass since the fixes of
 * 31 Oct. Mocked chain only.
 */
import { ccc } from "@ckb-ccc/core";
import { describe, expect, it, vi } from "vitest";
import { memoryStore } from "../../src/store.js";
import { createSession } from "../../src/session.js";

// shared.tsx takes ccc from the React connector; the core is the same object.
vi.mock("@ckb-ccc/connector-react", async () => ({ ccc: (await import("@ckb-ccc/core")).ccc }));
const { openKept } = await import("./shared");
const { emptyScan, scanBoard } = await import("./place/chain");

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;

describe("openKept: forgetting the key after a lost reply", () => {
  // Scenario: the funding send times out (or the transport fails over: the public
  // testnet client has two independent RPC hosts). The node that took it has not
  // relayed it yet, so the one asked next answers "unknown" for a moment.
  // signAndSend rethrows (right: it is not sure), then neverSent asks once more,
  // immediately, gets "unknown" again and openKept clears the stored key. The
  // funding then commits: the session cells can be swept by recoverSessions, but
  // the key cell (62-64 CKB) is under a key that no longer exists anywhere.
  // paymentState already waits DROP_AFTER_MS before calling "unknown" dropped;
  // neverSent (used by openKept and every page's pay-retry path) does not.
  it("keeps the key while an unknown funding transaction may still land", async () => {
    const client = new ccc.ClientPublicTestnet();
    vi.spyOn(client, "getTransaction").mockResolvedValue(undefined); // not seen yet by the node asked
    const store = memoryStore();
    const draft = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: 5n * CKB } });
    const binding = { ownerLock: { codeHash: h("aa"), hashType: "type" as const, args: "0x" as ccc.Hex }, minInterval: 0n, openTx: h("0f") };

    await openKept(client, store, draft, async (beforeSend) => {
      await beforeSend(binding);
      throw new Error("request timeout"); // the node did take it
    }).catch(() => undefined);

    expect((await store.load())?.publicKey).toBe(draft.publicKey);
  });
});

describe("scanBoard: a transient miss is never looked at again", () => {
  // Scenario: the indexer lists a placement, but get_transaction answers nothing
  // for it at that moment (the transport failed over to the other RPC host, which
  // is a block behind). readPlacement returns undefined, the hash is already in
  // `seen`, and `fromBlock` has moved past it: that placement is missing from the
  // board on this page until a reload. An RPC error is retried; a miss is not.
  it("picks up a placement on the next poll after get_transaction missed it once", async () => {
    const client = new ccc.ClientPublicTestnet();
    const board = { width: 4, height: 4, colours: 4, price: 1n * CKB, maxPixels: 4 };
    const boardLock = ccc.Script.from({ codeHash: h("cc"), hashType: "type", args: "0x01" });
    const rec = { txHash: h("71"), blockNumber: 50n, txIndex: 1n, cells: [{ isInput: true, cellIndex: 0n }] };
    vi.spyOn(client, "findTransactions").mockImplementation(async function* () {
      yield rec;
    } as never);
    const getTx = vi.spyOn(client, "getTransaction").mockResolvedValue(undefined);

    const first = await scanBoard(client, boardLock, board, emptyScan());
    expect(first.placements).toEqual([]);
    getTx.mockClear();
    await scanBoard(client, boardLock, board, first);
    // The second poll asks about it again (before the fix, it was skipped as seen).
    expect(getTx).toHaveBeenCalledWith(h("71"));
  });
});
