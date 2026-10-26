import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTNET_DEPLOYMENT as d, TESTNET_LEGACY_DEPLOYMENTS } from "../src/lock.js";
import { SessionBalanceError } from "../src/onchain.js";
import { SessionPolicyError } from "../src/session.js";
import {
  chargeSubscription,
  subscriptionMemo,
  openSubscription,
  subscriptionLock,
  verifySubscription,
  type Subscription,
} from "../src/subscription.js";

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;
const PERIOD = 20n;

/** A testnet client whose chain is the given cells; the tip is block 1000, every cell born at `born`. */
function fakeClient(cells: ccc.Cell[], born = 900n, creating: ccc.Transaction = ccc.Transaction.default()) {
  const sent: ccc.Transaction[] = [];
  const client = Object.assign(new ccc.ClientPublicTestnet(), {
    async *findCellsByLock(lock: ccc.ScriptLike) {
      for (const c of cells) if (c.cellOutput.lock.eq(ccc.Script.from(lock))) yield c;
    },
    getCellLive: async (op: ccc.OutPointLike) => cells.find((c) => c.outPoint.eq(ccc.OutPoint.from(op))),
    getCell: async (op: ccc.OutPointLike) => cells.find((c) => c.outPoint.eq(ccc.OutPoint.from(op))),
    getTip: async () => 1000n,
    getTransaction: async () => ({ blockNumber: born, status: "committed", transaction: creating }),
    sendTransaction: async (tx: ccc.Transaction) => {
      sent.push(tx);
      return tx.hash();
    },
  });
  return { client: client as unknown as ccc.Client, sent };
}

const keys = { subscriber: h("51"), charger: h("c1") };
async function roles(client: ccc.Client) {
  const subscriber = new ccc.SignerCkbPrivateKey(client, keys.subscriber);
  const charger = new ccc.SignerCkbPrivateKey(client, keys.charger);
  const payToLock = ccc.Script.from({ ...(await client.getKnownScript(ccc.KnownScript.AnyoneCanPay)), args: "0x" + "77".repeat(20) });
  const payTo = ccc.Address.fromScript(payToLock, client).toString();
  const subscriberLock = (await subscriber.getRecommendedAddressObj()).script;
  const chargerLock = (await charger.getRecommendedAddressObj()).script;
  const sub: Subscription = {
    subscriberLockHash: subscriberLock.hash(),
    chargerLockHash: chargerLock.hash(),
    payToLockHash: payToLock.hash(),
    price: 10n * CKB,
    periodBlocks: PERIOD,
  };
  return { subscriber, charger, payTo, payToLock, chargerLock, sub };
}

let n = 0;
const cellOf = (lock: ccc.Script, capacity: bigint, extra: Partial<ccc.CellOutputLike> = {}, data = "0x") =>
  ccc.Cell.from({ outPoint: { txHash: h("0" + (n++ % 10)), index: n }, cellOutput: { lock, capacity, ...extra }, outputData: data });

afterEach(() => vi.restoreAllMocks());

describe("subscriptionLock", () => {
  it("is the 112-byte session lock layout: subscriber, charger, price, period, payout", async () => {
    const { sub } = await roles(fakeClient([]).client);
    const args = ccc.bytesFrom(subscriptionLock(d, sub).args);
    expect(args.length).toBe(112);
    expect(ccc.hexFrom(args.slice(0, 32))).toBe(sub.subscriberLockHash);
    expect(ccc.hexFrom(args.slice(32, 64))).toBe(sub.chargerLockHash);
    expect(ccc.numLeFromBytes(args.slice(64, 72))).toBe(sub.price);
    expect(ccc.numLeFromBytes(args.slice(72, 80))).toBe(PERIOD);
    expect(ccc.hexFrom(args.slice(80, 112))).toBe(sub.payToLockHash);
  });
});

