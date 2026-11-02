/**
 * Payout cell contention (mentor review, tracker #47, 2 Nov). Readers paying at
 * the same moment compete for the creator's anyone-can-pay cells: each top-up
 * consumes one. A payment now prefers a confirmed cell that no transaction in
 * the node's pool spends, retries a bounded number of times with backoff when
 * the node refuses it for a spent cell (picking another each time), and never
 * retries a send whose outcome is unknown. `createPayoutCells` gives a creator
 * more cells to spread payments over. Mocked chain; the CCC client is real, only
 * its *NoCache RPC calls are replaced.
 */
import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTNET_DEPLOYMENT as d } from "../src/lock.js";
import {
  createPayoutCells,
  DEFAULT_RETRY,
  keyLockOf,
  MAX_PAYOUT_CELLS,
  MAX_POOL_CHECKS,
  pickPayoutCell,
  poolConflict,
  rebuildOnDeadInputs,
  SessionBalanceError,
  sessionLockOf,
  spendInSession,
  type OnChainBinding,
} from "../src/onchain.js";
import { createSession, SessionPolicyError } from "../src/session.js";

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;
const key = (op: ccc.OutPointLike) => ccc.hexFrom(ccc.OutPoint.from(op).toBytes());

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * A chain the tests edit: committed live cells (what the indexer lists), the out
 * points a transaction in the node's pool spends, and get_transaction's answers.
 * `get_live_cell` with `include_tx_pool` answers a pool-spent cell as dead, as
 * CKB's tx-pool does (PoolCell with rbf false).
 */
function fakeChain(client: ccc.ClientPublicTestnet) {
  const chain = {
    live: [] as ccc.Cell[],
    pool: new Set<string>(),
    txs: new Map<string, ccc.ClientTransactionResponseLike>(),
    poolChecks: 0,
  };
  const c = client as unknown as Record<string, unknown>;
  c.findCellsPagedNoCache = async (k: ccc.ClientIndexerSearchKeyLike) => {
    const script = ccc.Script.from(k.script);
    return { cells: chain.live.filter((x) => x.cellOutput.lock.eq(script)), lastCursor: "0x" };
  };
  c.getCellLiveNoCache = async (op: ccc.OutPointLike, _withData?: boolean, includeTxPool?: boolean) => {
    if (includeTxPool) {
      chain.poolChecks++;
      if (chain.pool.has(key(op))) return undefined;
    }
    return chain.live.find((x) => x.outPoint.eq(ccc.OutPoint.from(op)));
  };
  c.getTransactionNoCache = async (hash: ccc.HexLike) => {
    const r = chain.txs.get(ccc.hexFrom(hash));
    return r && ccc.ClientTransactionResponse.from(r);
  };
  return chain;
}

const cell = (txHash: ccc.Hex, index: number, lock: ccc.Script, capacity: bigint) =>
  ccc.Cell.from({ outPoint: { txHash, index }, cellOutput: { lock, capacity }, outputData: "0x" });

async function acpLock(client: ccc.Client, byte = "44") {
  const acp = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
  return ccc.Script.from({ codeHash: acp.codeHash, hashType: acp.hashType, args: "0x" + byte.repeat(20) });
}

