/**
 * Regression tests for the hardening review of 24 Nov 2026
 * (liveness, recovery and how sessions are bound to wallets). Mocked chain as in
 * fund.test.ts: the CCC client, fee completion and signing are real; only its
 * RPC calls are replaced.
 */
import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexerFind } from "./fixtures/indexer.js";
import { TESTNET_DEPLOYMENT as d } from "../src/lock.js";
import {
  fundInSession,
  keyLockOf,
  SessionBalanceError,
  sessionLockOf,
  spendInSession,
  type OnChainBinding,
} from "../src/onchain.js";
import { createSession } from "../src/session.js";

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;
afterEach(() => vi.restoreAllMocks());

const cellOf = (txHash: ccc.Hex, index: number, out: ccc.CellOutputLike, data: ccc.HexLike = "0x") =>
  ccc.Cell.from({ outPoint: { txHash, index }, cellOutput: out, outputData: data });

async function setup(o: { maxPerTx: bigint; sessionCells: bigint[]; keyCells?: bigint[]; ownerKey?: ccc.Hex }) {
  const client = new ccc.ClientPublicTestnet();
  const owner = new ccc.SignerCkbPrivateKey(client, o.ownerKey ?? h("07"));
  const session = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: o.maxPerTx } });
  const live: ccc.Cell[] = [];
  const chain = { live, tip: 1000n };
  const c = client as unknown as Record<string, unknown>;
  c.findCellsPagedNoCache = async (k: ccc.ClientIndexerSearchKeyLike) => ({ cells: [...indexerFind(chain.live, k)], lastCursor: "0x" });
  c.getCell = async (op: ccc.OutPointLike) => chain.live.find((x) => x.outPoint.eq(ccc.OutPoint.from(op)))?.clone();
  c.getCellLiveNoCache = async (op: ccc.OutPointLike) => chain.live.find((x) => x.outPoint.eq(ccc.OutPoint.from(op)));
  c.getTipHeader = async () => ({ number: chain.tip });
  c.getTip = async () => chain.tip;
  c.getFeeRate = async () => 1000n;
  c.getTransactionNoCache = async () => undefined;
  const sent: ccc.Transaction[] = [];
  c.sendTransactionNoCache = async (tx: ccc.TransactionLike) => {
    const t = ccc.Transaction.from(tx);
    sent.push(t);
    return t.hash();
  };
  const ownerLock = (await owner.getRecommendedAddressObj()).script;
  const binding: OnChainBinding = {
    ownerLock: { codeHash: ownerLock.codeHash, hashType: ownerLock.hashType, args: ownerLock.args },
    minInterval: 0n,
  };
  const lock = await sessionLockOf(session, client, d, binding);
  const keyLock = await keyLockOf(session, client);
  live.push(...o.sessionCells.map((cap, i) => cellOf(h("a1"), i, { lock, capacity: cap })));
  live.push(...(o.keyCells ?? [100n * CKB]).map((cap, i) => cellOf(h("b1"), i, { lock: keyLock, capacity: cap })));
  return { client, owner, ownerLock, session, binding, lock, keyLock, chain, sent };
}

/** Capacity of the inputs of `tx` under `lock`, and of its outputs under it. */
async function flow(client: ccc.Client, tx: ccc.Transaction, lock: ccc.Script) {
  let inputs = 0n;
  for (const i of tx.inputs) {
    const cell = await client.getCell(i.previousOutput);
    if (cell?.cellOutput.lock.eq(lock)) inputs += cell.cellOutput.capacity;
  }
  const outputs = tx.outputs.filter((x) => x.lock.eq(lock));
  return { inputs, outputs };
}

describe("review 24 Nov, 1: spendInSession takes one more cell rather than leave a sliver of change", () => {
  it("pays 150 CKB from two 200 CKB session cells: both in, one 250 CKB change cell", async () => {
    const p = await setup({ maxPerTx: 200n * CKB, sessionCells: [200n * CKB, 200n * CKB] });
    const to = ccc.Address.fromScript(p.ownerLock, p.client).toString();
    await expect(spendInSession(p.session, p.client, d, p.binding, { to, amount: 150n * CKB })).resolves.toMatch(/^0x/);
    const { inputs, outputs } = await flow(p.client, p.sent[0], p.lock);
    expect(inputs).toBe(400n * CKB);
    expect(outputs.map((o) => o.capacity)).toEqual([250n * CKB]);
  });

  it("fundInSession funds the same 150 CKB need from the same cells (control)", async () => {
    const p = await setup({ maxPerTx: 200n * CKB, sessionCells: [200n * CKB, 200n * CKB] });
    const app = ccc.Transaction.from({ outputs: [{ lock: p.ownerLock, capacity: 150n * CKB }], outputsData: ["0x"] });
    const { outflow } = await fundInSession(p.session, p.client, d, p.binding, app);
    expect(outflow).toBe(150n * CKB);
  });

  it("a stranger's 130 CKB cell listed first does not block a 61 CKB payment from a 1000 CKB session cell", async () => {
    const p = await setup({ maxPerTx: 200n * CKB, sessionCells: [] });
    // Planted (older, so the indexer lists it first), then the owner's real session cell.
    p.chain.live.unshift(
      cellOf(h("f0"), 0, { lock: p.lock, capacity: 130n * CKB }),
      cellOf(h("a2"), 0, { lock: p.lock, capacity: 1000n * CKB }),
    );
    const to = ccc.Address.fromScript(p.ownerLock, p.client).toString();
    await expect(spendInSession(p.session, p.client, d, p.binding, { to, amount: 61n * CKB })).resolves.toMatch(/^0x/);
    const { inputs, outputs } = await flow(p.client, p.sent[0], p.lock);
    expect(inputs).toBe(1000n * CKB); // the largest cell alone
    expect(outputs.map((o) => o.capacity)).toEqual([939n * CKB]);
  });

  it("still refuses when every usable cell together would leave a sliver", async () => {
    const p = await setup({ maxPerTx: 300n * CKB, sessionCells: [200n * CKB] });
    const to = ccc.Address.fromScript(p.ownerLock, p.client).toString();
    const e = await spendInSession(p.session, p.client, d, p.binding, { to, amount: 150n * CKB }).catch((x) => x);
    expect(e).toBeInstanceOf(SessionBalanceError);
    expect(String(e)).toMatch(/would keep 50 CKB/);
    expect(p.sent).toHaveLength(0);
  });
});