describe("openSubscription refuses terms the lock would not enforce as meant", () => {
  const open = async (o: Partial<{ charger: string; payTo: string; price: bigint; periodBlocks: bigint }>) => {
    const { client } = fakeClient([]);
    const r = await roles(client);
    const charger = (await r.charger.getRecommendedAddressObj()).toString();
    return openSubscription(r.subscriber, d, { charger, payTo: r.payTo, price: 10n * CKB, periodBlocks: PERIOD, budget: 500n * CKB, ...o });
  };

  it("a payout address equal to the charger (every charge would fail with error 17)", async () => {
    const { client } = fakeClient([]);
    const charger = (await new ccc.SignerCkbPrivateKey(client, keys.charger).getRecommendedAddressObj()).toString();
    await expect(open({ payTo: charger })).rejects.toThrow(/error 17/);
  });

  it("a period of 0, which is no rate limit at all", async () => {
    await expect(open({ periodBlocks: 0n })).rejects.toThrow(SessionPolicyError);
  });

  it("a price of 0", async () => {
    await expect(open({ price: 0n })).rejects.toThrow(SessionPolicyError);
  });

  it("a charger or payout address that is the subscriber", async () => {
    const { client } = fakeClient([]);
    const me = (await new ccc.SignerCkbPrivateKey(client, keys.subscriber).getRecommendedAddressObj()).toString();
    await expect(open({ charger: me })).rejects.toThrow(/charger must not be the subscriber/);
    await expect(open({ payTo: me })).rejects.toThrow(/payTo must not be the subscriber/);
  });

  it("an old deployment of the lock (the 8 Oct code lacks errors 16-18)", async () => {
    const { client } = fakeClient([]);
    const r = await roles(client);
    const charger = (await r.charger.getRecommendedAddressObj()).toString();
    await expect(
      openSubscription(r.subscriber, TESTNET_LEGACY_DEPLOYMENTS[1], { charger, payTo: r.payTo, price: 10n * CKB, periodBlocks: PERIOD, budget: 500n * CKB }),
    ).rejects.toThrow(/old deployment/);
  });

  it("a second subscription with exactly the same terms (one group, two charges per period)", async () => {
    const { client: c0 } = fakeClient([]);
    const r = await roles(c0);
    const { client } = fakeClient([cellOf(subscriptionLock(d, r.sub), 500n * CKB)]);
    const subscriber = new ccc.SignerCkbPrivateKey(client, keys.subscriber);
    const charger = (await r.charger.getRecommendedAddressObj()).toString();
    await expect(
      openSubscription(subscriber, d, { charger, payTo: r.payTo, price: 10n * CKB, periodBlocks: PERIOD, budget: 500n * CKB }),
    ).rejects.toThrow(/already open/);
  });

  it("a price below the size of a new payout cell, when payTo is not anyone-can-pay", async () => {
    const { client } = fakeClient([]);
    const plain = (await new ccc.SignerCkbPrivateKey(client, h("99")).getRecommendedAddressObj()).toString();
    await expect(open({ payTo: plain, price: 60n * CKB })).rejects.toThrow(/raise the price/);
  });
});

describe("openSubscription", () => {
  // Review H1: a new cell cannot be charged for a whole period, so the opening pays the first one.
  it("pays the first period to payTo at once and commits to the account in the subscriber's witness", async () => {
    const { client: c0 } = fakeClient([]);
    const r = await roles(c0);
    const subscriberLock = (await r.subscriber.getRecommendedAddressObj()).script;
    const own = cellOf(subscriberLock, 1000n * CKB);
    const acpCell = cellOf(r.payToLock, 200n * CKB);
    vi.spyOn(ccc.Transaction.prototype, "completeInputsByCapacity").mockImplementation(async function (this: ccc.Transaction) {
      this.inputs.push(ccc.CellInput.from({ previousOutput: own.outPoint }));
      return 1 as never;
    });
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    const { client, sent } = fakeClient([own, acpCell]);
    const subscriber = new ccc.SignerCkbPrivateKey(client, keys.subscriber);
    const charger = (await r.charger.getRecommendedAddressObj()).toString();
    await openSubscription(subscriber, d, { charger, payTo: r.payTo, price: 10n * CKB, periodBlocks: PERIOD, budget: 173n * CKB, account: "alice" });

    const tx = sent[0];
    expect(tx.outputs[0].lock.eq(subscriptionLock(d, r.sub))).toBe(true);
    expect(tx.outputs[0].capacity).toBe(173n * CKB);
    expect(tx.outputs[1].lock.eq(r.payToLock)).toBe(true);
    expect(tx.outputs[1].capacity).toBe(210n * CKB);
    expect(tx.inputs[0].previousOutput.eq(acpCell.outPoint)).toBe(true);
    expect(tx.getWitnessArgsAt(1)?.inputType).toBe(subscriptionMemo("alice"));
  });
});