/** A session that pays a creator's anyone-can-pay address with `topUp`, over `payout` cells. */
async function paying(payout: number) {
  const client = new ccc.ClientPublicTestnet();
  const chain = fakeChain(client);
  const s = await client.getKnownScript(ccc.KnownScript.Secp256k1Blake160);
  const ownerLock = ccc.Script.from({ codeHash: s.codeHash, hashType: s.hashType, args: "0x" + "11".repeat(20) });
  const creator = await acpLock(client);
  const to = ccc.Address.fromScript(creator, client).toString();
  const session = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: 100n * CKB } });
  const binding: OnChainBinding = {
    ownerLock: { codeHash: ownerLock.codeHash, hashType: ownerLock.hashType, args: ownerLock.args },
    minInterval: 0n,
  };
  const lock = await sessionLockOf(session, client, d, binding);
  const keyLock = await keyLockOf(session, client);
  const acpCells = Array.from({ length: payout }, (_, i) => cell(h("c" + (i % 10)), i, creator, 61n * CKB));
  chain.live = [cell(h("a1"), 0, lock, 400n * CKB), cell(h("a1"), 1, keyLock, 100n * CKB), ...acpCells];
  vi.spyOn(ccc.Transaction.prototype, "completeFeeChangeToOutput").mockImplementation(async function (this: ccc.Transaction) {
    const keyIn = await client.getCell(this.inputs[this.inputs.length - 1].previousOutput);
    this.outputs[this.outputs.length - 1].capacity = keyIn!.cellOutput.capacity - 1000n;
    return true;
  } as never);
  vi.spyOn(ccc.SignerCkbPrivateKey.prototype, "signTransaction").mockImplementation(async (tx) => ccc.Transaction.from(tx));
  const sent: ccc.Transaction[] = [];
  /** What the node does with each send; by default it takes it. */
  const node = { reply: (t: ccc.Transaction): ccc.Hex => t.hash() };
  (client as unknown as Record<string, unknown>).sendTransactionNoCache = async (tx: ccc.TransactionLike) => {
    const t = ccc.Transaction.from(tx);
    sent.push(t);
    return node.reply(t);
  };
  const payoutIn = (t: ccc.Transaction) => t.inputs.map((i) => i.previousOutput).find((op) => acpCells.some((c) => c.outPoint.eq(op)));
  return { client, chain, session, binding, to, acpCells, sent, node, payoutIn };
}

describe("picking the creator's payout cell", () => {
  it("tops up a cell no transaction in the node's pool spends, whatever the random pick", async () => {
    for (const r of [0, 0.34, 0.67, 0.99]) {
      vi.spyOn(Math, "random").mockReturnValue(r);
      const p = await paying(3);
      p.chain.pool.add(key(p.acpCells[0].outPoint));
      p.chain.pool.add(key(p.acpCells[2].outPoint));
      await spendInSession(p.session, p.client, d, p.binding, { to: p.to, amount: 1n * CKB, topUp: true });
      expect(p.sent).toHaveLength(1);
      expect(p.payoutIn(p.sent[0])?.eq(p.acpCells[1].outPoint)).toBe(true);
      vi.restoreAllMocks();
    }
  });

  it("prefers a confirmed cell over this client's own unconfirmed output", async () => {
    const client = new ccc.ClientPublicTestnet();
    const chain = fakeChain(client);
    const creator = await acpLock(client);
    const confirmed = cell(h("c1"), 0, creator, 61n * CKB);
    const mine = cell(h("d1"), 0, creator, 62n * CKB); // the output of this client's last payment, still pending
    chain.live = [confirmed];
    await client.cache.markUsable(mine);
    for (const r of [0, 0.99]) {
      vi.spyOn(Math, "random").mockReturnValue(r);
      const picked = await pickPayoutCell(client, creator, [mine, confirmed]);
      expect(picked!.outPoint.eq(confirmed.outPoint)).toBe(true);
    }
    // With the confirmed one spent in the pool, the unconfirmed one will do.
    chain.pool.add(key(confirmed.outPoint));
    chain.live.push(mine);
    expect((await pickPayoutCell(client, creator, [mine, confirmed]))!.outPoint.eq(mine.outPoint)).toBe(true);
  });

  it(`asks the node about at most MAX_POOL_CHECKS (${MAX_POOL_CHECKS}) cells per pick`, async () => {
    const client = new ccc.ClientPublicTestnet();
    const chain = fakeChain(client);
    const creator = await acpLock(client);
    const cells = Array.from({ length: 40 }, (_, i) => cell(h("c" + (i % 10)), i, creator, 61n * CKB));
    chain.live = cells;
    for (const c of cells) chain.pool.add(key(c.outPoint));
    // All checked ones are busy, but unchecked ones remain: one of those is tried, not refused.
    const picked = await pickPayoutCell(client, creator, cells);
    expect(cells.some((c) => c.outPoint.eq(picked!.outPoint))).toBe(true);
    expect(chain.poolChecks).toBeLessThanOrEqual(MAX_POOL_CHECKS);
  });

  it(`reads at most MAX_PAYOUT_CELLS (${MAX_PAYOUT_CELLS}) of the recipient's cells`, async () => {
    const p = await paying(3 * MAX_PAYOUT_CELLS);
    let read = 0;
    const find = p.client.findCellsByLock.bind(p.client);
    p.client.findCellsByLock = (async function* (lock: ccc.ScriptLike, ...rest: unknown[]) {
      for await (const c of (find as (...a: unknown[]) => AsyncGenerator<ccc.Cell>)(lock, ...rest)) {
        if (p.acpCells.some((a) => a.outPoint.eq(c.outPoint))) read++;
        yield c;
      }
    }) as never;
    await spendInSession(p.session, p.client, d, p.binding, { to: p.to, amount: 1n * CKB, topUp: true });
    expect(p.sent).toHaveLength(1);
    expect(read).toBeLessThanOrEqual(MAX_PAYOUT_CELLS + 1);
  });

  it("when the node cannot be asked, still picks a cell (the send then tells)", async () => {
    const client = new ccc.ClientPublicTestnet();
    const creator = await acpLock(client);
    (client as unknown as Record<string, unknown>).getCellLiveNoCache = async () => {
      throw new Error("request timeout");
    };
    const only = cell(h("c1"), 0, creator, 61n * CKB);
    expect((await pickPayoutCell(client, creator, [only]))!.outPoint.eq(only.outPoint)).toBe(true);
  });
});

