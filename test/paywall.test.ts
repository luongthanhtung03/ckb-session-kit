import { ccc } from "@ckb-ccc/core";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/session.js";
import { paymentMemo, signAccess, verifyAccess, type AccessProof } from "../src/paywall.js";
import { MAX_MIN_CONFIRMATIONS } from "../src/confirmations.js";

const CKB = 100_000_000n;
const MEMO = paymentMemo("read:since");
const TX_HASH = ("0x" + "ab".repeat(32)) as ccc.Hex;
const newSession = () =>
  createSession({ expiresAt: new Date(Date.now() + 60_000), scope: { maxPerTx: 5n * CKB } });

/**
 * A payment as spendInSession builds it: session cell in, creator's cell in and
 * out (+amount), key cell in and out, the memo in the key cell's witness.
 */
async function setup(opts: { paid?: bigint; memo?: ccc.Hex; status?: string; payer?: ReturnType<typeof newSession> } = {}) {
  const client = new ccc.ClientPublicTestnet();
  const payer = opts.payer ?? newSession();
  const keyLock = (await new ccc.SignerCkbPrivateKey(client, payer.privateKey).getAddressObjSecp256k1()).script;
  const creator = ccc.Script.from({ codeHash: "0x" + "cc".repeat(32), hashType: "type", args: "0x01" });
  const session = ccc.Script.from({ codeHash: "0x" + "dd".repeat(32), hashType: "data2", args: "0x02" });

  const prev = (i: number) => ccc.OutPoint.from({ txHash: "0x" + "01".repeat(32), index: i });
  const inputs = [
    { lock: session, capacity: 200n * CKB },
    { lock: creator, capacity: 61n * CKB },
    { lock: keyLock, capacity: 100n * CKB },
  ];
  const tx = ccc.Transaction.from({
    inputs: inputs.map((_, i) => ({ previousOutput: prev(i) })),
    outputs: [
      { lock: creator, capacity: 61n * CKB + (opts.paid ?? 1n * CKB) },
      { lock: session, capacity: 199n * CKB },
      { lock: keyLock, capacity: 100n * CKB - 1000n },
    ],
    outputsData: ["0x", "0x", "0x"],
  });
  tx.setWitnessArgsAt(2, { inputType: opts.memo ?? MEMO, lock: "0x" + "00".repeat(65) });

  client.getTransactionNoCache = (async () => ({ transaction: tx, status: opts.status ?? "committed" })) as never;
  client.getCell = (async (op: ccc.OutPointLike) => {
    const i = Number(ccc.OutPoint.from(op).index);
    return ccc.Cell.from({ outPoint: prev(i), cellOutput: inputs[i], outputData: "0x" });
  }) as never;
  return { client, payer, creator };
}

