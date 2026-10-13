import { ccc } from "@ckb-ccc/core";
import { describe, expect, it } from "vitest";
import { createSession } from "../src/session.js";
import { paymentMemo, signAccess, verifyAccess, type AccessProof } from "../src/paywall.js";

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

  client.getTransaction = (async () => ({ transaction: tx, status: opts.status ?? "committed" })) as never;
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
    client.getTransaction = (async () => ({ transaction: tx, status: "committed" })) as never;
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

  it("rejects a payment that is not committed yet", async () => {
    const { client, payer, creator } = await setup({ status: "pending" });
    const proof = await signAccess(payer, TX_HASH, MEMO);
    const r = await verifyAccess(client, proof, { to: creator, minAmount: 1n * CKB, memo: MEMO });
    expect(r).toEqual({ ok: false, reason: "payment is pending, not committed" });
  });
});