describe("every payout cell is spent by a transaction in the pool", () => {
  it("sends nothing, waits and builds again, then throws payout-busy after the last attempt", async () => {
    const p = await paying(2);
    for (const c of p.acpCells) p.chain.pool.add(key(c.outPoint));
    const err = await spendInSession(p.session, p.client, d, p.binding, {
      to: p.to,
      amount: 1n * CKB,
      topUp: true,
      retry: { attempts: 3, delayMs: 0 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionBalanceError);
    expect(err).toMatchObject({ reason: "payout-busy" });
    expect(p.sent).toHaveLength(0);
    expect(p.chain.poolChecks).toBe(3 * 2);
  });

  it("succeeds once a block commits the other payment and its new cell is listed", async () => {
    const p = await paying(1);
    p.chain.pool.add(key(p.acpCells[0].outPoint));
    const creator = p.acpCells[0].cellOutput.lock;
    // The client sleeps between attempts: meanwhile the other payment commits.
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      p.chain.pool.clear();
      p.chain.live = p.chain.live.filter((c) => !c.outPoint.eq(p.acpCells[0].outPoint));
      p.chain.live.push(cell(h("e1"), 0, creator, 62n * CKB));
      fn();
      return 0;
    }) as never);
    await spendInSession(p.session, p.client, d, p.binding, { to: p.to, amount: 1n * CKB, topUp: true });
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0].inputs.some((i) => i.previousOutput.txHash === h("e1"))).toBe(true);
  });
});

