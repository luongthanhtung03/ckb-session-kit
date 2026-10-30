import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTNET_DEPLOYMENT as d, TESTNET_LEGACY_DEPLOYMENTS } from "../src/lock.js";
import { SessionBalanceError } from "../src/onchain.js";
import { SessionPolicyError } from "../src/session.js";
import {
  cancelSubscription,
  chargeSubscription,
  subscriptionMemo,
  subscriptionStatus,
  openSubscription,
  subscriptionLock,
  verifySubscription,
  type Subscription,
} from "../src/subscription.js";

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;
const PERIOD = 20n;

/** A testnet client whose chain is the given cells; the tip is block 1000, every cell born at `born`. */
function fakeClient(
  cells: ccc.Cell[],
  born = 900n,
  creating: ccc.Transaction | ((hash: string) => ccc.Transaction) = ccc.Transaction.default(),
) {
  const sent: ccc.Transaction[] = [];
  const client = Object.assign(new ccc.ClientPublicTestnet(), {
    async *findCellsByLock(lock: ccc.ScriptLike) {
      for (const c of cells) if (c.cellOutput.lock.eq(ccc.Script.from(lock))) yield c;
    },
    getCellLive: async (op: ccc.OutPointLike) => cells.find((c) => c.outPoint.eq(ccc.OutPoint.from(op))),
    getCell: async (op: ccc.OutPointLike) => cells.find((c) => c.outPoint.eq(ccc.OutPoint.from(op))),
    getTip: async () => 1000n,
    getTransaction: async (hash: ccc.HexLike) => ({
      blockNumber: born,
      status: "committed",
      transaction: typeof creating === "function" ? creating(ccc.hexFrom(hash)) : creating,
    }),
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

  // Review, 28 Oct: openings at once must not all compete for the first payout cell.
  it("tops up a random one of payTo's cells", async () => {
    const { client: c0 } = fakeClient([]);
    const r = await roles(c0);
    const subscriberLock = (await r.subscriber.getRecommendedAddressObj()).script;
    const own = cellOf(subscriberLock, 1000n * CKB);
    const first = cellOf(r.payToLock, 200n * CKB);
    const last = cellOf(r.payToLock, 300n * CKB);
    vi.spyOn(ccc.Transaction.prototype, "completeInputsByCapacity").mockImplementation(async function (this: ccc.Transaction) {
      this.inputs.push(ccc.CellInput.from({ previousOutput: own.outPoint }));
      return 1 as never;
    });
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const { client, sent } = fakeClient([own, first, last]);
    const subscriber = new ccc.SignerCkbPrivateKey(client, keys.subscriber);
    const charger = (await r.charger.getRecommendedAddressObj()).toString();
    await openSubscription(subscriber, d, { charger, payTo: r.payTo, price: 10n * CKB, periodBlocks: PERIOD, budget: 173n * CKB });
    expect(sent[0].inputs[0].previousOutput.eq(last.outPoint)).toBe(true);
    expect(sent[0].outputs[1].capacity).toBe(310n * CKB);
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

  // Code review, 26 Oct: the rate limit is per cell, so every mature cell goes into one charge.
  it("merges every mature cell into one change, so two cells cannot pay two prices a period", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeChangeToOutput").mockResolvedValue([0, true] as never);
    const { client: c0 } = fakeClient([]);
    const r = await roles(c0);
    const lock = subscriptionLock(d, r.sub);
    const a = cellOf(lock, 300n * CKB);
    const b = cellOf(lock, 200n * CKB);
    const { client, sent } = fakeClient([a, b, cellOf(r.payToLock, 200n * CKB), cellOf(r.chargerLock, 100n * CKB)]);
    await chargeSubscription(new ccc.SignerCkbPrivateKey(client, keys.charger), d, r.sub, { payTo: r.payTo, topUp: true });
    const tx = sent[0];
    expect(tx.inputs.filter((i) => i.since === ((1n << 63n) | PERIOD))).toHaveLength(2);
    expect(tx.outputs.filter((o) => o.lock.eq(lock)).map((o) => o.capacity)).toEqual([490n * CKB]);
  });

  // Review, 28 Oct: an older cell (a top-up) must not pay a second price in the period of the last charge.
  it("refuses while the last charge is under a period old, even if another cell is mature", async () => {
    const { client: c0 } = fakeClient([]);
    const r = await roles(c0);
    const lock = subscriptionLock(d, r.sub);
    const fee = cellOf(r.chargerLock, 100n * CKB);
    const CHARGED = h("0f");
    const change = ccc.Cell.from({ outPoint: { txHash: CHARGED, index: 1 }, cellOutput: { lock, capacity: 300n * CKB }, outputData: "0x" });
    const topUp = cellOf(lock, 200n * CKB);
    const charge = ccc.Transaction.from({ inputs: [{ previousOutput: fee.outPoint }] });
    const { client } = fakeClient([change, topUp, fee, cellOf(r.payToLock, 200n * CKB)], 900n, (hash) =>
      hash === CHARGED ? charge : ccc.Transaction.default(),
    );
    const getTransaction = client.getTransaction.bind(client);
    // The charge's change is 10 blocks old; the top-up 100.
    client.getTransaction = (async (hash: ccc.HexLike) => {
      const res = await getTransaction(hash);
      return ccc.hexFrom(hash) === CHARGED ? { ...res, blockNumber: 990n } : res;
    }) as never;
    await expect(
      chargeSubscription(new ccc.SignerCkbPrivateKey(client, keys.charger), d, r.sub, { payTo: r.payTo, topUp: true }),
    ).rejects.toThrow(/next charge in 10 blocks/);
  });

  // Review, 28 Oct: charges at once (many subscriptions, one charger) must not all pick the first fee cell.
  it("pays the fee from a random one of the charger's cells", async () => {
    vi.spyOn(ccc.Transaction.prototype, "completeFeeChangeToOutput").mockResolvedValue([0, true] as never);
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const { client: c0 } = fakeClient([]);
    const r = await roles(c0);
    const small = cellOf(r.chargerLock, 61n * CKB); // at the floor: cannot pay a fee
    const first = cellOf(r.chargerLock, 100n * CKB);
    const last = cellOf(r.chargerLock, 100n * CKB);
    const { client, sent } = fakeClient([cellOf(subscriptionLock(d, r.sub), 500n * CKB), cellOf(r.payToLock, 200n * CKB), first, last, small]);
    await chargeSubscription(new ccc.SignerCkbPrivateKey(client, keys.charger), d, r.sub, { payTo: r.payTo, topUp: true });
    const tx = sent[0];
    expect(tx.inputs[tx.inputs.length - 1].previousOutput.eq(last.outPoint)).toBe(true);
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
  async function setup(mutate: (lock: ccc.Script) => ccc.Cell, paid = 10n * CKB, memo?: ccc.Hex, extra: ccc.CellOutputLike[] = []) {
    const { client: c0 } = fakeClient([]);
    const r = await roles(c0);
    const cell = mutate(subscriptionLock(d, r.sub));
    const subscriberLock = (await r.subscriber.getRecommendedAddressObj()).script;
    const payIn = cellOf(r.payToLock, 200n * CKB);
    const own = cellOf(subscriberLock, 1000n * CKB);
    const creating = ccc.Transaction.from({
      inputs: [{ previousOutput: payIn.outPoint }, { previousOutput: own.outPoint }],
      outputs: [cell.cellOutput, { lock: r.payToLock, capacity: 200n * CKB + paid }, ...extra],
      outputsData: ["0x", "0x", ...extra.map(() => "0x")],
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

  // Code review, 26 Oct: one payment must not open (or renew) several subscriptions.
  it("refuses one price paid for two subscription cells with the same payout address", async () => {
    const { client: c0 } = fakeClient([]);
    const r = await roles(c0);
    const other = subscriptionLock(d, { ...r.sub, subscriberLockHash: h("e7") });
    const one = await setup((lock) => cellOf(lock, 500n * CKB), 10n * CKB, undefined, [{ lock: other, capacity: 200n * CKB }]);
    expect(await one.check()).toMatchObject({ ok: false, reason: expect.stringMatching(/did not pay/) });
    const both = await setup((lock) => cellOf(lock, 500n * CKB), 20n * CKB, undefined, [{ lock: other, capacity: 200n * CKB }]);
    expect(await both.check()).toMatchObject({ ok: true });
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

describe("subscriptionStatus (a server with no database)", () => {
  const OPEN = h("0a");
  async function setup(opts: { liveCreatedBy?: "opening" | "recreate" | "read" | "charge"; memo?: string } = {}) {
    const { client: c0 } = fakeClient([]);
    const r = await roles(c0);
    const lock = subscriptionLock(d, r.sub);
    const subscriberLock = (await r.subscriber.getRecommendedAddressObj()).script;
    const payIn = cellOf(r.payToLock, 200n * CKB);
    const own = cellOf(subscriberLock, 1000n * CKB);
    const opening = ccc.Transaction.from({
      inputs: [{ previousOutput: payIn.outPoint }, { previousOutput: own.outPoint }],
      outputs: [{ lock, capacity: 173n * CKB }, { lock: r.payToLock, capacity: 210n * CKB }],
      outputsData: ["0x", "0x"],
    });
    opening.setWitnessArgsAt(1, { inputType: subscriptionMemo(opts.memo ?? "alice") });
    // The subscriber re-creates the cell in owner mode: no payment to payTo.
    const recreate = ccc.Transaction.from({
      inputs: [{ previousOutput: own.outPoint }],
      outputs: [{ lock, capacity: 173n * CKB }],
      outputsData: ["0x"],
    });
    const RECREATE = h("0b");
    // Someone else's paid read that tops up payTo by a price and also puts a cell under this lock.
    const stranger = cellOf(ccc.Script.from({ ...r.payToLock, args: "0x" + "66".repeat(20) }), 500n * CKB);
    const read = ccc.Transaction.from({
      inputs: [{ previousOutput: payIn.outPoint }, { previousOutput: stranger.outPoint }],
      outputs: [{ lock, capacity: 173n * CKB }, { lock: r.payToLock, capacity: 210n * CKB }],
      outputsData: ["0x", "0x"],
    });
    const READ = h("0c");
    // A charge: the charger's own cell is an input.
    const fee = cellOf(r.chargerLock, 100n * CKB);
    const charge = ccc.Transaction.from({
      inputs: [{ previousOutput: payIn.outPoint }, { previousOutput: fee.outPoint }],
      outputs: [{ lock: r.payToLock, capacity: 210n * CKB }, { lock, capacity: 173n * CKB }],
      outputsData: ["0x", "0x"],
    });
    const CHARGE = h("0d");
    const created = { recreate: RECREATE, read: READ, charge: CHARGE, opening: OPEN }[opts.liveCreatedBy ?? "opening"];
    const live = ccc.Cell.from({
      outPoint: { txHash: created, index: opts.liveCreatedBy === "charge" ? 1 : 0 },
      cellOutput: { lock, capacity: 173n * CKB },
      outputData: "0x",
    });
    const txs: Record<string, ccc.Transaction> = { [RECREATE]: recreate, [READ]: read, [CHARGE]: charge };
    const { client } = fakeClient([live, payIn, own, stranger, fee], 990n, (hash) => txs[hash] ?? opening);
    return { status: (account = "alice") => subscriptionStatus(client, d, r.sub, { openTx: OPEN, account }) };
  }

  it("is active through the opening's block plus one period, with the charges left", async () => {
    const { status } = await setup();
    expect(await status()).toEqual({
      ok: true,
      status: { paidThroughBlock: 990n + PERIOD, tip: 1000n, active: true, balance: 173n * CKB, chargesLeft: 2n, nextChargeIn: 10n },
    });
  });

  // Review, 27 Oct: one payment must not count as a paid read and a period at once.
  it("counts a cell created by another payment to payTo for nothing; a charge renews", async () => {
    expect(await (await setup({ liveCreatedBy: "read" })).status()).toMatchObject({
      ok: true,
      status: { paidThroughBlock: undefined, active: false },
    });
    expect(await (await setup({ liveCreatedBy: "charge" })).status()).toMatchObject({
      ok: true,
      status: { paidThroughBlock: 990n + PERIOD, active: true },
    });
  });

  it("refuses an account the opening did not commit to", async () => {
    const { status } = await setup();
    expect(await status("mallory")).toMatchObject({ ok: false, reason: expect.stringMatching(/account/) });
  });

  it("gives no paid period for a cell the subscriber re-created to reset its age (review H2)", async () => {
    const { status } = await setup({ liveCreatedBy: "recreate" });
    expect(await status()).toMatchObject({ ok: true, status: { paidThroughBlock: undefined, active: false } });
  });
});

// Token subscriptions (docs/design/subscriptions.md, "Token subscriptions"): the
// 160-byte layout with max_per_tx 0; price in token units, paid into payTo's
// anyone-can-pay cell of the token.
describe("token subscriptions", () => {
  const T = 1_000_000n; // token units
  const PRICE = 10n * T;
  const units = (v: bigint) => ccc.hexFrom(ccc.numLeToBytes(v, 16));
  const xudtOf = async (client: ccc.Client, args: string) =>
    ccc.Script.from({ ...(await client.getKnownScript(ccc.KnownScript.XUdt)), args });

  async function tokenRoles(client: ccc.Client) {
    const r = await roles(client);
    const token = await xudtOf(client, h("33"));
    const sub: Subscription = {
      ...r.sub,
      price: PRICE,
      token: { type: { codeHash: token.codeHash, hashType: token.hashType, args: token.args } },
    };
    const charger = (await r.charger.getRecommendedAddressObj()).toString();
    const subscriberLock = (await r.subscriber.getRecommendedAddressObj()).script;
    return { ...r, token, sub, chargerAddr: charger, subscriberLock };
  }
  type Roles = Awaited<ReturnType<typeof tokenRoles>>;
  const tokenCell = (lock: ccc.Script, token: ccc.Script, amount: bigint, capacity = 142n * CKB, data = units(amount)) =>
    cellOf(lock, capacity, { type: token }, data);

  describe("subscriptionLock", () => {
    it("is the 160-byte token layout: no CKB may leave, the price is max_per_tx_token", async () => {
      const { sub, token } = await tokenRoles(fakeClient([]).client);
      const args = ccc.bytesFrom(subscriptionLock(d, sub).args);
      expect(args.length).toBe(160);
      expect(ccc.hexFrom(args.slice(0, 32))).toBe(sub.subscriberLockHash);
      expect(ccc.hexFrom(args.slice(32, 64))).toBe(sub.chargerLockHash);
      expect(ccc.numLeFromBytes(args.slice(64, 72))).toBe(0n);
      expect(ccc.numLeFromBytes(args.slice(72, 80))).toBe(PERIOD);
      expect(ccc.hexFrom(args.slice(80, 112))).toBe(token.hash());
      expect(ccc.numLeFromBytes(args.slice(112, 128))).toBe(PRICE);
      expect(ccc.hexFrom(args.slice(128, 160))).toBe(sub.payToLockHash);
    });
  });

  describe("openSubscription", () => {
    async function open(o: { payTo?: string; tokenArgs?: string; cells?: (r: Roles) => ccc.Cell[] } = {}) {
      const r = await tokenRoles(fakeClient([]).client);
      const { client, sent } = fakeClient(o.cells?.(r) ?? []);
      const subscriber = new ccc.SignerCkbPrivateKey(client, keys.subscriber);
      const type = o.tokenArgs ? await xudtOf(client, o.tokenArgs) : r.token;
      const result = openSubscription(subscriber, d, {
        charger: r.chargerAddr,
        payTo: o.payTo ?? r.payTo,
        price: PRICE,
        periodBlocks: PERIOD,
        token: { type, amount: 30n * T },
        account: "alice",
      });
      return { result, sent, r };
    }

    it("refuses a payTo that is not anyone-can-pay (no CKB may leave to make a new token cell)", async () => {
      const plain = (await new ccc.SignerCkbPrivateKey(fakeClient([]).client, h("99")).getRecommendedAddressObj()).toString();
      await expect((await open({ payTo: plain })).result).rejects.toThrow(/anyone-can-pay/);
    });

    it("refuses an xUDT with flags", async () => {
      await expect((await open({ tokenArgs: h("33") + "01000000" })).result).rejects.toThrow(SessionPolicyError);
    });

    it("refuses a payTo that holds no cell of the token", async () => {
      await expect((await open({ cells: (r) => [cellOf(r.payToLock, 200n * CKB)] })).result).rejects.toThrow(/no cell of this token/);
    });

    it("still requires a budget for a CKB subscription", async () => {
      const r = await roles(fakeClient([]).client);
      const charger = (await r.charger.getRecommendedAddressObj()).toString();
      await expect(
        openSubscription(r.subscriber, d, { charger, payTo: r.payTo, price: 10n * CKB, periodBlocks: PERIOD }),
      ).rejects.toThrow(/budget is required/);
    });

    it("pays the first price in tokens into payTo's token cell, keeps the rest in the cell, and commits to the account", async () => {
      let own: ccc.Cell | undefined;
      let ownTokens: ccc.Cell | undefined;
      vi.spyOn(ccc.Transaction.prototype, "completeInputsByUdt").mockImplementation(async function (this: ccc.Transaction) {
        this.inputs.push(ccc.CellInput.from({ previousOutput: ownTokens!.outPoint }));
        return 1 as never;
      });
      vi.spyOn(ccc.Transaction.prototype, "completeInputsByCapacity").mockImplementation(async function (this: ccc.Transaction) {
        this.inputs.push(ccc.CellInput.from({ previousOutput: own!.outPoint }));
        return 1 as never;
      });
      vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
      const { result, sent, r } = await open({
        cells: (r) => {
          own = cellOf(r.subscriberLock, 1000n * CKB);
          ownTokens = tokenCell(r.subscriberLock, r.token, 100n * T);
          return [own, ownTokens, cellOf(r.payToLock, 200n * CKB), tokenCell(r.payToLock, r.token, 5n * T)];
        },
      });
      const { subscription } = await result;
      expect(subscription.token?.type).toEqual({ codeHash: r.token.codeHash, hashType: r.token.hashType, args: r.token.args });

      const tx = sent[0];
      expect(tx.outputs[0].lock.eq(subscriptionLock(d, r.sub))).toBe(true);
      expect(tx.outputs[0].type?.eq(r.token)).toBe(true);
      expect(tx.outputsData[0]).toBe(units(30n * T));
      expect(tx.outputs[0].capacity).toBe(282n * CKB); // its own size, no more
      // The payout's token cell: the same CKB, one price more.
      expect(tx.outputs[1].lock.eq(r.payToLock)).toBe(true);
      expect(tx.outputs[1].capacity).toBe(142n * CKB);
      expect(tx.outputsData[1]).toBe(units(15n * T));
      // Token change back to the subscriber: 100 - 30 - 10.
      expect(tx.outputs[2].lock.eq(r.subscriberLock)).toBe(true);
      expect(tx.outputsData[2]).toBe(units(60n * T));
      expect(tx.getWitnessArgsAt(1)?.inputType).toBe(subscriptionMemo("alice")); // the first input of the subscriber
    });
  });

  describe("chargeSubscription", () => {
    async function charge(subCells: (lock: ccc.Script, token: ccc.Script) => ccc.Cell[]) {
      vi.spyOn(ccc.Transaction.prototype, "completeFeeChangeToOutput").mockImplementation(async function (this: ccc.Transaction) {
        this.outputs[this.outputs.length - 1].capacity = 100n * CKB - 1000n; // the charger cell, minus a fee
        return [0, true] as never;
      });
      const r = await tokenRoles(fakeClient([]).client);
      const lock = subscriptionLock(d, r.sub);
      const payoutCell = tokenCell(r.payToLock, r.token, 5n * T);
      const { client, sent } = fakeClient([
        ...subCells(lock, r.token),
        cellOf(r.payToLock, 200n * CKB), // a plain CKB cell of payTo: not the one to top up
        payoutCell,
        cellOf(r.chargerLock, 100n * CKB),
      ]);
      const result = chargeSubscription(new ccc.SignerCkbPrivateKey(client, keys.charger), d, r.sub, { payTo: r.payTo });
      return { result, sent, r, lock, payoutCell };
    }

    it("takes exactly the price in tokens, keeps every shannon in the change, and tops up payTo's token cell", async () => {
      const { result, sent, r, lock, payoutCell } = await charge((lock, token) => [tokenCell(lock, token, 30n * T, 282n * CKB)]);
      await result;
      const tx = sent[0];
      expect(tx.inputs[0].since).toBe((1n << 63n) | PERIOD);
      expect(tx.inputs[1].previousOutput.eq(payoutCell.outPoint)).toBe(true);
      expect(tx.outputs[0].lock.eq(r.payToLock)).toBe(true);
      expect(tx.outputs[0].type?.eq(r.token)).toBe(true);
      expect(tx.outputs[0].capacity).toBe(142n * CKB);
      expect(tx.outputsData[0]).toBe(units(15n * T));
      expect(tx.outputs[1].lock.eq(lock)).toBe(true);
      expect(tx.outputs[1].type?.eq(r.token)).toBe(true);
      expect(tx.outputs[1].capacity).toBe(282n * CKB); // CKB outflow 0
      expect(tx.outputsData[1]).toBe(units(20n * T)); // exactly 16 bytes
      expect(tx.outputs[2].lock.eq(r.chargerLock)).toBe(true);
    });

    it("merges every mature token cell, and leaves out plain or foreign-typed cells under the lock", async () => {
      const { result, sent, lock } = await charge((lock, token) => [
        tokenCell(lock, token, 4n * T, 282n * CKB),
        tokenCell(lock, token, 8n * T, 300n * CKB, `${units(8n * T)}abcd`), // xUDT extension data: still the token
        cellOf(lock, 500n * CKB),
        cellOf(lock, 500n * CKB, { type: { codeHash: h("ee"), hashType: "type", args: "0x" } }, units(99n * T)),
      ]);
      await result;
      const tx = sent[0];
      expect(tx.inputs.filter((i) => i.since === ((1n << 63n) | PERIOD))).toHaveLength(2);
      const change = tx.outputs.findIndex((o) => o.lock.eq(lock));
      expect(tx.outputs[change].capacity).toBe(582n * CKB);
      expect(tx.outputsData[change]).toBe(units(2n * T));
    });

    // Review, 27 Oct: a planted cell of 2^128-1 free tokens would overflow xUDT's input sum and block every charge.
    it("leaves out a planted cell whose tokens would overflow the sum, and charges from the rest", async () => {
      const { result, sent, lock } = await charge((lock, token) => [
        tokenCell(lock, token, 30n * T, 282n * CKB),
        tokenCell(lock, token, (1n << 128n) - 1n, 142n * CKB),
      ]);
      await result;
      const tx = sent[0];
      expect(tx.inputs.filter((i) => i.since === ((1n << 63n) | PERIOD))).toHaveLength(1);
      const change = tx.outputs.findIndex((o) => o.lock.eq(lock));
      expect(tx.outputsData[change]).toBe(units(20n * T));
    });

    it("refuses once the cell holds less than a price in tokens", async () => {
      const { result } = await charge((lock, token) => [tokenCell(lock, token, PRICE - 1n, 282n * CKB)]);
      await expect(result).rejects.toThrow(SessionBalanceError);
    });
  });

  describe("verifySubscription", () => {
    /** A token subscription cell, created by a transaction that tops up payTo's token cell by `paid` units. */
    async function setup(
      o: {
        paid?: bigint;
        paidCkb?: bigint;
        memo?: ccc.Hex;
        extra?: (r: Roles) => ccc.CellOutputLike[];
        cell?: (lock: ccc.Script, token: ccc.Script) => ccc.Cell;
      } = {},
    ) {
      const r = await tokenRoles(fakeClient([]).client);
      const lock = subscriptionLock(d, r.sub);
      const cell = o.cell ? o.cell(lock, r.token) : tokenCell(lock, r.token, 30n * T, 282n * CKB);
      const payIn = tokenCell(r.payToLock, r.token, 5n * T);
      const own = cellOf(r.subscriberLock, 1000n * CKB);
      const extra = o.extra?.(r) ?? [];
      const creating = ccc.Transaction.from({
        inputs: [{ previousOutput: payIn.outPoint }, { previousOutput: own.outPoint }],
        outputs: [cell.cellOutput, { lock: r.payToLock, type: r.token, capacity: 142n * CKB + (o.paidCkb ?? 0n) }, ...extra],
        outputsData: [cell.outputData, units(5n * T + (o.paid ?? PRICE)), ...extra.map(() => units(0n))],
      });
      if (o.memo) creating.setWitnessArgsAt(1, { inputType: o.memo });
      const { client } = fakeClient([cell, payIn, own], 900n, creating);
      const expected = {
        charger: r.chargerAddr,
        payTo: r.payTo,
        price: PRICE,
        periodBlocks: PERIOD,
        token: r.token as ccc.ScriptLike | undefined,
      };
      return {
        check: (e: Partial<typeof expected & { account: string; minBalance: bigint }> = {}) =>
          verifySubscription(client, d, cell.outPoint, { ...expected, ...e }),
        r,
      };
    }

    it("accepts a token cell with exactly the terms, the first price paid in tokens", async () => {
      const { check, r } = await setup();
      expect(await check()).toEqual({
        ok: true,
        subscription: r.sub,
        balance: 282n * CKB,
        tokenBalance: 30n * T,
        chargesLeft: 3n,
        paidThroughBlock: 900n + PERIOD,
      });
    });

    it("refuses an opening that paid one unit short, or paid in CKB instead of tokens", async () => {
      expect(await (await setup({ paid: PRICE - 1n })).check()).toMatchObject({ ok: false, reason: expect.stringMatching(/did not pay/) });
      expect(await (await setup({ paid: 0n, paidCkb: PRICE })).check()).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/did not pay/),
      });
    });

    it("refuses one token price paid for two token subscriptions with the same payout address", async () => {
      const other = (r: Roles) => [{ lock: subscriptionLock(d, { ...r.sub, subscriberLockHash: h("e7") }), type: r.token, capacity: 282n * CKB }];
      expect(await (await setup({ extra: other })).check()).toMatchObject({ ok: false, reason: expect.stringMatching(/did not pay/) });
      expect(await (await setup({ extra: other, paid: 2n * PRICE })).check()).toMatchObject({ ok: true });
    });

    it("accepts the account the subscriber signed for, and refuses any other", async () => {
      const { check } = await setup({ memo: subscriptionMemo("alice") });
      expect(await check({ account: "alice" })).toMatchObject({ ok: true });
      expect(await check({ account: "mallory" })).toMatchObject({ ok: false, reason: expect.stringMatching(/account/) });
    });

    it("refuses a token cell when no token is expected, and a different token", async () => {
      const { check } = await setup();
      expect(await check({ token: undefined })).toMatchObject({ ok: false, reason: expect.stringMatching(/no type/) });
      const another = await xudtOf(fakeClient([]).client, h("34"));
      expect(await check({ token: another })).toMatchObject({ ok: false, reason: expect.stringMatching(/typed with the token/) });
    });

    it("refuses an untyped cell, or a 112-byte cell holding the token, when a token is expected", async () => {
      const { check } = await setup({ cell: (lock) => cellOf(lock, 500n * CKB) });
      expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/typed with the token/) });
      const r = await roles(fakeClient([]).client);
      const token = await xudtOf(fakeClient([]).client, h("33"));
      const typed = cellOf(subscriptionLock(d, r.sub), 500n * CKB, { type: token }, units(30n * T));
      const { client } = fakeClient([typed]);
      const charger = (await r.charger.getRecommendedAddressObj()).toString();
      expect(
        await verifySubscription(client, d, typed.outPoint, { charger, payTo: r.payTo, price: 10n * CKB, periodBlocks: PERIOD, token }),
      ).toMatchObject({ ok: false, reason: expect.stringMatching(/160 bytes/) });
    });

    it("refuses a 160-byte cell that lets CKB out (max_per_tx above 0)", async () => {
      const { check } = await setup({
        cell: (lock, token) => {
          const args = ccc.bytesFrom(lock.args);
          args.set(ccc.numLeToBytes(1n, 8), 64);
          return tokenCell(ccc.Script.from({ ...lock, args: ccc.hexFrom(args) }), token, 30n * T, 282n * CKB);
        },
      });
      expect(await check()).toMatchObject({ ok: false, reason: expect.stringMatching(/no CKB out/) });
    });

    it("compares minBalance in token units", async () => {
      const { check } = await setup();
      expect(await check({ minBalance: 30n * T })).toMatchObject({ ok: true });
      expect(await check({ minBalance: 30n * T + 1n })).toMatchObject({ ok: false, reason: expect.stringMatching(/minimum/) });
    });
  });

  describe("subscriptionStatus and cancelSubscription", () => {
    const OPEN = h("0a");
    async function setup() {
      const r = await tokenRoles(fakeClient([]).client);
      const lock = subscriptionLock(d, r.sub);
      const payIn = tokenCell(r.payToLock, r.token, 5n * T);
      const own = cellOf(r.subscriberLock, 1000n * CKB);
      const opening = ccc.Transaction.from({
        inputs: [{ previousOutput: payIn.outPoint }, { previousOutput: own.outPoint }],
        outputs: [
          { lock, type: r.token, capacity: 282n * CKB },
          { lock: r.payToLock, type: r.token, capacity: 142n * CKB },
        ],
        outputsData: [units(30n * T), units(15n * T)],
      });
      opening.setWitnessArgsAt(1, { inputType: subscriptionMemo("alice") });
      const live = ccc.Cell.from({ outPoint: { txHash: OPEN, index: 0 }, cellOutput: opening.outputs[0], outputData: units(30n * T) });
      const plainUnderLock = cellOf(lock, 500n * CKB); // plain CKB under the lock: a charger can leave the last change untyped
      const proof = cellOf(r.subscriberLock, 100n * CKB); // the plain cell a cancel spends to prove ownership
      const { client, sent } = fakeClient([live, plainUnderLock, payIn, own, proof], 990n, opening);
      return { client, sent, r, live, proof };
    }

    it("is active through the opening's block plus one period, counting token units", async () => {
      const { client, r } = await setup();
      expect(await subscriptionStatus(client, d, r.sub, { openTx: OPEN, account: "alice" })).toEqual({
        ok: true,
        status: {
          paidThroughBlock: 990n + PERIOD,
          tip: 1000n,
          active: true,
          balance: 282n * CKB,
          tokenBalance: 30n * T,
          chargesLeft: 3n,
          nextChargeIn: 10n,
        },
      });
    });

    // Review, 27 Oct: an untyped cell under the lock (a charger can make the last change one) is swept too.
    it("cancel sweeps the token cell back as tokens, and the untyped CKB under the lock with it", async () => {
      vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
      const { client, sent, r, live, proof } = await setup();
      const subscriber = new ccc.SignerCkbPrivateKey(client, keys.subscriber);
      vi.spyOn(subscriber, "findCells").mockImplementation(async function* () {
        yield proof;
      });
      expect(await cancelSubscription(subscriber, d, r.sub)).toMatchObject({ refunded: 782n * CKB, refundedTokens: 30n * T });
      const tx = sent[0];
      expect(tx.inputs[0].previousOutput.eq(live.outPoint)).toBe(true);
      expect(tx.inputs).toHaveLength(3); // the token cell, the untyped cell, the owner's proof
      expect(tx.outputs[0].lock.eq(r.subscriberLock)).toBe(true);
      expect(tx.outputs[0].type?.eq(r.token)).toBe(true);
      expect(tx.outputsData[0]).toBe(units(30n * T));
    });

    // Review, 28 Oct: which cells fit under u128 must not depend on indexer order.
    it("cancel keeps the subscriber's own cell when a planted overflow cell comes first", async () => {
      vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
      const r = await tokenRoles(fakeClient([]).client);
      const lock = subscriptionLock(d, r.sub);
      const own = cellOf(r.subscriberLock, 1000n * CKB);
      const stranger = cellOf(ccc.Script.from({ ...r.payToLock, args: "0x" + "66".repeat(20) }), 500n * CKB);
      const PLANT = h("0e");
      const planted = ccc.Cell.from({
        outPoint: { txHash: PLANT, index: 0 },
        cellOutput: { lock, type: r.token, capacity: 142n * CKB },
        outputData: units((1n << 128n) - 1n),
      });
      const live = ccc.Cell.from({
        outPoint: { txHash: OPEN, index: 0 },
        cellOutput: { lock, type: r.token, capacity: 282n * CKB },
        outputData: units(30n * T),
      });
      const proof = cellOf(r.subscriberLock, 100n * CKB);
      const creating = (hash: string) =>
        ccc.Transaction.from({ inputs: [{ previousOutput: (hash === PLANT ? stranger : own).outPoint }] });
      const { client, sent } = fakeClient([planted, live, own, stranger, proof], 990n, creating);
      const subscriber = new ccc.SignerCkbPrivateKey(client, keys.subscriber);
      vi.spyOn(subscriber, "findCells").mockImplementation(async function* () {
        yield proof;
      });
      expect(await cancelSubscription(subscriber, d, r.sub)).toMatchObject({ refundedTokens: 30n * T });
      const tx = sent[0];
      expect(tx.inputs.some((i) => i.previousOutput.eq(live.outPoint))).toBe(true);
      expect(tx.inputs.some((i) => i.previousOutput.eq(planted.outPoint))).toBe(false);
    });
  });
});
