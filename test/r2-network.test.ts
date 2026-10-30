/**
 * Audit round 2, 31 Oct: network and deployment confusion before mainnet.
 * Each test failed before the fixes of 31 Oct and shows one finding (4, 6, 7).
 * Mocked chain only: nothing is sent.
 */
import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCurrentDeployment } from "../src/deployment.js";
import { TESTNET_DEPLOYMENT, TESTNET_LEGACY_DEPLOYMENTS, type SessionLockDeployment } from "../src/lock.js";
import { openSession } from "../src/onchain.js";
import { createSession, SessionPolicyError } from "../src/session.js";
import { openSubscription } from "../src/subscription.js";
import { CODE_CELL, codeCellAt, FAKE_CODE, TEST_DEPLOYMENT } from "./fixtures/deployment.js";

const CKB = 100_000_000n;
const newSession = () => createSession({ expiresAt: new Date(Date.now() + 60_000), scope: { maxPerTx: 5n * CKB } });

afterEach(() => vi.restoreAllMocks());

/**
 * A secp256k1 owner on `client`. Signing changes nothing; every send is recorded.
 * `codeCell` is what the node holds at an out point (the deployment's code cell, say).
 */
async function owner(client: ccc.Client, codeCell: (op: ccc.OutPoint) => ccc.Cell | undefined = () => undefined) {
  const sec = await client.getKnownScript(ccc.KnownScript.Secp256k1Blake160);
  const script = ccc.Script.from({ codeHash: sec.codeHash, hashType: sec.hashType, args: "0x" + "11".repeat(20) });
  const signer = new ccc.SignerCkbPrivateKey(client, "0x" + "42".repeat(32));
  const sent: ccc.Transaction[] = [];
  vi.spyOn(signer, "getRecommendedAddressObj").mockResolvedValue({ script } as never);
  vi.spyOn(signer, "signTransaction").mockImplementation(async (tx) => ccc.Transaction.from(tx));
  vi.spyOn(client, "sendTransaction").mockImplementation(async (tx) => {
    const t = ccc.Transaction.from(tx);
    sent.push(t);
    return t.hash();
  });
  vi.spyOn(client, "getCell").mockImplementation(async (op) => codeCell(ccc.OutPoint.from(op)));
  vi.spyOn(client, "getCellLive").mockImplementation(async (op) => codeCell(ccc.OutPoint.from(op)));
  vi.spyOn(client, "getTransaction").mockResolvedValue(undefined);
  vi.spyOn(client, "findCellsByLock").mockImplementation(async function* () {} as never);
  vi.spyOn(ccc.Transaction.prototype, "completeInputsByCapacity").mockResolvedValue(0 as never);
  vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
  return { signer, sent };
}

describe("openSession under a legacy deployment (subscriptions refuse one; sessions do not)", () => {
  it.each(TESTNET_LEGACY_DEPLOYMENTS.map((d) => [d.codeHash.toString().slice(0, 10), d] as const))(
    "refuses to open a new session under the old lock %s, which lacks later rules (19-20; the 8 Oct one also 16-18)",
    async (_, legacy) => {
      const { signer, sent } = await owner(new ccc.ClientPublicTestnet());
      await expect(openSession(signer, newSession(), legacy, { budget: 200n * CKB })).rejects.toThrow();
      expect(sent).toHaveLength(0);
    },
  );

  it("never creates a token session under the 13 Oct lock, whose code refuses 128/160-byte args even in owner mode", async () => {
    const client = new ccc.ClientPublicTestnet();
    const { signer, sent } = await owner(client);
    vi.spyOn(ccc.Transaction.prototype, "completeInputsByUdt").mockResolvedValue(0 as never);
    vi.spyOn(ccc.Transaction.prototype, "getInputsUdtBalance").mockResolvedValue(100n as never);
    const xudt = await client.getKnownScript(ccc.KnownScript.XUdt);
    const type = { codeHash: xudt.codeHash, hashType: xudt.hashType, args: "0x" + "22".repeat(32) };
    const legacy13Oct = TESTNET_LEGACY_DEPLOYMENTS[0];
    await openSession(signer, newSession(), legacy13Oct, {
      budget: 300n * CKB,
      token: { type, amount: 100n, maxPerTx: 3n },
    }).catch(() => undefined);
    // Today: one cell with 128-byte args under 0x1cb7... is sent. That code (f7e2cfd)
    // returns BadArgs (10) for any args but 80/112 bytes before it checks owner
    // mode, so the cell, its CKB and its tokens can never be spent again.
    const stuck = sent.flatMap((t) => t.outputs).filter((o) => o.lock.codeHash === ccc.hexFrom(legacy13Oct.codeHash));
    expect(stuck).toHaveLength(0);
  });
});