describe("chargeSubscription", () => {
  it("refuses before a full period, saying how long to wait", async () => {
    const { client } = fakeClient([]);
    const r = await roles(client);
    const young = fakeClient([cellOf(subscriptionLock(d, r.sub), 500n * CKB)], 990n).client;
    const charger = new ccc.SignerCkbPrivateKey(young, keys.charger);
    await expect(chargeSubscription(charger, d, r.sub, { payTo: r.payTo })).rejects.toThrow(/next charge in 10 blocks/);
  });

  it("refuses a signer that is not the charger", async () => {
    const { client } = fakeClient([]);
    const r = await roles(client);
    await expect(chargeSubscription(r.subscriber, d, r.sub, { payTo: r.payTo })).rejects.toThrow(/not the subscription's charger/);
  });

  it("takes exactly the price with the period as since, tops up payTo, and the charger pays the fee", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeChangeToOutput").mockImplementation(async function (this: ccc.Transaction) {
      const last = this.outputs[this.outputs.length - 1];
      last.capacity = this.inputs.length ? 100n * CKB - 1000n : 0n; // the charger cell, minus a fee
      return [0, true] as never;
    });
    const { client: c0 } = fakeClient([]);
    const r = await roles(c0);
    const subCell = cellOf(subscriptionLock(d, r.sub), 500n * CKB);
    const acpCell = cellOf(r.payToLock, 200n * CKB);
    const feeCell = cellOf(r.chargerLock, 100n * CKB);
    const { client, sent } = fakeClient([subCell, acpCell, feeCell]);
    await chargeSubscription(new ccc.SignerCkbPrivateKey(client, keys.charger), d, r.sub, { payTo: r.payTo, topUp: true });

    const tx = sent[0];
    expect(tx.inputs[0].previousOutput.eq(subCell.outPoint)).toBe(true);
    expect(tx.inputs[0].since).toBe((1n << 63n) | PERIOD);
    expect(tx.outputs[0]).toMatchObject({ capacity: 210n * CKB });
    expect(tx.outputs[0].lock.eq(r.payToLock)).toBe(true);
    expect(tx.outputs[1].capacity).toBe(490n * CKB); // the change: exactly one price left the subscription
    expect(tx.outputs[2].lock.eq(r.chargerLock)).toBe(true);
    expect(tx.outputs[2].capacity).toBeLessThan(100n * CKB); // the key cell paid the fee, did not grow
  });

  it("refuses once what is left cannot cover a price and a cell", async () => {
    const { client: c0 } = fakeClient([]);
    const r = await roles(c0);
    const { client } = fakeClient([cellOf(subscriptionLock(d, r.sub), 160n * CKB), cellOf(r.chargerLock, 100n * CKB)]);
    await expect(
      chargeSubscription(new ccc.SignerCkbPrivateKey(client, keys.charger), d, r.sub, { payTo: r.payTo, topUp: true }),
    ).rejects.toThrow(SessionBalanceError);
  });
});