describe("verifyAccess", () => {
  it("accepts a committed payment with the memo, claimed by the key that paid", async () => {
    const { client, payer, creator } = await setup();
    const proof = await signAccess(payer, TX_HASH, MEMO);
    expect(await verifyAccess(client, proof, { to: creator, minAmount: 1n * CKB, memo: MEMO })).toEqual({
      ok: true,
      paid: 1n * CKB,
    });
  });

  it("rejects a claim by anyone else, even with the real payment hash", async () => {
    const { client, creator } = await setup();
    const proof = await signAccess(newSession(), TX_HASH, MEMO);
    const r = await verifyAccess(client, proof, { to: creator, minAmount: 1n * CKB, memo: MEMO });
    expect(r).toEqual({ ok: false, reason: "the signing key did not pay this transaction" });
  });

  it("refuses a stranger's claim on a public payment after one input lookup", async () => {
    const { client, creator } = await setup();
    let lookups = 0;
    const getCell = client.getCell.bind(client);
    client.getCell = (async (op: ccc.OutPointLike) => (lookups++, getCell(op))) as never;
    const r = await verifyAccess(client, await signAccess(newSession(), TX_HASH, MEMO), { to: creator, minAmount: 1n * CKB, memo: MEMO });
    expect(r).toEqual({ ok: false, reason: "the signing key did not pay this transaction" });
    expect(lookups).toBe(1);
  });

  it("rejects a payment made for something else", async () => {
    const { client, payer, creator } = await setup({ memo: paymentMemo("read:other") });
    const proof = await signAccess(payer, TX_HASH, MEMO);
    const r = await verifyAccess(client, proof, { to: creator, minAmount: 1n * CKB, memo: MEMO });
    expect(r).toEqual({ ok: false, reason: "the payment does not carry this memo" });
  });

  it("rejects a proof for a different memo than the one asked for", async () => {
    const { client, payer, creator } = await setup();
    const proof = await signAccess(payer, TX_HASH, paymentMemo("read:other"));
    const r = await verifyAccess(client, proof, { to: creator, minAmount: 1n * CKB, memo: MEMO });
    expect(r).toEqual({ ok: false, reason: "memo does not match" });
  });

  it("rejects a tampered signature", async () => {
    const { client, payer, creator } = await setup();
    const proof = await signAccess(payer, TX_HASH, MEMO);
    const forged: AccessProof = { ...proof, txHash: ("0x" + "cd".repeat(32)) as ccc.Hex };
    const r = await verifyAccess(client, forged, { to: creator, minAmount: 1n * CKB, memo: MEMO });
    expect(r).toEqual({ ok: false, reason: "request not signed by the given key" });
  });

  it("rejects an underpayment", async () => {
    const { client, payer, creator } = await setup({ paid: 1n * CKB - 1n });
    const proof = await signAccess(payer, TX_HASH, MEMO);
    const r = await verifyAccess(client, proof, { to: creator, minAmount: 1n * CKB, memo: MEMO });
    expect(r.ok).toBe(false);
  });

  // Found in review: one 1 CKB top-up, several keys each with a memo in its own
  // witness. Every key "paid" (it has an input) and the creator gained 1 CKB, so
  // each claim used to pass: three articles, or three readers, for one payment.
  it("rejects a payment shared by several keys, each claiming the whole amount", async () => {
    const client = new ccc.ClientPublicTestnet();
    const creator = ccc.Script.from({ codeHash: "0x" + "cc".repeat(32), hashType: "type", args: "0x01" });
    const keys = [newSession(), newSession(), newSession()];
    const ids = ["occupied-capacity", "since", "delegation"];
    const keyLocks = await Promise.all(
      keys.map(async (k) => (await new ccc.SignerCkbPrivateKey(client, k.privateKey).getAddressObjSecp256k1()).script),
    );
    const prev = (i: number) => ccc.OutPoint.from({ txHash: "0x" + "01".repeat(32), index: i });
    const inputs = [{ lock: creator, capacity: 61n * CKB }, ...keyLocks.map((lock) => ({ lock, capacity: 100n * CKB }))];
    const tx = ccc.Transaction.from({
      inputs: inputs.map((_, i) => ({ previousOutput: prev(i) })),
      outputs: [
        { lock: creator, capacity: 62n * CKB },
        { lock: keyLocks[0], capacity: 99n * CKB - 1000n },
        { lock: keyLocks[1], capacity: 100n * CKB },
        { lock: keyLocks[2], capacity: 100n * CKB },
      ],
      outputsData: ["0x", "0x", "0x", "0x"],
    });
    ids.forEach((id, i) =>
      tx.setWitnessArgsAt(i + 1, { inputType: paymentMemo(`read:${id}`), lock: "0x" + "00".repeat(65) }),
    );
    client.getTransactionNoCache = (async () => ({ transaction: tx, status: "committed" })) as never;
    client.getCell = (async (op: ccc.OutPointLike) => {
      const i = Number(ccc.OutPoint.from(op).index);
      return ccc.Cell.from({ outPoint: prev(i), cellOutput: inputs[i], outputData: "0x" });
    }) as never;

    for (let i = 0; i < ids.length; i++) {
      const memo = paymentMemo(`read:${ids[i]}`);
      const r = await verifyAccess(client, await signAccess(keys[i], TX_HASH, memo), { to: creator, minAmount: 1n * CKB, memo });
      expect(r).toEqual({ ok: false, reason: "a payment must carry exactly one memo" });
    }
  });

  it("rejects a transaction too large to be a session payment, before resolving its inputs", async () => {
    const { client, payer, creator } = await setup();
    const { transaction } = (await client.getTransaction(TX_HASH))!;
    for (let i = 0; i < 20; i++) transaction.inputs.push(transaction.inputs[0]);
    let lookups = 0;
    const getCell = client.getCell.bind(client);
    client.getCell = (async (op: ccc.OutPointLike) => (lookups++, getCell(op))) as never;
    const r = await verifyAccess(client, await signAccess(payer, TX_HASH, MEMO), { to: creator, minAmount: 1n * CKB, memo: MEMO });
    expect(r).toEqual({ ok: false, reason: "not a session payment: too many inputs" });
    expect(lookups).toBe(0);
  });

  // Audit, 30 Oct 2026 (with session-lock.test.ts AUDIT-2). Input 0 is the session
  // cell: its witness is signed by nobody and read by no lock, so a relaying node can
  // set an inputType there; the tx hash and the key's signature are unchanged. If that
  // copy is the one committed, the payer has paid and the server refuses the claim
  // forever. Fixed: only memos in witnesses a signature covers count.
  it("AUDIT-2: a third party's unsigned memo at the session input does not void a real payment", async () => {
    const { client, payer, creator } = await setup();
    const { transaction } = (await client.getTransaction(TX_HASH))!;
    transaction.setWitnessArgsAt(0, { inputType: paymentMemo("griefed") });
    const proof = await signAccess(payer, TX_HASH, MEMO);
    const r = await verifyAccess(client, proof, { to: creator, minAmount: 1n * CKB, memo: MEMO });
    expect(r).toEqual({ ok: true, paid: 1n * CKB });
  });

  it("ignores an unsigned copy of the payer's own memo at the session input too", async () => {
    const { client, payer, creator } = await setup();
    const { transaction } = (await client.getTransaction(TX_HASH))!;
    transaction.setWitnessArgsAt(0, { inputType: MEMO });
    transaction.setWitnessArgsAt(1, { inputType: MEMO }); // the creator's anyone-can-pay cell: unsigned as well
    const r = await verifyAccess(client, await signAccess(payer, TX_HASH, MEMO), { to: creator, minAmount: 1n * CKB, memo: MEMO });
    expect(r).toEqual({ ok: true, paid: 1n * CKB });
  });

  it("still rejects a second memo in a witness every signature covers (past the inputs)", async () => {
    const { client, payer, creator } = await setup();
    const { transaction } = (await client.getTransaction(TX_HASH))!;
    transaction.setWitnessArgsAt(3, { inputType: paymentMemo("read:other") });
    const r = await verifyAccess(client, await signAccess(payer, TX_HASH, MEMO), { to: creator, minAmount: 1n * CKB, memo: MEMO });
    expect(r).toEqual({ ok: false, reason: "a payment must carry exactly one memo" });
  });

  it("rejects a payment that is not committed yet", async () => {
    const { client, payer, creator } = await setup({ status: "pending" });
    const proof = await signAccess(payer, TX_HASH, MEMO);
    const r = await verifyAccess(client, proof, { to: creator, minAmount: 1n * CKB, memo: MEMO });
    expect(r).toEqual({ ok: false, reason: "payment is pending, not committed" });
  });
});