describe("a deployment is never checked against the client's network before funds go under it", () => {
  it("openSession on a mainnet client refuses TESTNET_DEPLOYMENT, whose code cell is not on mainnet", async () => {
    const { signer, sent } = await owner(new ccc.ClientPublicMainnet()); // no cell at the testnet out point
    await expect(openSession(signer, newSession(), TESTNET_DEPLOYMENT, { budget: 200n * CKB })).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("openSubscription on a mainnet client refuses TESTNET_DEPLOYMENT", async () => {
    const client = new ccc.ClientPublicMainnet();
    const { signer, sent } = await owner(client);
    const sec = await client.getKnownScript(ccc.KnownScript.Secp256k1Blake160);
    const addr = (b: string) =>
      ccc.Address.fromScript(ccc.Script.from({ codeHash: sec.codeHash, hashType: sec.hashType, args: "0x" + b.repeat(20) }), client).toString();
    await expect(
      openSubscription(signer, TESTNET_DEPLOYMENT, {
        charger: addr("33"),
        payTo: addr("44"),
        price: 100n * CKB,
        periodBlocks: 100n,
        budget: 500n * CKB,
      }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("openSession refuses a deployment whose code cell does not hash to its codeHash (a typo, a wrong out point)", async () => {
    const client = new ccc.ClientPublicTestnet();
    const wrong: SessionLockDeployment = { ...TESTNET_DEPLOYMENT, codeHash: "0x" + "ab".repeat(32) };
    // The code cell is there, but holds the real binary: its data hash is not `wrong.codeHash`,
    // so no code exists for the lock the session cell would go under.
    const { signer, sent } = await owner(client, (op) =>
      op.eq(ccc.OutPoint.from(TESTNET_DEPLOYMENT.cellDep.outPoint))
        ? ccc.Cell.from({ outPoint: op, cellOutput: { lock: ccc.Script.from({ codeHash: "0x" + "00".repeat(32), hashType: "data", args: "0x" }), capacity: 8000n * CKB }, outputData: "0x7f454c46" })
        : undefined,
    );
    await expect(openSession(signer, newSession(), wrong, { budget: 200n * CKB })).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe("assertCurrentDeployment (the fix for findings 4, 6, 7)", () => {
  const client = () => new ccc.ClientPublicTestnet();
  const zeroLock = { codeHash: "0x" + "00".repeat(32), hashType: "data" as const, args: "0x" };
  const at = (cells: ccc.Cell[]) => async (op: ccc.OutPointLike) => cells.find((c) => c.outPoint.eq(ccc.OutPoint.from(op)));

  it("refuses every legacy deployment and hash_type data with a SessionPolicyError, before any lookup", async () => {
    const c = client();
    const live = vi.spyOn(c, "getCellLive").mockImplementation(async (op) => codeCellAt(op));
    for (const legacy of TESTNET_LEGACY_DEPLOYMENTS) {
      await expect(assertCurrentDeployment(c, legacy)).rejects.toThrow(/old deployment/);
    }
    await expect(assertCurrentDeployment(c, { ...TEST_DEPLOYMENT, hashType: "data" })).rejects.toBeInstanceOf(SessionPolicyError);
    expect(live).not.toHaveBeenCalled();
  });

  it("accepts a code cell that hashes to codeHash, and looks it up once per client and deployment", async () => {
    const c = client();
    const live = vi.spyOn(c, "getCellLive").mockImplementation(async (op) => codeCellAt(op));
    await assertCurrentDeployment(c, TEST_DEPLOYMENT);
    await assertCurrentDeployment(c, { ...TEST_DEPLOYMENT, hashType: "data1" });
    await assertCurrentDeployment(c, TEST_DEPLOYMENT);
    expect(live).toHaveBeenCalledTimes(2); // data2 once, data1 once

    const { signer, sent } = await owner(c, codeCellAt);
    const calls = () => vi.mocked(c.getCellLive).mock.calls.length;
    const before = calls();
    await openSession(signer, newSession(), TEST_DEPLOYMENT, { budget: 200n * CKB });
    await openSession(signer, newSession(), TEST_DEPLOYMENT, { budget: 200n * CKB });
    expect(sent).toHaveLength(2);
    expect(calls()).toBe(before); // the cache answered both
  });

  it("does not remember a failed check: the next call looks again", async () => {
    const c = client();
    let served = false;
    const live = vi.spyOn(c, "getCellLive").mockImplementation(async (op) => (served ? codeCellAt(op) : undefined));
    await expect(assertCurrentDeployment(c, TEST_DEPLOYMENT)).rejects.toThrow(/not a live cell/);
    served = true;
    await expect(assertCurrentDeployment(c, TEST_DEPLOYMENT)).resolves.toBeUndefined();
    expect(live).toHaveBeenCalledTimes(2);
  });

  it("resolves a dep group and matches any member; refuses a group without the code", async () => {
    const group = (members: ccc.OutPoint[], i: number) =>
      ccc.Cell.from({
        outPoint: { txHash: "0x" + "d0".repeat(32), index: i },
        cellOutput: { lock: zeroLock, capacity: 100n * CKB },
        outputData: ccc.hexFrom(
          ccc.bytesConcat(ccc.numLeToBytes(members.length, 4), ...members.map((m) => ccc.bytesConcat(m.txHash, ccc.numLeToBytes(m.index, 4)))),
        ),
      });
    const other = ccc.Cell.from({ outPoint: { txHash: "0x" + "d1".repeat(32), index: 0 }, cellOutput: { lock: zeroLock, capacity: 100n * CKB }, outputData: "0x00" });
    const good = group([other.outPoint, CODE_CELL.outPoint], 0);
    const bad = group([other.outPoint], 1);
    const c = client();
    vi.spyOn(c, "getCellLive").mockImplementation(at([good, bad, other, CODE_CELL]));
    const viaGroup = (g: ccc.Cell): SessionLockDeployment => ({ ...TEST_DEPLOYMENT, cellDep: { outPoint: g.outPoint, depType: "depGroup" } });
    await expect(assertCurrentDeployment(c, viaGroup(good))).resolves.toBeUndefined();
    await expect(assertCurrentDeployment(c, viaGroup(bad))).rejects.toThrow(/does not hold code/);
    // A code cell given as a dep group is not a list of out points.
    await expect(assertCurrentDeployment(c, viaGroup(CODE_CELL))).rejects.toThrow(/list of out points/);
  });

  it("with hash_type type, matches the code cell's type script hash, not its data hash", async () => {
    const typeId = ccc.Script.from({ codeHash: "0x" + "00".repeat(31) + "01", hashType: "type", args: "0x" + "ee".repeat(32) });
    const code = ccc.Cell.from({ outPoint: CODE_CELL.outPoint, cellOutput: { lock: zeroLock, type: typeId, capacity: 100n * CKB }, outputData: FAKE_CODE });
    const c = client();
    vi.spyOn(c, "getCellLive").mockImplementation(at([code]));
    await expect(assertCurrentDeployment(c, { ...TEST_DEPLOYMENT, hashType: "type", codeHash: typeId.hash() })).resolves.toBeUndefined();
    await expect(assertCurrentDeployment(c, { ...TEST_DEPLOYMENT, hashType: "type" })).rejects.toThrow(/type hash/);
  });
});