describe("verifySubscription", () => {
  /**
   * The cell `mutate` makes, created by a transaction that tops up the payout cell
   * by `paid` and spends a subscriber cell whose witness carries `memo`.
   */
  async function setup(mutate: (lock: ccc.Script) => ccc.Cell, paid = 10n * CKB, memo?: ccc.Hex) {
    const { client: c0 } = fakeClient([]);
    const r = await roles(c0);
    const cell = mutate(subscriptionLock(d, r.sub));
    const subscriberLock = (await r.subscriber.getRecommendedAddressObj()).script;
    const payIn = cellOf(r.payToLock, 200n * CKB);
    const own = cellOf(subscriberLock, 1000n * CKB);
    const creating = ccc.Transaction.from({
      inputs: [{ previousOutput: payIn.outPoint }, { previousOutput: own.outPoint }],
      outputs: [cell.cellOutput, { lock: r.payToLock, capacity: 200n * CKB + paid }],
      outputsData: ["0x", "0x"],
    });
    if (memo) creating.setWitnessArgsAt(1, { inputType: memo });
    const { client } = fakeClient([cell, payIn, own], 900n, creating);
    const charger = (await r.charger.getRecommendedAddressObj()).toString();
    const expected = { charger, payTo: r.payTo, price: 10n * CKB, periodBlocks: PERIOD };
    return {
      check: (e: Partial<typeof expected & { account: string; minBalance: bigint }> = {}) =>
        verifySubscription(client, d, cell.outPoint, { ...expected, ...e }),
      r,
    };
  }

  it("accepts a live cell with exactly the terms and room for a charge", async () => {
    const { check, r } = await setup((lock) => cellOf(lock, 500n * CKB));
    expect(await check()).toEqual({
      ok: true,
      subscription: r.sub,
      balance: 500n * CKB,
      chargesLeft: 34n, // (500 - 153) / 10
      paidThroughBlock: 900n + PERIOD,
    });
  });

  // Review H1/H2: a cell the subscriber re-created in owner mode paid nothing.
  it("refuses a cell whose creating transaction did not pay the price to payTo", async () => {
    const { check } = await setup((lock) => cellOf(lock, 500n * CKB), 10n * CKB - 1n);
    expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/did not pay/) });
  });

  // Review H3: subscription cells are public; the opening must commit to the account.
  it("accepts the account the subscriber signed for, and refuses any other", async () => {
    const { check } = await setup((lock) => cellOf(lock, 500n * CKB), 10n * CKB, subscriptionMemo("alice"));
    expect(await check({ account: "alice" })).toMatchObject({ ok: true });
    expect(await check({ account: "mallory" })).toMatchObject({ ok: false, reason: expect.stringMatching(/account/) });
  });

  it.each([
    ["a different price", { price: 11n * CKB }, /price/],
    ["a different period", { periodBlocks: PERIOD + 1n }, /period/],
  ])("refuses %s", async (_, e, reason) => {
    const { check } = await setup((lock) => cellOf(lock, 500n * CKB));
    expect(await check(e)).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });

  it("refuses a cell under an older deployment of the lock", async () => {
    const { check } = await setup((lock) =>
      cellOf(ccc.Script.from({ ...lock, codeHash: TESTNET_LEGACY_DEPLOYMENTS[0].codeHash }), 500n * CKB),
    );
    expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/deployment/) });
  });

  it("refuses a typed cell, and one under minBalance", async () => {
    const typed = await setup((lock) => cellOf(lock, 500n * CKB, { type: { codeHash: h("ee"), hashType: "type", args: "0x" } }));
    expect(await typed.check()).toMatchObject({ ok: false });
    const small = await setup((lock) => cellOf(lock, 160n * CKB));
    expect(await small.check({ minBalance: 163n * CKB })).toMatchObject({ ok: false, reason: expect.stringMatching(/minimum/) });
  });

  it("refuses an 80-byte session (no payout address) with the same prefix", async () => {
    const { check } = await setup((lock) => cellOf(ccc.Script.from({ ...lock, args: lock.args.slice(0, 2 + 160) }), 500n * CKB));
    expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/112 bytes/) });
  });
});
