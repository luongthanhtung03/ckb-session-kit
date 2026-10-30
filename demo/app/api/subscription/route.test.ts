import { ccc } from "@ckb-ccc/core";
import { subscriptionLock, subscriptionMemo, type SessionLockDeployment } from "ckb-session-kit";
import { describe, expect, it, vi } from "vitest";
import deploymentJson from "../../../../deployment/testnet.json";
import { PAY_TO } from "../../subscribe/config";
import { termsFor } from "../../subscribe/terms";

// The route's client is module-level and its RPC methods are instance fields:
// hand out a client the test can reach, then patch that instance.
const made = vi.hoisted(() => ({ clients: [] as unknown[] }));
vi.mock("@ckb-ccc/core", async (original) => {
  const m = await original<typeof import("@ckb-ccc/core")>();
  class Reachable extends m.ccc.ClientPublicTestnet {
    constructor(...args: ConstructorParameters<typeof m.ccc.ClientPublicTestnet>) {
      super(...args);
      made.clients.push(this);
    }
  }
  return { ...m, ccc: { ...m.ccc, ClientPublicTestnet: Reachable } };
});
const { POST } = await import("./route");
const routeClient = made.clients[0] as Record<string, unknown>;

const CKB = 100_000_000n;
const deployment = deploymentJson as SessionLockDeployment;
const hash = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;

/**
 * Audit (30 Oct): a subscriber with a valid opening plants N extra cells under its
 * own subscription lock, all created by one transaction with 32 inputs. Every
 * POST /api/subscription then resolves each cell's creating transaction and its
 * 32 inputs again, with no cap and no de-duplication: about 33 RPC calls per
 * planted cell, per request, from an unauthenticated endpoint. The client is mocked.
 */
async function setup(planted: number) {
  const client = new ccc.ClientPublicTestnet();
  const subscriberLock = ccc.Script.from({ codeHash: hash("11"), hashType: "type", args: "0x" + "22".repeat(20) });
  const subscriber = subscriberLock.hash();
  const account = hash("33");
  const terms = await termsFor(client, subscriber, "ckb");
  const lock = subscriptionLock(deployment, terms);
  const payTo = (await ccc.Address.fromString(PAY_TO, client)).script;
  const attacker = ccc.Script.from({ codeHash: hash("44"), hashType: "type", args: "0x" + "55".repeat(20) });

  const openTx = ccc.Transaction.from({
    inputs: [{ previousOutput: { txHash: hash("01"), index: 0 } }],
    outputs: [
      { lock, capacity: 163n * CKB },
      { lock: payTo, capacity: 2n * CKB },
    ],
    outputsData: ["0x", "0x"],
  });
  openTx.setWitnessArgsAt(0, { inputType: subscriptionMemo(account) });
  const plantTx = ccc.Transaction.from({
    inputs: Array.from({ length: 32 }, (_, i) => ({ previousOutput: { txHash: hash("02"), index: i } })),
    outputs: Array.from({ length: planted }, () => ({ lock, capacity: 153n * CKB })),
    outputsData: Array.from({ length: planted }, () => "0x"),
  });
  const txs = new Map([
    [openTx.hash(), openTx],
    [plantTx.hash(), plantTx],
  ]);

  let calls = 0;
  routeClient.getTransaction = ((async (h: ccc.HexLike) => {
    calls++;
    const transaction = txs.get(ccc.hexFrom(h));
    return transaction && { transaction, status: "committed", blockNumber: 990n };
  }) as never);
  routeClient.getCell = ((async (op: ccc.OutPointLike) => {
    calls++;
    const o = ccc.OutPoint.from(op);
    const owner = o.txHash === hash("01") ? subscriberLock : attacker;
    return ccc.Cell.from({ outPoint: o, cellOutput: { lock: owner, capacity: 1000n * CKB }, outputData: "0x" });
  }) as never);
  routeClient.getTip = ((async () => (calls++, 1000n)) as never);
  routeClient.findCellsByLock = ((async function* () {
    calls++;
    yield ccc.Cell.from({ outPoint: { txHash: openTx.hash(), index: 0 }, cellOutput: openTx.outputs[0], outputData: "0x" });
    for (let i = 0; i < planted; i++) {
      yield ccc.Cell.from({ outPoint: { txHash: plantTx.hash(), index: i }, cellOutput: plantTx.outputs[i], outputData: "0x" });
    }
  }) as never);
  routeClient.findTransactionsByLock = ((async function* () {
    calls++;
  }) as never);

  const res = await POST(
    new Request("http://demo/api/subscription", {
      method: "POST",
      body: JSON.stringify({ subscriber, openTx: openTx.hash(), account, asset: "ckb" }),
    }),
  );
  return { status: res.status, calls };
}

describe("POST /api/subscription: RPC cost an outsider can trigger", () => {
  it("serves a plain paid-up subscription with a handful of RPC calls", async () => {
    const { status, calls } = await setup(0);
    expect(status).toBe(200);
    expect(calls).toBeLessThan(10);
  });

  // FAILS today: 100 planted cells cost 3,307 RPC calls per request (under 10 with none).
  it("bounds the RPC calls of one request however many cells sit under the lock", async () => {
    const { calls } = await setup(100);
    expect(calls).toBeLessThan(200);
  });
});