describe("verifyAccess with a token price", () => {
  const xudt = (args: string) => ccc.Script.from({ codeHash: "0x" + "ee".repeat(32), hashType: "data1", args });
  const TOKEN = xudt("0x" + "aa".repeat(32));
  const units = (v: bigint) => ccc.hexFrom(ccc.numLeToBytes(v, 16));

  /** A token payment as spendInSession builds it with topUp: the creator's token cell gains `paid` units. */
  async function setupToken(paid: bigint, paidIn: ccc.Script = TOKEN) {
    const client = new ccc.ClientPublicTestnet();
    const payer = newSession();
    const keyLock = (await new ccc.SignerCkbPrivateKey(client, payer.privateKey).getAddressObjSecp256k1()).script;
    const creator = ccc.Script.from({ codeHash: "0x" + "cc".repeat(32), hashType: "type", args: "0x01" });
    const session = ccc.Script.from({ codeHash: "0x" + "dd".repeat(32), hashType: "data2", args: "0x02" });
    const prev = (i: number) => ccc.OutPoint.from({ txHash: "0x" + "01".repeat(32), index: i });
    const inputs = [
      { cellOutput: { lock: session, type: paidIn, capacity: 300n * CKB }, outputData: units(100n) },
      { cellOutput: { lock: creator, type: paidIn, capacity: 142n * CKB }, outputData: units(7n) },
      { cellOutput: { lock: keyLock, capacity: 100n * CKB }, outputData: "0x" },
    ];
    const tx = ccc.Transaction.from({
      inputs: inputs.map((_, i) => ({ previousOutput: prev(i) })),
      outputs: [
        { lock: creator, type: paidIn, capacity: 142n * CKB },
        { lock: session, type: paidIn, capacity: 300n * CKB },
        { lock: keyLock, capacity: 100n * CKB - 1000n },
      ],
      outputsData: [units(7n + paid), units(100n - paid), "0x"],
    });
    tx.setWitnessArgsAt(2, { inputType: MEMO, lock: "0x" + "00".repeat(65) });
    client.getTransactionNoCache = (async () => ({ transaction: tx, status: "committed" })) as never;
    client.getCell = (async (op: ccc.OutPointLike) => {
      const i = Number(ccc.OutPoint.from(op).index);
      return ccc.Cell.from({ outPoint: prev(i), ...inputs[i] });
    }) as never;
    return { client, proof: await signAccess(payer, TX_HASH, MEMO), creator };
  }

  it("accepts a payment of enough units of the token", async () => {
    const { client, proof, creator } = await setupToken(3n);
    expect(await verifyAccess(client, proof, { to: creator, minAmount: 3n, memo: MEMO, token: TOKEN })).toEqual({
      ok: true,
      paid: 3n,
    });
  });

  it("rejects too few units", async () => {
    const { client, proof, creator } = await setupToken(2n);
    const r = await verifyAccess(client, proof, { to: creator, minAmount: 3n, memo: MEMO, token: TOKEN });
    expect(r).toEqual({ ok: false, reason: "paid 2 units, below the price" });
  });

  it("counts only the token asked for, not one with the same code and other args", async () => {
    const { client, proof, creator } = await setupToken(50n, xudt("0x" + "bb".repeat(32)));
    const r = await verifyAccess(client, proof, { to: creator, minAmount: 3n, memo: MEMO, token: TOKEN });
    expect(r).toEqual({ ok: false, reason: "paid 0 units, below the price" });
  });

  it("does not count CKB toward a token price", async () => {
    const { client, payer, creator } = await setup({ paid: 1000n * CKB });
    const r = await verifyAccess(client, await signAccess(payer, TX_HASH, MEMO), { to: creator, minAmount: 1n, memo: MEMO, token: TOKEN });
    expect(r).toEqual({ ok: false, reason: "paid 0 units, below the price" });
  });

  it("does not count tokens toward a CKB price", async () => {
    const { client, proof, creator } = await setupToken(90n);
    const r = await verifyAccess(client, proof, { to: creator, minAmount: 1n * CKB, memo: MEMO });
    expect(r.ok).toBe(false);
  });
});

