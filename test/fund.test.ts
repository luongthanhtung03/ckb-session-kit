/**
 * Funding an app-built transaction from a session (`fundInSession`,
 * `sendWithSession`), for a CrowdCell pledge (CKBuilder-projects#6). The app's
 * transaction here has the pledge's shape: a campaign cell in and carried
 * forward, a pledge cell under another lock, a receipt under the wallet's lock,
 * both typed. Mocked chain: the CCC client, fee completion and signing are
 * real; only its RPC calls are replaced. The same shape runs in the real CKB-VM
 * in test/fund-pledge-vm.test.ts.
 */
import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTNET_DEPLOYMENT as d, sessionLockCellDep } from "../src/lock.js";
import {
  DEFAULT_FUND_FEE_RATE,
  deadInputs,
  fundInSession,
  keyLockOf,
  poolConflict,
  SessionBalanceError,
  sessionLockOf,
  sendWithSession,
  type OnChainBinding,
} from "../src/onchain.js";
import { createSession, SessionPolicyError } from "../src/session.js";
import { ScopeError } from "../src/transfer.js";

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;
const opKey = (op: ccc.OutPointLike) => ccc.hexFrom(ccc.OutPoint.from(op).toBytes());
const deadText = (op: ccc.OutPointLike) => `TransactionFailedToResolve: Resolve failed Dead(OutPoint(${opKey(op)}))`;

afterEach(() => {
  vi.restoreAllMocks();
});

const PLEDGE = 100n * CKB;
const PLEDGE_OVERHEAD = 252n * CKB;
const RECEIPT = 262n * CKB;
/** What one pledge takes out of the session: the amount plus the two cells' storage. */
const PER_PLEDGE = PLEDGE + PLEDGE_OVERHEAD + RECEIPT;

const cellOf = (txHash: ccc.Hex, index: number, out: ccc.CellOutputLike, data: ccc.HexLike = "0x") =>
  ccc.Cell.from({ outPoint: { txHash, index }, cellOutput: out, outputData: data });

interface Setup {
  maxPerTx?: bigint;
  sessionCells?: bigint[];
  keyCells?: bigint[];
  minInterval?: bigint;
  recipient?: boolean;
}

