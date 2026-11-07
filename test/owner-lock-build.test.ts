import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTNET_DEPLOYMENT as d } from "../src/lock.js";
import { checkOwnerLockBuild, openSession, REVIEWED_OWNER_LOCK_BUILDS, SessionBalanceError, type SessionWarning } from "../src/onchain.js";
import { createSession } from "../src/session.js";
import { openSubscription } from "../src/subscription.js";

// Omnilock, JoyID and the Nostr lock are type-id deployments: an owner lock hash
// binds the type id, not the binary. Opening a session or a subscription reads the
// live code cell and warns (never refuses) when its build is not a reviewed one.

const CKB = 100_000_000n;
const testnet = new ccc.ClientPublicTestnet();
const mainnet = new ccc.ClientPublicMainnet();
const known = async (c: ccc.Client, k: ccc.KnownScript, args: string) => ccc.Script.from({ ...(await c.getKnownScript(k)), args });
const omniArgs = "0x00" + "11".repeat(20) + "00";

/** The code cell the type id `codeHash` resolves to, as CCC lists it, holding `data`. */
async function codeCell(c: ccc.Client, k: ccc.KnownScript, data: ccc.HexLike): Promise<ccc.Cell> {
  const info = await c.getKnownScript(k);
  const type = info.cellDeps.map((x) => x.type).find((t) => t?.hash() === info.codeHash)!;
  return ccc.Cell.from({
    outPoint: { txHash: "0x" + "cd".repeat(32), index: 0 },
    cellOutput: { capacity: 0n, lock: { codeHash: "0x" + "00".repeat(32), hashType: "data", args: "0x" }, type },
    outputData: data,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("REVIEWED_OWNER_LOCK_BUILDS", () => {
  it("keys each build by the type id CCC uses for that lock on that network", async () => {
    const byName = { Omnilock: ccc.KnownScript.OmniLock, JoyID: ccc.KnownScript.JoyId, "Nostr lock": ccc.KnownScript.NostrLock };
    for (const b of REVIEWED_OWNER_LOCK_BUILDS) {
      const info = await (b.network === "mainnet" ? mainnet : testnet).getKnownScript(byName[b.lock]);
      expect(info.hashType).toBe("type");
      expect(b.codeHash).toBe(info.codeHash);
      expect(b.dataHash).toMatch(/^0x[0-9a-f]{64}$/);
    }
    expect(REVIEWED_OWNER_LOCK_BUILDS.find((b) => b.lock === "Omnilock" && b.network === "mainnet")?.dataHash).toBe(
      "0x768f306681da232ceb0b94f436c5f813377179762a831c5ad8797bd4fd2d118d",
    );
    expect(Object.isFrozen(REVIEWED_OWNER_LOCK_BUILDS)).toBe(true);
  });
});

describe("checkOwnerLockBuild", () => {
  it("returns nothing for a reviewed build", async () => {
    const lock = await known(mainnet, ccc.KnownScript.OmniLock, omniArgs);
    const cell = await codeCell(mainnet, ccc.KnownScript.OmniLock, "0x1234");
    const find = vi.spyOn(mainnet, "findSingletonCellByType").mockResolvedValue(cell);
    const reviewed = [{ ...REVIEWED_OWNER_LOCK_BUILDS[0], codeHash: lock.codeHash, dataHash: ccc.hashCkb("0x1234") }];
    await expect(checkOwnerLockBuild(lock, mainnet, reviewed)).resolves.toBeUndefined();
    expect(find).toHaveBeenCalledWith(cell.cellOutput.type, true);
  });

  it("warns with the observed data hash for a build that is not listed, for each type-id lock", async () => {
    for (const [k, args] of [
      [ccc.KnownScript.OmniLock, omniArgs],
      [ccc.KnownScript.JoyId, "0x0001" + "11".repeat(20)],
      [ccc.KnownScript.NostrLock, "0x00" + "11".repeat(20)],
    ] as const) {
      const lock = await known(mainnet, k, args);
      vi.spyOn(mainnet, "findSingletonCellByType").mockResolvedValue(await codeCell(mainnet, k, "0xdeadbeef"));
      const w = await checkOwnerLockBuild(lock, mainnet);
      expect(w).toMatchObject({ code: "owner-lock-build-unreviewed", dataHash: ccc.hashCkb("0xdeadbeef") });
      expect(w!.message).toContain(ccc.hashCkb("0xdeadbeef"));
      expect(w!.message).toContain(lock.codeHash);
    }
  });

  it("warns, and does not throw, when the code cell cannot be read", async () => {
    const lock = await known(testnet, ccc.KnownScript.OmniLock, omniArgs);
    vi.spyOn(testnet, "findSingletonCellByType").mockRejectedValueOnce(new Error("rpc down"));
    await expect(checkOwnerLockBuild(lock, testnet)).resolves.toMatchObject({ code: "owner-lock-build-unresolved" });
    vi.spyOn(testnet, "findSingletonCellByType").mockResolvedValueOnce(undefined);
    await expect(checkOwnerLockBuild(lock, testnet)).resolves.toMatchObject({ code: "owner-lock-build-unresolved" });
  });

  it("does not trust a cell whose type script is not the lock's type id", async () => {
    const lock = await known(testnet, ccc.KnownScript.OmniLock, omniArgs);
    const other = await codeCell(testnet, ccc.KnownScript.NostrLock, "0x1234");
    vi.spyOn(testnet, "findSingletonCellByType").mockResolvedValue(other);
    const reviewed = [{ ...REVIEWED_OWNER_LOCK_BUILDS[0], codeHash: lock.codeHash, dataHash: ccc.hashCkb("0x1234") }];
    await expect(checkOwnerLockBuild(lock, testnet, reviewed)).resolves.toMatchObject({ code: "owner-lock-build-unresolved" });
  });

  it("leaves other locks alone: secp256k1 and multisig (by type or data), and type-id locks referenced by data hash", async () => {
    const find = vi.spyOn(mainnet, "findSingletonCellByType");
    const secp = await known(mainnet, ccc.KnownScript.Secp256k1Blake160, "0x" + "11".repeat(20));
    expect(secp.hashType).toBe("type");
    await expect(checkOwnerLockBuild(secp, mainnet)).resolves.toBeUndefined();
    await expect(checkOwnerLockBuild(await known(mainnet, ccc.KnownScript.Secp256k1Multisig, "0x" + "11".repeat(20)), mainnet)).resolves.toBeUndefined();
    // The genesis secp256k1 binary by its data hash.
    const secpByData = ccc.Script.from({
      codeHash: "0x709f3fda12f561cfacf92273c57a98fede188a3f1a59b1f888d113f9cce08649",
      hashType: "data1",
      args: "0x" + "11".repeat(20),
    });
    await expect(checkOwnerLockBuild(secpByData, mainnet)).resolves.toBeUndefined();
    // The reviewed Omnilock binary by its data hash already binds the build.
    const omniByData = ccc.Script.from({ codeHash: REVIEWED_OWNER_LOCK_BUILDS[0].dataHash, hashType: "data1", args: omniArgs });
    await expect(checkOwnerLockBuild(omniByData, mainnet)).resolves.toBeUndefined();
    // A testnet type id on a mainnet client is not one of this network's locks.
    await expect(checkOwnerLockBuild(await known(testnet, ccc.KnownScript.OmniLock, omniArgs), mainnet)).resolves.toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });
});

describe("the build warning through openSession and openSubscription", () => {
  class Owner extends ccc.SignerCkbPrivateKey {
    constructor(private lock: ccc.Script) {
      super(testnet, "0x" + "42".repeat(32));
    }
    async getRecommendedAddressObj() {
      return ccc.Address.fromScript(this.lock, this.client);
    }
  }
  const session = () =>
    createSession({ expiresAt: new Date(Date.now() + 60_000), scope: { maxPerTx: 5n * CKB } });
  const unknownBuild = async () =>
    vi.spyOn(testnet, "findSingletonCellByType").mockResolvedValue(await codeCell(testnet, ccc.KnownScript.OmniLock, "0xdeadbeef"));

  it("openSession reports an unreviewed build to onWarning and goes on", async () => {
    await unknownBuild();
    const owner = new Owner(await known(testnet, ccc.KnownScript.OmniLock, omniArgs));
    const seen: SessionWarning[] = [];
    // Past the warning: the next check (a fee budget too small) is the one that fails.
    await expect(
      openSession(owner, session(), d, { budget: 200n * CKB, feeBudget: 61n * CKB, onWarning: (w) => void seen.push(w) }),
    ).rejects.toBeInstanceOf(SessionBalanceError);
    expect(seen.map((w) => w.code)).toEqual(["owner-lock-build-unreviewed"]);
    expect(seen[0].dataHash).toBe(ccc.hashCkb("0xdeadbeef"));
  });

  it("openSession falls back to console.warn, and an onWarning that throws stops the opening", async () => {
    await unknownBuild();
    const owner = new Owner(await known(testnet, ccc.KnownScript.OmniLock, omniArgs));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(openSession(owner, session(), d, { budget: 200n * CKB, feeBudget: 61n * CKB })).rejects.toBeInstanceOf(
      SessionBalanceError,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^ckb-session-kit: .*not a build this kit has reviewed/));
    const stop = new Error("stop");
    await expect(
      openSession(owner, session(), d, { budget: 200n * CKB, onWarning: () => Promise.reject(stop) }),
    ).rejects.toBe(stop);
  });

  it("openSubscription reports it for the subscriber's lock before checking the charger", async () => {
    await unknownBuild();
    const subscriber = new Owner(await known(testnet, ccc.KnownScript.OmniLock, omniArgs));
    const acp = ccc.Address.fromScript(await known(testnet, ccc.KnownScript.AnyoneCanPay, "0x" + "77".repeat(20)), testnet).toString();
    const charger = ccc.Address.fromScript(await known(testnet, ccc.KnownScript.AnyoneCanPay, "0x" + "88".repeat(20)), testnet).toString();
    const seen: SessionWarning[] = [];
    await expect(
      openSubscription(subscriber, d, {
        charger,
        payTo: acp,
        price: 10n * CKB,
        periodBlocks: 20n,
        budget: 500n * CKB,
        onWarning: (w) => void seen.push(w),
      }),
    ).rejects.toMatchObject({ reason: "owner-lock-unsafe" });
    expect(seen.map((w) => w.code)).toEqual(["owner-lock-build-unreviewed"]);
  });

  it("a secp256k1 owner reads no code cell and gets no build warning", async () => {
    const find = vi.spyOn(testnet, "findSingletonCellByType");
    const owner = new Owner(await known(testnet, ccc.KnownScript.Secp256k1Blake160, "0x" + "11".repeat(20)));
    const seen: SessionWarning[] = [];
    await expect(
      openSession(owner, session(), d, { budget: 200n * CKB, feeBudget: 61n * CKB, minInterval: 10n, onWarning: (w) => void seen.push(w) }),
    ).rejects.toBeInstanceOf(SessionBalanceError);
    expect(seen).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});