describe("a payment the node refuses for a spent payout cell", () => {
  it("is retried with another cell after an RBF rejection (the cell was taken between the check and the send)", async () => {
    const p = await paying(3);
    vi.spyOn(Math, "random").mockReturnValue(0);
    let first: ccc.OutPoint | undefined;
    p.node.reply = (t) => {
      if (!first) {
        first = p.payoutIn(t)!;
        // Another reader's payment of the same cell reached the pool first.
        p.chain.pool.add(key(first));
        throw new ccc.ErrorClientRBFRejected(
          { message: "PoolRejectedRBF", code: -1111, data: 'RBFRejected("Tx\'s current fee is 1000, expect it to >= 2000 to replace old txs")' },
          1000n,
          2000n,
        );
      }
      return t.hash();
    };
    const told: ccc.Hex[] = [];
    const hash = await spendInSession(p.session, p.client, d, p.binding, {
      to: p.to,
      amount: 1n * CKB,
      topUp: true,
      retry: { delayMs: 0 },
      beforeSend: async (x) => void told.push(x),
    });
    expect(p.sent).toHaveLength(2);
    expect(hash).toBe(p.sent[1].hash());
    expect(told).toEqual([p.sent[0].hash(), p.sent[1].hash()]);
    expect(p.payoutIn(p.sent[1])!.eq(first!)).toBe(false);
  });

  it("does not pick the cell a Dead rejection names again, even while the node's pool check still says it is live", async () => {
    const p = await paying(3);
    vi.spyOn(Math, "random").mockReturnValue(0);
    let dead: ccc.OutPoint | undefined;
    p.node.reply = (t) => {
      if (!dead) {
        dead = p.payoutIn(t)!;
        throw new Error(`TransactionFailedToResolve: Resolve failed Dead(OutPoint(${ccc.hexFrom(dead.toBytes())}))`);
      }
      return t.hash();
    };
    await spendInSession(p.session, p.client, d, p.binding, { to: p.to, amount: 1n * CKB, topUp: true, retry: { delayMs: 0 } });
    expect(p.sent).toHaveLength(2);
    expect(p.payoutIn(p.sent[1])!.eq(dead!)).toBe(false);
  });

  it("stops after `attempts` and throws the node's rejection", async () => {
    const p = await paying(5);
    p.node.reply = (t) => {
      throw new Error(`Resolve failed Dead(OutPoint(${ccc.hexFrom(p.payoutIn(t)!.toBytes())}))`);
    };
    await expect(
      spendInSession(p.session, p.client, d, p.binding, { to: p.to, amount: 1n * CKB, topUp: true, retry: { attempts: 2, delayMs: 0 } }),
    ).rejects.toThrow(/Dead\(OutPoint/);
    expect(p.sent).toHaveLength(2);
  });

  it("never retries a send whose outcome is unknown", async () => {
    const p = await paying(3);
    p.node.reply = () => {
      throw new Error("request timeout"); // the reply was lost; the node does not know the transaction
    };
    await expect(
      spendInSession(p.session, p.client, d, p.binding, { to: p.to, amount: 1n * CKB, topUp: true, retry: { attempts: 5, delayMs: 0 } }),
    ).rejects.toThrow(/timeout/);
    expect(p.sent).toHaveLength(1);
  });

  it("returns the hash of a send the node took although the reply was lost", async () => {
    const p = await paying(3);
    p.node.reply = (t) => {
      p.chain.txs.set(t.hash(), { transaction: t, status: "pending" });
      throw new Error("request timeout");
    };
    const hash = await spendInSession(p.session, p.client, d, p.binding, { to: p.to, amount: 1n * CKB, topUp: true });
    expect(p.sent).toHaveLength(1);
    expect(hash).toBe(p.sent[0].hash());
  });
});

describe("retry and backoff", () => {
  it(`defaults to ${DEFAULT_RETRY.attempts} attempts, ${DEFAULT_RETRY.delayMs} ms doubling, with jitter`, async () => {
    const client = new ccc.ClientPublicTestnet();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter factor 1
    const waits: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
      waits.push(ms);
      fn();
      return 0;
    }) as never);
    let runs = 0;
    await expect(
      rebuildOnDeadInputs(client, async () => {
        runs++;
        throw new Error("Resolve failed Dead(OutPoint(0x00))");
      }),
    ).rejects.toThrow(/Dead/);
    expect(runs).toBe(DEFAULT_RETRY.attempts);
    expect(waits).toEqual([DEFAULT_RETRY.delayMs, 2 * DEFAULT_RETRY.delayMs]);
  });

  it("takes attempts and delay from the caller; attempts 1 never retries", async () => {
    const client = new ccc.ClientPublicTestnet();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const waits: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
      waits.push(ms);
      fn();
      return 0;
    }) as never);
    let runs = 0;
    const dead = async () => {
      runs++;
      throw new Error("Resolve failed Dead(OutPoint(0x00))");
    };
    await expect(rebuildOnDeadInputs(client, dead, { attempts: 4, delayMs: 10 })).rejects.toThrow(/Dead/);
    expect(runs).toBe(4);
    expect(waits).toEqual([10, 20, 40]);
    runs = 0;
    await expect(rebuildOnDeadInputs(client, dead, { attempts: 1 })).rejects.toThrow(/Dead/);
    expect(runs).toBe(1);
  });

  it("tells a pool conflict from other rejections", () => {
    const rbf = new ccc.ErrorClientRBFRejected({ message: "x", data: "RBFRejected(..)" }, 1n, 2n);
    expect(poolConflict(rbf)).toBe(true);
    expect(poolConflict(new Error('PoolRejectedRBF: RBFRejected("new Tx contains unconfirmed inputs")'))).toBe(true);
    expect(poolConflict(new ccc.ErrorClientDuplicatedTransaction({ message: "x", data: "Duplicated(Byte32(0x00))" }, h("00")))).toBe(false);
    expect(poolConflict(new Error("request timeout"))).toBe(false);
  });
});