async function setup(o: Setup = {}) {
  const client = new ccc.ClientPublicTestnet();
  const s = await client.getKnownScript(ccc.KnownScript.Secp256k1Blake160);
  const ownerLock = ccc.Script.from({ codeHash: s.codeHash, hashType: s.hashType, args: "0x" + "11".repeat(20) });
  const session = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: o.maxPerTx ?? PER_PLEDGE } });
  const binding: OnChainBinding = {
    ownerLock: { codeHash: ownerLock.codeHash, hashType: ownerLock.hashType, args: ownerLock.args },
    minInterval: o.minInterval ?? 0n,
    ...(o.recipient && { recipientLockHash: h("33") }),
  };
  const lock = await sessionLockOf(session, client, d, binding);
  const keyLock = await keyLockOf(session, client);

  // Stand-ins for CrowdCell's scripts: any code hash will do off-chain.
  const script = (b: string, args = "0x") => ccc.Script.from({ codeHash: h(b), hashType: "data2", args });
  const campaignLock = script("c1", "0x2c01000000000000");
  const campaignType = script("c2", h("c3") + h("c4").slice(2));
  const campaign = cellOf(h("ca"), 0, { lock: campaignLock, type: campaignType, capacity: 300n * CKB }, "0x" + "00".repeat(65));

  const live: ccc.Cell[] = [
    ...(o.sessionCells ?? [1000n * CKB]).map((cap, i) => cellOf(h("a1"), i, { lock, capacity: cap })),
    ...(o.keyCells ?? [100n * CKB]).map((cap, i) => cellOf(h("b1"), i, { lock: keyLock, capacity: cap })),
  ];
  const known: ccc.Cell[] = [campaign, ...live];
  const chain = { live, known, tip: 1000n, born: new Map<string, bigint>() };

  const c = client as unknown as Record<string, unknown>;
  c.findCellsPagedNoCache = async (k: ccc.ClientIndexerSearchKeyLike) => {
    const key = ccc.ClientIndexerSearchKey.from(k);
    return { cells: chain.live.filter((x) => x.cellOutput.lock.eq(key.script)), lastCursor: "0x" };
  };
  c.getCell = async (op: ccc.OutPointLike) => chain.known.find((x) => x.outPoint.eq(ccc.OutPoint.from(op)))?.clone();
  c.getCellLiveNoCache = async (op: ccc.OutPointLike) => chain.live.find((x) => x.outPoint.eq(ccc.OutPoint.from(op)));
  c.getTipHeader = async () => ({ number: chain.tip });
  c.getTip = async () => chain.tip;
  c.getTransactionNoCache = async (hash: ccc.HexLike) => {
    const born = chain.born.get(ccc.hexFrom(hash));
    return born === undefined ? undefined : ccc.ClientTransactionResponse.from({ transaction: {}, status: "committed", blockNumber: born });
  };
  const sent: ccc.Transaction[] = [];
  const node = { reply: (t: ccc.Transaction): ccc.Hex => t.hash() };
  c.sendTransactionNoCache = async (tx: ccc.TransactionLike) => {
    const t = ccc.Transaction.from(tx);
    sent.push(t);
    return node.reply(t);
  };
  const signed = vi.spyOn(ccc.SignerCkbPrivateKey.prototype, "signTransaction");
  const feeCalls = vi.spyOn(ccc.Transaction.prototype, "completeFeeChangeToOutput");

  /** The pledge transaction CrowdCell builds (page.tsx:310-398), before the wallet funds it. */
  const pledgeTx = (on: ccc.Cell = campaign) =>
    ccc.Transaction.from({
      inputs: [{ previousOutput: on.outPoint }],
      outputs: [
        { lock: campaignLock, type: campaignType, capacity: on.cellOutput.capacity },
        { lock: script("d1", "0x" + "ab".repeat(72)), type: script("d2", h("d3")), capacity: PLEDGE + PLEDGE_OVERHEAD },
        { lock: ownerLock, type: script("d3", h("d2")), capacity: RECEIPT },
      ],
      outputsData: ["0x" + "00".repeat(65), "0x" + "00".repeat(72), "0x" + "00".repeat(80)],
      cellDeps: ["e1", "e2", "e3", "e4", "e5"].map((b) => ({ outPoint: { txHash: h(b), index: 0 }, depType: "code" })),
      witnesses: ["0x"],
    });
  return { client, chain, session, binding, lock, keyLock, ownerLock, campaign, campaignLock, campaignType, pledgeTx, sent, node, signed, feeCalls };
}

const sum = (cs: { capacity: bigint }[]) => cs.reduce((s, c) => s + c.capacity, 0n);

