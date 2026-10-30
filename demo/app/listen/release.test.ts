import { ccc } from "@ckb-ccc/core";
import { createSession, paymentMemo, signAccess } from "ckb-session-kit";
import { describe, expect, it } from "vitest";
import { compose } from "./compose";
import { CREATOR, memoLabel, PRICE_PER_MINUTE } from "./config";
import { release } from "./release";

const CKB = 100_000_000n;
const TX_HASH = ("0x" + "ab".repeat(32)) as ccc.Hex;
const newSession = () => createSession({ expiresAt: new Date(Date.now() + 60_000), scope: { maxPerTx: 1n * CKB } });

/**
 * A minute's payment as the page sends it: session cell in, the creator's
 * anyone-can-pay cell in and out (+price), key cell in and out, the memo in the
 * key cell's witness. The client is mocked: no network.
 */
async function setup(opts: { label?: string; paid?: bigint; status?: string; to?: ccc.Script } = {}) {
  const client = new ccc.ClientPublicTestnet();
  const payer = newSession();
  const keyLock = (await new ccc.SignerCkbPrivateKey(client, payer.privateKey).getAddressObjSecp256k1()).script;
  const creator = opts.to ?? (await ccc.Address.fromString(CREATOR, client)).script;
  const session = ccc.Script.from({ codeHash: "0x" + "dd".repeat(32), hashType: "data2", args: "0x02" });
  const prev = (i: number) => ccc.OutPoint.from({ txHash: "0x" + "01".repeat(32), index: i });
  const inputs = [
    { lock: session, capacity: 168n * CKB },
    { lock: creator, capacity: 61n * CKB },
    { lock: keyLock, capacity: 62n * CKB },
  ];
  const paid = opts.paid ?? PRICE_PER_MINUTE;
  const tx = ccc.Transaction.from({
    inputs: inputs.map((_, i) => ({ previousOutput: prev(i) })),
    outputs: [
      { lock: creator, capacity: 61n * CKB + paid },
      { lock: session, capacity: 168n * CKB - paid },
      { lock: keyLock, capacity: 62n * CKB - 1000n },
    ],
    outputsData: ["0x", "0x", "0x"],
  });
  tx.setWitnessArgsAt(2, { inputType: paymentMemo(opts.label ?? memoLabel("tide", 3)), lock: "0x" + "00".repeat(65) });

  let calls = 0;
  client.getTransactionNoCache = (async () => (calls++, { transaction: tx, status: opts.status ?? "committed" })) as never;
  client.getCell = (async (op: ccc.OutPointLike) => {
    calls++;
    const i = Number(ccc.OutPoint.from(op).index);
    return ccc.Cell.from({ outPoint: prev(i), cellOutput: inputs[i], outputData: "0x" });
  }) as never;
  /** A claim for `track`/`minute`, signed by `key` (the payer unless given). */
  const claim = async (track: string, minute: number, key = payer) => ({
    track,
    minute,
    proof: await signAccess(key, TX_HASH, paymentMemo(memoLabel(track, minute))),
  });
  return { client, claim, calls: () => calls };
}

describe("the segment route's gating", () => {
  it("releases the minute that was paid for, to the key that paid", async () => {
    const { client, claim } = await setup();
    const r = await release(client, await claim("tide", 3));
    expect(r).toEqual({ status: 200, body: { segment: compose("tide", 3) } });
  });

  it("does not release the next minute for the same payment", async () => {
    const { client, claim } = await setup();
    const r = await release(client, await claim("tide", 4));
    expect(r).toEqual({ status: 402, body: { error: "the payment does not carry this memo" } });
  });

  it("does not release the same minute of another track", async () => {
    const { client, claim } = await setup();
    const r = await release(client, await claim("lantern", 3));
    expect(r).toEqual({ status: 402, body: { error: "the payment does not carry this memo" } });
  });

  it("does not release a minute to another key holding the real payment hash", async () => {
    const { client, claim } = await setup();
    const r = await release(client, await claim("tide", 3, newSession()));
    expect(r).toEqual({ status: 402, body: { error: "the signing key did not pay this transaction" } });
  });

  it("asks for the price: one shannon less is refused", async () => {
    const { client, claim } = await setup({ paid: PRICE_PER_MINUTE - 1n });
    const r = await release(client, await claim("tide", 3));
    expect(r.status).toBe(402);
  });

  it("refuses a payment to someone other than the creator", async () => {
    const other = ccc.Script.from({ codeHash: "0x" + "cc".repeat(32), hashType: "type", args: "0x01" });
    const { client, claim } = await setup({ to: other });
    const r = await release(client, await claim("tide", 3));
    expect(r.status).toBe(402);
  });

  it("waits for the payment to commit", async () => {
    const { client, claim } = await setup({ status: "pending" });
    const r = await release(client, await claim("tide", 3));
    expect(r).toEqual({ status: 402, body: { error: "payment is pending, not committed" } });
  });

  it("answers 404 for a track or minute that does not exist, without asking the chain", async () => {
    const { client, claim, calls } = await setup();
    const { proof } = await claim("tide", 3);
    for (const [track, minute] of [
      ["nope", 3],
      ["tide", 30],
      ["tide", -1],
      ["tide", 1.5],
      ["tide", "3"],
      ["hasOwnProperty", 0],
      [undefined, 0],
    ] as const) {
      expect((await release(client, { track, minute, proof })).status).toBe(404);
    }
    expect(calls()).toBe(0);
  });

  it("answers 400 for a missing or malformed proof", async () => {
    const { client, claim } = await setup();
    expect(await release(client, null)).toEqual({ status: 400, body: { error: "bad request" } });
    expect(await release(client, { track: "tide", minute: 3 })).toEqual({ status: 400, body: { error: "malformed proof" } });
    expect(await release(client, { track: "tide", minute: 3, proof: { memo: 7 } })).toEqual({
      status: 400,
      body: { error: "malformed proof" },
    });
    const { proof } = await claim("tide", 3);
    expect((await release(client, { track: "tide", minute: 3, proof: { ...proof, signature: "0x12" } })).status).toBe(400);
  });

  it("answers 503 with retry, not 400, when the chain cannot be reached", async () => {
    const { client, claim } = await setup();
    client.getTransactionNoCache = (async () => {
      throw new Error("request timed out");
    }) as never;
    const r = await release(client, await claim("tide", 3));
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ retry: true });
  });
});

describe("compose", () => {
  it("gives the same score every time, and different minutes differ", () => {
    expect(compose("quarry", 7)).toEqual(compose("quarry", 7));
    expect(compose("quarry", 7)).not.toEqual(compose("quarry", 8));
    const s = compose("lantern", 0)!;
    expect(s.notes.every((n) => n.t >= 0 && n.t < 60 && n.d > 0 && n.v > 0 && n.v <= 1)).toBe(true);
  });
});
