import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTNET_DEPLOYMENT as d } from "../src/lock.js";
import { assertSigningLock, openSession, SessionBalanceError } from "../src/onchain.js";
import { createSession, SessionPolicyError } from "../src/session.js";
import { openSubscription } from "../src/subscription.js";

// Mentor review, 2 Nov (tracker issue #47, review 3): the session lock gives owner
// mode to any transaction with an input under the owner's lock, so the owner's
// lock must not open without the owner's signature. Reviewed configurations pass;
// known signature-free paths never pass; anything else needs an explicit opt-in.

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;
const client = new ccc.ClientPublicTestnet();
const mainnet = new ccc.ClientPublicMainnet();
const known = async (k: ccc.KnownScript, args: string, c: ccc.Client = client) =>
  ccc.Script.from({ ...(await c.getKnownScript(k)), args });
const omni = (auth: string, flags: string, rest = "") => known(ccc.KnownScript.OmniLock, "0x" + auth + "11".repeat(20) + flags + rest);
const optIn = { allowUnreviewedOwnerLock: true };

/** The refusal `lock` gets, with and without the opt-in. */
async function refusal(lock: ccc.Script, opts?: { allowUnreviewedOwnerLock?: boolean }) {
  try {
    await assertSigningLock(lock, client, opts);
  } catch (e) {
    expect(e).toBeInstanceOf(SessionPolicyError);
    return e as SessionPolicyError;
  }
  throw new Error("accepted");
}

/** Refused even with the opt-in, as a lock that opens without the owner's signature. */
async function expectUnsafe(lock: ccc.Script, message: RegExp) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const opts of [undefined, optIn]) {
    const e = await refusal(lock, opts);
    expect(e.message).toMatch(message);
    expect(e.reason).toBe("owner-lock-unsafe");
  }
  expect(warn).not.toHaveBeenCalled();
}

/** Refused by default as unreviewed; accepted with the opt-in, with a warning. */
async function expectUnreviewed(lock: ccc.Script, message: RegExp) {
  const e = await refusal(lock);
  expect(e.message).toMatch(message);
  expect(e.reason).toBe("owner-lock-unreviewed");
  expect(e.message).toMatch(/allowUnreviewedOwnerLock/);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(assertSigningLock(lock, client, optIn)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toMatch(message);
  warn.mockRestore();
}

/** Accepted with no opt-in and no warning. */
async function expectReviewed(lock: ccc.Script) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(assertSigningLock(lock, client)).resolves.toBeUndefined();
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
}

afterEach(() => vi.restoreAllMocks());

describe("assertSigningLock: the wallet matrix still owns sessions with no opt-in", () => {
  it("CKB default lock, multisig with and without a since", async () => {
    await expectReviewed(await known(ccc.KnownScript.Secp256k1Blake160, "0x" + "11".repeat(20)));
    await expectReviewed(await known(ccc.KnownScript.Secp256k1Multisig, "0x" + "11".repeat(20)));
    await expectReviewed(await known(ccc.KnownScript.Secp256k1Multisig, "0x" + "11".repeat(20) + "22".repeat(8)));
    await expectReviewed(await known(ccc.KnownScript.Secp256k1MultisigV2, "0x" + "11".repeat(20)));
  });

  it("Omnilock with Ethereum (0x12, 0x01), Bitcoin, Dogecoin, Tron, EOS, CKB and multisig auth", async () => {
    for (const auth of ["00", "01", "02", "03", "04", "05", "06", "12"]) await expectReviewed(await omni(auth, "00"));
  });

  it("Omnilock with time-lock or supply mode, which only add checks", async () => {
    await expectReviewed(await omni("00", "04", "22".repeat(8)));
    await expectReviewed(await omni("04", "08", "33".repeat(32)));
  });

  it("Nostr lock in signing mode (PoW difficulty 0), and JoyID", async () => {
    await expectReviewed(await known(ccc.KnownScript.NostrLock, "0x00" + "11".repeat(20)));
    await expectReviewed(await known(ccc.KnownScript.JoyId, "0x0001" + "11".repeat(20)));
  });

  it("the same locks on mainnet", async () => {
    const lock = await known(ccc.KnownScript.OmniLock, "0x12" + "11".repeat(20) + "00", mainnet);
    await expect(assertSigningLock(lock, mainnet)).resolves.toBeUndefined();
  });
});