// Review #47 point 5: an optional confirmation depth. Confirmations = tip - block + 1.
describe("verifyAccess with minConfirmations", () => {
  const blockHash = (n: bigint) => ("0x" + n.toString(16).padStart(64, "0")) as ccc.Hex;

  /** The payment in block `block`, the tip at `tip`; `canonical` is the main chain's hash at a height. */
  async function deep(block: bigint, tip: bigint, opts: { paid?: bigint; canonical?: (n: bigint) => ccc.Hex | undefined } = {}) {
    const s = await setup({ paid: opts.paid });
    const res = await s.client.getTransactionNoCache(TX_HASH);
    const calls = { tip: 0, header: 0 };
    s.client.getTransactionNoCache = (async () => ({ ...res, blockNumber: block, blockHash: blockHash(block) })) as never;
    s.client.getTip = (async () => (calls.tip++, tip)) as never;
    s.client.getHeaderByNumberNoCache = (async (n: ccc.NumLike) => {
      calls.header++;
      const hash = (opts.canonical ?? blockHash)(ccc.numFrom(n));
      return hash && { hash, number: ccc.numFrom(n) };
    }) as never;
    const proof = await signAccess(s.payer, TX_HASH, MEMO);
    const check = (minConfirmations?: number | bigint) =>
      verifyAccess(s.client, proof, { to: s.creator, minAmount: 1n * CKB, memo: MEMO, minConfirmations });
    return { check, calls };
  }

  it("0 or unset is today's check: no tip read, no block needed", async () => {
    const { client, payer, creator } = await setup();
    client.getTip = (async () => {
      throw new Error("no tip read at depth 0");
    }) as never;
    const proof = await signAccess(payer, TX_HASH, MEMO);
    for (const minConfirmations of [undefined, 0, 0n]) {
      expect(await verifyAccess(client, proof, { to: creator, minAmount: 1n * CKB, memo: MEMO, minConfirmations })).toEqual({
        ok: true,
        paid: 1n * CKB,
      });
    }
  });

  it("counts the payment's own block as the first confirmation: exactly at the boundary passes", async () => {
    const { check, calls } = await deep(991n, 1000n); // 1000 - 991 + 1 = 10
    expect(await check(10)).toEqual({ ok: true, paid: 1n * CKB });
    expect(calls).toEqual({ tip: 1, header: 1 });
    expect(await (await deep(1000n, 1000n)).check(1)).toEqual({ ok: true, paid: 1n * CKB }); // in the tip block: 1
  });

  it("one below the boundary is unconfirmed, with how many it has, not unpaid", async () => {
    const { check, calls } = await deep(991n, 1000n);
    expect(await check(11)).toEqual({
      ok: false,
      code: "unconfirmed",
      reason: "payment has 10 of 11 confirmations",
      confirmations: 10n,
      minConfirmations: 11n,
    });
    expect(calls).toEqual({ tip: 1, header: 0 });
  });

  it("counts 0 confirmations when the tip read is behind the payment's block (a lagging node)", async () => {
    const { check } = await deep(1001n, 1000n);
    expect(await check(1)).toMatchObject({ ok: false, code: "unconfirmed", confirmations: 0n });
  });

  it("does not count a payment whose block is no longer on the main chain", async () => {
    const other = await deep(991n, 1000n, { canonical: () => ("0x" + "ee".repeat(32)) as ccc.Hex });
    expect(await other.check(5)).toEqual({ ok: false, code: "reorged", reason: "payment's block is no longer on the main chain" });
    const gone = await deep(991n, 1000n, { canonical: () => undefined });
    expect(await gone.check(5)).toMatchObject({ ok: false, code: "reorged" });
  });

  it("an invalid payment keeps its own reason, never 'unconfirmed'", async () => {
    const { check, calls } = await deep(1000n, 1000n, { paid: 1n * CKB - 1n });
    expect(await check(6)).toMatchObject({ ok: false, reason: expect.stringMatching(/below the price/) });
    expect(calls.tip).toBe(0);
  });

  it("is unconfirmed when the node gave no block for a committed payment", async () => {
    const { client, payer, creator } = await setup();
    client.getTip = (async () => 1000n) as never;
    const proof = await signAccess(payer, TX_HASH, MEMO);
    const r = await verifyAccess(client, proof, { to: creator, minAmount: 1n * CKB, memo: MEMO, minConfirmations: 1 });
    expect(r).toMatchObject({ ok: false, code: "unconfirmed", confirmations: 0n });
  });

  it.each([-1, 1.5, Number.NaN, Infinity, MAX_MIN_CONFIRMATIONS + 1, -1n, BigInt(MAX_MIN_CONFIRMATIONS) + 1n, "3", null])(
    "rejects minConfirmations %s before any RPC",
    async (bad) => {
      const { client, payer, creator } = await setup();
      let rpc = 0;
      client.getTransactionNoCache = (async () => (rpc++, undefined)) as never;
      const proof = await signAccess(payer, TX_HASH, MEMO);
      await expect(
        verifyAccess(client, proof, { to: creator, minAmount: 1n * CKB, memo: MEMO, minConfirmations: bad as never }),
      ).rejects.toThrow(RangeError);
      expect(rpc).toBe(0);
    },
  );

  it(`accepts the largest value, ${MAX_MIN_CONFIRMATIONS}, and bigints`, async () => {
    const { check } = await deep(1n, BigInt(MAX_MIN_CONFIRMATIONS));
    expect(await check(MAX_MIN_CONFIRMATIONS)).toEqual({ ok: true, paid: 1n * CKB });
    expect(await check(BigInt(MAX_MIN_CONFIRMATIONS))).toEqual({ ok: true, paid: 1n * CKB });
  });
});