describe("fundInSession: a pledge-shaped transaction", () => {
  it("adds session cells, one change cell and the key cell; keeps the app's input, witness and cell deps", async () => {
    const p = await setup();
    const app = p.pledgeTx();
    const { tx, outflow, sessionInputs } = await fundInSession(p.session, p.client, d, p.binding, app);

    // The app's own parts, where they were.
    expect(tx.inputs[0].previousOutput.eq(p.campaign.outPoint)).toBe(true);
    expect(tx.witnesses[0]).toBe("0x");
    for (let i = 0; i < 3; i++) expect(tx.outputs[i].eq(app.outputs[i])).toBe(true);
    for (const dep of app.cellDeps) expect(tx.cellDeps.some((x) => x.eq(dep))).toBe(true);
    expect(tx.cellDeps.some((x) => x.eq(ccc.CellDep.from(sessionLockCellDep(d))))).toBe(true);
    // The app's tx itself is untouched.
    expect(app.inputs).toHaveLength(1);

    // Session cell, then key cell; change under the session lock; key cell last.
    expect(tx.inputs).toHaveLength(3);
    expect(sessionInputs.map(opKey)).toEqual(tx.inputs.slice(1).map((i) => opKey(i.previousOutput)));
    expect(tx.outputs[3].lock.eq(p.lock)).toBe(true);
    expect(tx.outputs[3].capacity).toBe(1000n * CKB - PER_PLEDGE);
    expect(tx.outputs[4].lock.eq(p.keyLock)).toBe(true);

    // outflow as the lock computes it: session inputs less change. The fee is not in it.
    expect(outflow).toBe(PER_PLEDGE);
    expect(outflow).toBe(1000n * CKB - tx.outputs[3].capacity);
    const fee = (await tx.getInputsCapacity(p.client)) - tx.getOutputsCapacity();
    expect(fee).toBeGreaterThan(0n);
    expect(tx.outputs[4].capacity).toBe(100n * CKB - fee); // the key cell paid it
    // At the default rate: 2000 shannons per 1000 bytes of the signed transaction.
    expect(p.feeCalls.mock.calls[0][2]).toBe(DEFAULT_FUND_FEE_RATE);
    expect(p.signed).not.toHaveBeenCalled();
  });

  it("accepts an outflow of exactly maxPerTx and spends the whole session when that is what it holds", async () => {
    const p = await setup({ sessionCells: [PER_PLEDGE] });
    const { tx, outflow } = await fundInSession(p.session, p.client, d, p.binding, p.pledgeTx());
    expect(outflow).toBe(PER_PLEDGE);
    expect(tx.outputs.filter((o) => o.lock.eq(p.lock))).toHaveLength(0); // no change at all
  });

  it("refuses an outflow over maxPerTx before anything is signed", async () => {
    const p = await setup({ maxPerTx: PER_PLEDGE - 1n });
    await expect(fundInSession(p.session, p.client, d, p.binding, p.pledgeTx())).rejects.toThrow(ScopeError);
    await expect(fundInSession(p.session, p.client, d, p.binding, p.pledgeTx())).rejects.toThrow(/over maxPerTx/);
    await expect(sendWithSession(p.session, p.client, d, p.binding, async () => p.pledgeTx())).rejects.toThrow(ScopeError);
    expect(p.signed).not.toHaveBeenCalled();
    expect(p.sent).toHaveLength(0);
  });

  it("refuses a session with an on-chain recipient, with a reason, before anything is signed", async () => {
    const p = await setup({ recipient: true });
    const e = await fundInSession(p.session, p.client, d, p.binding, p.pledgeTx()).catch((x) => x);
    expect(e).toBeInstanceOf(SessionPolicyError);
    expect(e.reason).toBe("session-has-recipient");
    expect(e.message).toMatch(/needs a session without a recipient/);
    await expect(sendWithSession(p.session, p.client, d, p.binding, async () => p.pledgeTx())).rejects.toThrow(SessionPolicyError);
    expect(p.signed).not.toHaveBeenCalled();
  });

  it("refuses an input under the owner's lock: it would switch the lock to owner mode", async () => {
    const p = await setup();
    const walletCell = cellOf(h("f1"), 0, { lock: p.ownerLock, capacity: 500n * CKB });
    p.chain.known.push(walletCell);
    const app = p.pledgeTx();
    app.inputs.push(ccc.CellInput.from({ previousOutput: walletCell.outPoint }));
    const e = await fundInSession(p.session, p.client, d, p.binding, app).catch((x) => x);
    expect(e).toBeInstanceOf(SessionPolicyError);
    expect(e.reason).toBe("owner-lock-input");
    expect(e.message).toMatch(/owner mode/);
    expect(p.signed).not.toHaveBeenCalled();
  });

  it("refuses session or key cells the app put in itself", async () => {
    const p = await setup();
    const withSessionInput = p.pledgeTx();
    withSessionInput.inputs.push(ccc.CellInput.from({ previousOutput: p.chain.live[0].outPoint }));
    await expect(fundInSession(p.session, p.client, d, p.binding, withSessionInput)).rejects.toMatchObject({ reason: "app-tx-shape" });
    const withSessionOutput = p.pledgeTx();
    withSessionOutput.addOutput({ lock: p.lock, capacity: 200n * CKB });
    await expect(fundInSession(p.session, p.client, d, p.binding, withSessionOutput)).rejects.toMatchObject({ reason: "app-tx-shape" });
  });

  it("refuses an expired session", async () => {
    const p = await setup();
    const later = new Date(Date.now() + 7_200_000);
    await expect(fundInSession(p.session, p.client, d, p.binding, p.pledgeTx(), { now: later })).rejects.toThrow(/session expired/);
  });

  it("takes another cell rather than leave change below a session cell's size, and refuses when none is left", async () => {
    // 650 CKB leaves 36 CKB of change: too small. A second cell makes it whole.
    const p = await setup({ sessionCells: [650n * CKB, 200n * CKB] });
    const { tx, outflow } = await fundInSession(p.session, p.client, d, p.binding, p.pledgeTx());
    expect(tx.inputs).toHaveLength(4);
    expect(outflow).toBe(PER_PLEDGE);
    expect(tx.outputs[3].capacity).toBe(850n * CKB - PER_PLEDGE);

    const q = await setup({ sessionCells: [650n * CKB] });
    await expect(fundInSession(q.session, q.client, d, q.binding, q.pledgeTx())).rejects.toThrow(/below the 121 CKB a session cell needs/);
  });

  it("refuses when the session is too small, or the key cell cannot pay the fee", async () => {
    const p = await setup({ sessionCells: [300n * CKB] });
    await expect(fundInSession(p.session, p.client, d, p.binding, p.pledgeTx())).rejects.toThrow(SessionBalanceError);
    const q = await setup({ keyCells: [61n * CKB] });
    await expect(fundInSession(q.session, q.client, d, q.binding, q.pledgeTx())).rejects.toMatchObject({ reason: "no-fee-cell" });
  });

  it("runs the app's check last, and nothing is signed when it refuses", async () => {
    const p = await setup();
    const seen: number[] = [];
    const check = (tx: ccc.Transaction) => {
      seen.push(tx.outputs.length);
      throw new Error("pledge output 1 is not under the pledge lock");
    };
    await expect(sendWithSession(p.session, p.client, d, p.binding, async () => p.pledgeTx(), { check })).rejects.toThrow(/pledge lock/);
    expect(seen).toEqual([5]); // it saw the finished transaction
    expect(p.signed).not.toHaveBeenCalled();
    expect(p.sent).toHaveLength(0);
  });

  it("with a rate limit: mature session cells only, `since` on them and not on the app's input", async () => {
    const p = await setup({ minInterval: 10n, sessionCells: [1000n * CKB] });
    p.chain.born.set(h("a1"), 995n); // 5 blocks old
    await expect(fundInSession(p.session, p.client, d, p.binding, p.pledgeTx())).rejects.toThrow(/rate limited/);
    p.chain.born.set(h("a1"), 900n);
    const { tx } = await fundInSession(p.session, p.client, d, p.binding, p.pledgeTx());
    expect(tx.inputs[0].since).toBe(0n);
    expect(tx.inputs[1].since).toBe((1n << 63n) | 10n);
    expect(tx.inputs[2].since).toBe(0n); // the key cell
  });

  it("signs only the key cell's input: the campaign input needs no signature and keeps witness 0x", async () => {
    const p = await setup();
    const hash = await sendWithSession(p.session, p.client, d, p.binding, async () => p.pledgeTx());
    expect(p.sent).toHaveLength(1);
    const tx = p.sent[0];
    expect(hash).toBe(tx.hash());
    expect(tx.witnesses[0]).toBe("0x");
    expect(tx.witnesses[1] ?? "0x").toBe("0x"); // the session cell: the lock checks no signature
    const keyWitness = tx.getWitnessArgsAt(2);
    expect(keyWitness?.lock && ccc.bytesFrom(keyWitness.lock).length).toBe(65);
  });
});