describe("assertSigningLock: known signature-free paths are refused, even with the opt-in", () => {
  // Nostr lock docs: args[0] is the PoW difficulty; non-zero needs work, not a key.
  it("Nostr lock in PoW mode", async () => {
    for (const difficulty of ["01", "10", "ff"]) {
      await expectUnsafe(await known(ccc.KnownScript.NostrLock, "0x" + difficulty + "00".repeat(20)), /proof of work/);
    }
  });

  // lay2dev/pw-lock: the deployed build (sighash_all_acpl) takes the payment path
  // whenever the witness carries no signature, whatever the args.
  it("PW-Lock, with or without minimum-amount bytes, on testnet and mainnet", async () => {
    for (const args of ["11".repeat(20), "11".repeat(20) + "00", "11".repeat(20) + "0500"]) {
      await expectUnsafe(await known(ccc.KnownScript.PWLock, "0x" + args), /PW-Lock/);
    }
    await expectUnsafe(await known(ccc.KnownScript.PWLock, "0x" + "11".repeat(20), mainnet), /PW-Lock/);
  });

  it("anyone-can-pay, including the other network's and the older pw-core deployments", async () => {
    await expectUnsafe(await known(ccc.KnownScript.AnyoneCanPay, "0x" + "11".repeat(20)), /anyone-can-pay/);
    await expectUnsafe(await known(ccc.KnownScript.AnyoneCanPay, "0x" + "11".repeat(20), mainnet), /anyone-can-pay/);
    const legacy = [
      { codeHash: "0x0fb343953ee78c9986b091defb6252154e0bb51044fd2879fde5b27314506111", hashType: "data" },
      { codeHash: "0x86a1c6987a4acbe1a887cca4c9dd2ac9fcb07405bbeda51b861b18bbf7492c4b", hashType: "type" },
    ] as const;
    for (const s of legacy) await expectUnsafe(ccc.Script.from({ ...s, args: "0x" + "11".repeat(20) }), /anyone-can-pay/);
  });

  it("Omnilock in anyone-can-pay mode, with or without other modes", async () => {
    await expectUnsafe(await omni("00", "02", "0000"), /anyone-can-pay/);
    await expectUnsafe(await omni("12", "06", "0000" + "22".repeat(8)), /anyone-can-pay/);
  });

  it("Omnilock with an administrator, who can unlock it without the owner", async () => {
    await expectUnsafe(await omni("00", "01", "22".repeat(32)), /administrator/);
  });

  it("always-success", async () => {
    await expectUnsafe(await known(ccc.KnownScript.AlwaysSuccess, "0x"), /always/);
  });

  // Review W6 L6: the same binaries referenced by data hash, under any data hash_type.
  // Data hashes of the code cells CCC lists for each script, read from testnet and mainnet (2 Nov).
  it("the same signature-free binaries referenced by data hash (data, data1, data2)", async () => {
    const byData: [string, RegExp][] = [
      ["0x3b521cc4b552f109d092d8cc468a8048acb53c5952dbe769d2b2f9cf6e47f7f1", /always-success/],
      ["0xcd69ba816f7471e59110058aa37387c362ed9a240cd178f7bb1ecee386cb31e6", /anyone-can-pay/],
      ["0x0fb343953ee78c9986b091defb6252154e0bb51044fd2879fde5b27314506111", /anyone-can-pay/],
      ["0xeffe377419256d150d68368d7cb5731edad39d1805a8c2c73ce8e9615b9f9878", /PW-Lock/],
      ["0xd6a5a0edb152e88e8bbc702e164441cb3890fae35da672b408d28ca9a1bde3ee", /PW-Lock/],
    ];
    for (const [codeHash, what] of byData) {
      for (const hashType of ["data", "data1", "data2"] as const) {
        await expectUnsafe(ccc.Script.from({ codeHash, hashType, args: "0x" + "11".repeat(20) }), what);
      }
    }
  });
});

describe("assertSigningLock: unreviewed configurations need allowUnreviewedOwnerLock", () => {
  // RFC 0042: 0xFC passes when an input under another lock is present; 0xFD and
  // 0xFE run other code. Safe only if what they delegate to is.
  it("Omnilock that delegates its check (auth 0xFC, 0xFD, 0xFE)", async () => {
    for (const auth of ["fc", "fd", "fe"]) await expectUnreviewed(await omni(auth, "00"), /does not verify a signature itself/);
  });

  it("Omnilock auth flags the deployed code does not know, and unknown mode bits", async () => {
    await expectUnreviewed(await omni("07", "00"), /auth flag 0x07/);
    await expectUnreviewed(await omni("00", "10"), /mode flags 0x10/);
  });

  it("the ckb-proxy-locks, which hand the decision to another script", async () => {
    for (const k of [
      ccc.KnownScript.LockProxyLock,
      ccc.KnownScript.InputTypeProxyLock,
      ccc.KnownScript.OutputTypeProxyLock,
      ccc.KnownScript.SingleUseLock,
      ccc.KnownScript.TypeBurnLock,
      ccc.KnownScript.TimeLock,
    ]) {
      await expectUnreviewed(await known(k, "0x" + "11".repeat(32)), /not one this kit has reviewed/);
    }
  });

  it("a lock it does not know, and a known lock with args its code would not accept", async () => {
    await expectUnreviewed(ccc.Script.from({ codeHash: h("ab"), hashType: "data1", args: "0x" }), /not one this kit has reviewed/);
    await expectUnreviewed(await known(ccc.KnownScript.Secp256k1MultisigV2Beta, "0x" + "11".repeat(20)), /not one this kit has reviewed/);
    await expectUnreviewed(await known(ccc.KnownScript.Secp256k1Blake160, "0x" + "11".repeat(21)), /args/);
    await expectUnreviewed(await known(ccc.KnownScript.NostrLock, "0x00" + "11".repeat(21)), /args/);
  });
});