describe("createPayoutCells", () => {
  async function setup(byte = "44") {
    const client = new ccc.ClientPublicTestnet();
    const funder = new ccc.SignerCkbPrivateKey(client, h("42"));
    vi.spyOn(ccc.Transaction.prototype, "completeInputsByCapacity").mockResolvedValue(0 as never);
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    vi.spyOn(funder, "signTransaction").mockImplementation(async (tx) => ccc.Transaction.from(tx));
    const send = vi.spyOn(client, "sendTransaction").mockImplementation(async (tx) => ccc.Transaction.from(tx).hash());
    const payTo = await acpLock(client, byte);
    return { client, funder, send, payTo, address: ccc.Address.fromScript(payTo, client).toString() };
  }

  it("adds `count` plain cells under an anyone-can-pay address, each the smallest a cell can be", async () => {
    const { funder, send, payTo, address } = await setup();
    await createPayoutCells(funder, address, { count: 5 });
    const tx = ccc.Transaction.from(send.mock.calls[0][0]);
    expect(tx.outputs).toHaveLength(5);
    expect(tx.outputs.every((o) => o.lock.eq(payTo) && !o.type && o.capacity === 61n * CKB)).toBe(true);
  });

  it("adds token cells holding 0 units with `token`", async () => {
    const { client, funder, send, payTo, address } = await setup();
    const xudt = await client.getKnownScript(ccc.KnownScript.XUdt);
    const token = ccc.Script.from({ codeHash: xudt.codeHash, hashType: xudt.hashType, args: h("ab") });
    await createPayoutCells(funder, address, { count: 2, token });
    const tx = ccc.Transaction.from(send.mock.calls[0][0]);
    expect(tx.outputs.every((o) => o.lock.eq(payTo) && o.type?.eq(token))).toBe(true);
    expect(tx.outputsData).toEqual([ccc.hexFrom(new Uint8Array(16)), ccc.hexFrom(new Uint8Array(16))]);
  });

  it("refuses an address that is not anyone-can-pay, and a count out of range", async () => {
    const { client, funder } = await setup();
    const plain = (await funder.getRecommendedAddressObj()).toString();
    await expect(createPayoutCells(funder, plain, { count: 2 })).rejects.toMatchObject({ reason: "payto-not-anyone-can-pay" });
    await expect(createPayoutCells(funder, plain, { count: 2 })).rejects.toBeInstanceOf(SessionPolicyError);
    const acp = ccc.Address.fromScript(await acpLock(client), client).toString();
    await expect(createPayoutCells(funder, acp, { count: 0 })).rejects.toThrow(RangeError);
    await expect(createPayoutCells(funder, acp, { count: MAX_PAYOUT_CELLS + 1 })).rejects.toThrow(RangeError);
  });
});