describe("sendWithSession: refusals for a spent cell", () => {
  it("retries when the dead cell is one of the session's own, without it, at the same fee rate", async () => {
    const p = await setup({ sessionCells: [1000n * CKB, 1000n * CKB] });
    let first: ccc.OutPoint | undefined;
    p.node.reply = (t) => {
      if (!first) {
        first = t.inputs[1].previousOutput; // another tab spent this session cell
        throw new Error(deadText(first));
      }
      return t.hash();
    };
    let builds = 0;
    const hash = await sendWithSession(p.session, p.client, d, p.binding, async () => (builds++, p.pledgeTx()), {
      retry: { delayMs: 0 },
    });
    expect(builds).toBe(2);
    expect(p.sent).toHaveLength(2);
    expect(hash).toBe(p.sent[1].hash());
    expect(p.sent[1].inputs.some((i) => i.previousOutput.eq(first!))).toBe(false);
    // Never a higher fee rate on the retry.
    expect(p.feeCalls.mock.calls.map((c) => c[2])).toEqual([DEFAULT_FUND_FEE_RATE, DEFAULT_FUND_FEE_RATE]);
    const rate = async (t: ccc.Transaction) => ((await t.getInputsCapacity(p.client)) - t.getOutputsCapacity()) * 1000n / BigInt(t.toBytes().length + 4);
    expect(await rate(p.sent[1])).toBeLessThanOrEqual(await rate(p.sent[0]) + 50n);
  });

  it("keeps a caller's fee rate on every attempt", async () => {
    const p = await setup({ sessionCells: [1000n * CKB, 1000n * CKB] });
    let n = 0;
    p.node.reply = (t) => {
      if (n++ === 0) throw new Error(deadText(t.inputs[1].previousOutput));
      return t.hash();
    };
    await sendWithSession(p.session, p.client, d, p.binding, async () => p.pledgeTx(), { feeRate: 1500n, retry: { delayMs: 0 } });
    expect(p.feeCalls.mock.calls.map((c) => c[2])).toEqual([1500n, 1500n]);
  });

  it("retries when the dead cell is the key cell", async () => {
    const p = await setup({ keyCells: [100n * CKB, 90n * CKB] });
    let n = 0;
    p.node.reply = (t) => {
      if (n++ === 0) throw new Error(deadText(t.inputs[t.inputs.length - 1].previousOutput));
      return t.hash();
    };
    await sendWithSession(p.session, p.client, d, p.binding, async () => p.pledgeTx(), { retry: { delayMs: 0 } });
    expect(p.sent).toHaveLength(2);
    expect(p.sent[1].inputs[p.sent[1].inputs.length - 1].previousOutput.index).toBe(1n);
  });

  it("rethrows a dead campaign cell (a lost race) unchanged, without a retry, for the app's loop", async () => {
    const p = await setup();
    const refusal = new Error(deadText(p.campaign.outPoint));
    p.node.reply = () => {
      throw refusal;
    };
    let builds = 0;
    const e = await sendWithSession(p.session, p.client, d, p.binding, async () => (builds++, p.pledgeTx()), {
      retry: { delayMs: 0 },
    }).catch((x) => x);
    expect(e).toBe(refusal);
    expect(deadInputs(e)).toBe(true); // what the app tests to wait for the campaign cell to move
    expect(builds).toBe(1);
    expect(p.sent).toHaveLength(1);
  });

  it("rethrows an RBF refusal (it names no cell) without a retry", async () => {
    const p = await setup();
    const rbf = new ccc.ErrorClientRBFRejected(
      { message: "PoolRejectedRBF", code: -1111, data: 'RBFRejected("Tx\'s current fee is 1000, expect it to >= 2000 to replace old txs")' },
      1000n,
      2000n,
    );
    p.node.reply = () => {
      throw rbf;
    };
    const e = await sendWithSession(p.session, p.client, d, p.binding, async () => p.pledgeTx(), { retry: { delayMs: 0 } }).catch((x) => x);
    expect(e).toBe(rbf);
    expect(poolConflict(e)).toBe(true);
    expect(p.sent).toHaveLength(1);
  });

  it("gives up on its own cells after retry.attempts", async () => {
    const p = await setup({ sessionCells: [1000n * CKB, 1000n * CKB, 1000n * CKB] });
    p.node.reply = (t) => {
      throw new Error(deadText(t.inputs[1].previousOutput));
    };
    await expect(
      sendWithSession(p.session, p.client, d, p.binding, async () => p.pledgeTx(), { retry: { attempts: 2, delayMs: 0 } }),
    ).rejects.toThrow(/Dead/);
    expect(p.sent).toHaveLength(2);
  });

  it("two pledges in a row: the second builds on the first's pending change", async () => {
    const p = await setup({ sessionCells: [2n * PER_PLEDGE + 121n * CKB] });
    // The first pledge's outputs are pending: CCC's cache lists them, and the node says pending.
    const first = await sendWithSession(p.session, p.client, d, p.binding, async () => p.pledgeTx());
    const firstTx = p.sent[0];
    const c = p.client as unknown as Record<string, unknown>;
    const plain = c.getTransactionNoCache as (h: ccc.HexLike) => Promise<unknown>;
    c.getTransactionNoCache = async (hash: ccc.HexLike) =>
      ccc.hexFrom(hash) === first ? ccc.ClientTransactionResponse.from({ transaction: firstTx, status: "pending" }) : plain(hash);
    // The indexer has not seen it: it still lists the spent cells.
    const knownOutputs = firstTx.outputs.map((o, i) => cellOf(first, i, o, firstTx.outputsData[i]));
    p.chain.known.push(...knownOutputs);
    const second = cellOf(first, 0, firstTx.outputs[0], firstTx.outputsData[0]); // the campaign, carried forward
    await sendWithSession(p.session, p.client, d, p.binding, async () => p.pledgeTx(second));
    const tx = p.sent[1];
    expect(tx.inputs.slice(1).every((i) => i.previousOutput.txHash === first)).toBe(true);
    expect(tx.outputs.filter((o) => o.lock.eq(p.lock))).toHaveLength(1);
    expect(tx.outputs[3].capacity).toBe(121n * CKB);
  });
});