describe("the opt-in through openSession and openSubscription", () => {
  const unreviewed = ccc.Script.from({ codeHash: h("ab"), hashType: "data1", args: "0x" + "11".repeat(20) });
  class Owner extends ccc.SignerCkbPrivateKey {
    constructor(private lock: ccc.Script) {
      super(client, "0x" + "42".repeat(32));
    }
    async getRecommendedAddressObj() {
      return ccc.Address.fromScript(this.lock, this.client);
    }
  }
  const session = () => createSession({ expiresAt: new Date(Date.now() + 60_000), scope: { maxPerTx: 5n * CKB } });

  it("openSession refuses an unreviewed owner lock, and goes on with the opt-in and a warning", async () => {
    const owner = new Owner(unreviewed);
    await expect(openSession(owner, session(), d, { budget: 200n * CKB })).rejects.toMatchObject({ reason: "owner-lock-unreviewed" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Past the owner check: the next check (a fee budget too small) is the one that fails.
    await expect(
      openSession(owner, session(), d, { budget: 200n * CKB, feeBudget: 61n * CKB, allowUnreviewedOwnerLock: true }),
    ).rejects.toBeInstanceOf(SessionBalanceError);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("openSession refuses PW-Lock even with the opt-in", async () => {
    const owner = new Owner(await known(ccc.KnownScript.PWLock, "0x" + "11".repeat(20)));
    await expect(openSession(owner, session(), d, { budget: 200n * CKB, allowUnreviewedOwnerLock: true })).rejects.toMatchObject({
      reason: "owner-lock-unsafe",
    });
  });

  it("openSubscription passes the opt-in on, and still refuses a signature-free charger", async () => {
    const subscriber = new Owner(unreviewed);
    const acp = ccc.Address.fromScript(await known(ccc.KnownScript.AnyoneCanPay, "0x" + "77".repeat(20)), client).toString();
    const charger = ccc.Address.fromScript(await known(ccc.KnownScript.AnyoneCanPay, "0x" + "88".repeat(20)), client).toString();
    const terms = { charger, payTo: acp, price: 10n * CKB, periodBlocks: 20n, budget: 500n * CKB };
    await expect(openSubscription(subscriber, d, terms)).rejects.toMatchObject({ reason: "owner-lock-unreviewed" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(openSubscription(subscriber, d, { ...terms, allowUnreviewedOwnerLock: true })).rejects.toMatchObject({
      reason: "owner-lock-unsafe",
    });
  });

  // Review W6 I1: opting in for one's own wallet does not waive review of the creator's charger lock.
  it("openSubscription takes a separate opt-in for the charger's lock", async () => {
    const subscriber = new Owner(await known(ccc.KnownScript.Secp256k1Blake160, "0x" + "11".repeat(20)));
    const acp = ccc.Address.fromScript(await known(ccc.KnownScript.AnyoneCanPay, "0x" + "77".repeat(20)), client).toString();
    const charger = ccc.Address.fromScript(unreviewed, client).toString();
    const terms = { charger, payTo: acp, price: 10n * CKB, periodBlocks: 20n, budget: 500n * CKB };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(openSubscription(subscriber, d, { ...terms, allowUnreviewedOwnerLock: true })).rejects.toMatchObject({
      reason: "owner-lock-unreviewed",
      message: expect.stringMatching(/charger/),
    });
    // With the charger's own opt-in, the lock check passes (and warns); what fails next is the funding.
    const err = await openSubscription(subscriber, d, { ...terms, allowUnreviewedChargerLock: true }).catch((e: unknown) => e);
    expect(err).not.toMatchObject({ reason: "owner-lock-unreviewed" });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/charger/));
  });
});
