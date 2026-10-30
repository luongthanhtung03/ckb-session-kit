/**
 * Audit round 2 (31 Oct): state, concurrency and failure over time. Each test
 * here failed before the fix and shows one finding; they pass since the fixes
 * of 31 Oct. Mocked chain only; the CCC client is real wherever its cache is
 * part of the finding (only its *NoCache RPC calls are replaced).
 */
import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESTNET_DEPLOYMENT as d } from "../src/lock.js";
import { closeSession, keyLockOf, sessionLockOf, spendInSession, type OnChainBinding } from "../src/onchain.js";
import { paymentMemo, signAccess, verifyAccess } from "../src/paywall.js";
import { createSession } from "../src/session.js";

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;

afterEach(() => vi.restoreAllMocks());

async function secpLock(client: ccc.Client, byte: string) {
  const s = await client.getKnownScript(ccc.KnownScript.Secp256k1Blake160);
  return ccc.Script.from({ codeHash: s.codeHash, hashType: s.hashType, args: "0x" + byte.repeat(20) });
}

/** A chain the tests edit: live cells, and what get_transaction answers. */
function fakeChain(client: ccc.ClientPublicTestnet) {
  const chain = { live: [] as ccc.Cell[], txs: new Map<string, ccc.ClientTransactionResponseLike>(), sent: [] as ccc.Transaction[] };
  const c = client as unknown as Record<string, unknown>;
  c.findCellsPagedNoCache = async (key: ccc.ClientIndexerSearchKeyLike) => {
    const script = ccc.Script.from(key.script);
    return { cells: chain.live.filter((x) => x.cellOutput.lock.eq(script)), lastCursor: "0x" };
  };
  c.getCellLiveNoCache = async (op: ccc.OutPointLike) => chain.live.find((x) => x.outPoint.eq(ccc.OutPoint.from(op)));
  c.getTransactionNoCache = async (hash: ccc.HexLike) => {
    const r = chain.txs.get(ccc.hexFrom(hash));
    return r && ccc.ClientTransactionResponse.from(r);
  };
  return chain;
}

describe("closeSession after the session is already empty on-chain", () => {
  // Scenario: the first close swept the session cells, then sent the key cell back;
  // the node took it but the reply was lost, so closeSession reported keyError and
  // the demo kept the key ("close again to retry"). Both commit. The funding
  // transaction is committed, so every later close throws "not indexed yet" and
  // the stored session can never be forgotten; the page cannot open another
  // session under that store key (SessionStoreConflict). The same happens in a
  // second tab after the first tab closed the session.
  it("lets the key be forgotten once the funding is committed and its outputs are spent", async () => {
    const client = new ccc.ClientPublicTestnet();
    const chain = fakeChain(client);
    const ownerLock = await secpLock(client, "11");
    const owner = new ccc.SignerCkbPrivateKey(client, "0x" + "42".repeat(32));
    vi.spyOn(owner, "getRecommendedAddressObj").mockResolvedValue({ script: ownerLock } as never);
    const session = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: 5n * CKB } });
    const binding: OnChainBinding = {
      ownerLock: { codeHash: ownerLock.codeHash, hashType: ownerLock.hashType, args: ownerLock.args },
      minInterval: 0n,
      openTx: h("0f"),
    };
    const lock = await sessionLockOf(session, client, d, binding);
    const keyLock = await keyLockOf(session, client);
    const opening = ccc.Transaction.from({ outputs: [{ lock, capacity: 300n * CKB }, { lock: keyLock, capacity: 62n * CKB }], outputsData: ["0x", "0x"] });
    chain.txs.set(h("0f"), { transaction: opening, status: "committed", blockNumber: 100n });
    // Only the key cell is left (the sweep already committed).
    chain.live = [ccc.Cell.from({ outPoint: { txHash: h("0f"), index: 1 }, cellOutput: { lock: keyLock, capacity: 62n * CKB }, outputData: "0x" })];
    vi.spyOn(ccc.Transaction.prototype, "completeFeeChangeToOutput").mockImplementation(async function (this: ccc.Transaction) {
      this.outputs[0].capacity = 62n * CKB - 1000n;
      return true;
    } as never);
    vi.spyOn(ccc.SignerCkbPrivateKey.prototype, "signTransaction").mockImplementation(async (tx) => ccc.Transaction.from(tx));
    // The node takes the key return, the reply is lost.
    (client as unknown as Record<string, unknown>).sendTransactionNoCache = async () => {
      chain.live = [];
      throw new Error("request timeout");
    };

    const first = await closeSession(owner, session, d, binding);
    expect(first.keyError).toMatch(/timeout/); // the demo keeps the key: correct so far

    // Everything has committed. Closing again must be able to finish.
    await expect(closeSession(owner, session, d, binding)).resolves.toEqual({ nothingFound: true });
  });

  it("still refuses while an output of the committed funding is live but not indexed yet", async () => {
    const client = new ccc.ClientPublicTestnet();
    const chain = fakeChain(client);
    const ownerLock = await secpLock(client, "11");
    const owner = new ccc.SignerCkbPrivateKey(client, "0x" + "42".repeat(32));
    vi.spyOn(owner, "getRecommendedAddressObj").mockResolvedValue({ script: ownerLock } as never);
    const session = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: 5n * CKB } });
    const binding: OnChainBinding = {
      ownerLock: { codeHash: ownerLock.codeHash, hashType: ownerLock.hashType, args: ownerLock.args },
      minInterval: 0n,
      openTx: h("0f"),
    };
    const lock = await sessionLockOf(session, client, d, binding);
    const keyLock = await keyLockOf(session, client);
    const opening = ccc.Transaction.from({ outputs: [{ lock, capacity: 300n * CKB }, { lock: keyLock, capacity: 62n * CKB }], outputsData: ["0x", "0x"] });
    chain.txs.set(h("0f"), { transaction: opening, status: "committed", blockNumber: 100n });
    // The indexer lists nothing yet; the node holds the session cell live.
    const sessionCell = ccc.Cell.from({ outPoint: { txHash: h("0f"), index: 0 }, cellOutput: opening.outputs[0], outputData: "0x" });
    (client as unknown as Record<string, unknown>).getCellLiveNoCache = async (op: ccc.OutPointLike) =>
      sessionCell.outPoint.eq(ccc.OutPoint.from(op)) ? sessionCell : undefined;
    await expect(closeSession(owner, session, d, binding)).rejects.toThrow(/not indexed yet/);
  });
});

describe("a payment rejected for a spent input", () => {
  // The cache filter keeps a cached cell while the transaction that made it is
  // pending; if another tab spent it meanwhile, the node rejects the payment.
  it("is built once more from live cells after clearing the cache, with beforeSend told the new hash", async () => {
    const client = new ccc.ClientPublicTestnet();
    const chain = fakeChain(client);
    const ownerLock = await secpLock(client, "11");
    const to = ccc.Address.fromScript(await secpLock(client, "44"), client).toString();
    const session = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: 100n * CKB } });
    const binding: OnChainBinding = {
      ownerLock: { codeHash: ownerLock.codeHash, hashType: ownerLock.hashType, args: ownerLock.args },
      minInterval: 0n,
    };
    const lock = await sessionLockOf(session, client, d, binding);
    const keyLock = await keyLockOf(session, client);
    const cell = (txHash: ccc.Hex, index: number, l: ccc.Script, capacity: bigint) =>
      ccc.Cell.from({ outPoint: { txHash, index }, cellOutput: { lock: l, capacity }, outputData: "0x" });
    chain.live = [cell(h("a1"), 0, lock, 400n * CKB), cell(h("a1"), 1, keyLock, 100n * CKB)];
    vi.spyOn(ccc.Transaction.prototype, "completeFeeChangeToOutput").mockImplementation(async function (this: ccc.Transaction) {
      const keyIn = await client.getCell(this.inputs[this.inputs.length - 1].previousOutput);
      this.outputs[this.outputs.length - 1].capacity = keyIn!.cellOutput.capacity - 1000n;
      return true;
    } as never);
    vi.spyOn(ccc.SignerCkbPrivateKey.prototype, "signTransaction").mockImplementation(async (tx) => ccc.Transaction.from(tx));
    const sent: ccc.Transaction[] = [];
    (client as unknown as Record<string, unknown>).sendTransactionNoCache = async (tx: ccc.TransactionLike) => {
      const t = ccc.Transaction.from(tx);
      sent.push(t);
      const dead = t.inputs.find((i) => !chain.live.some((c) => c.outPoint.eq(i.previousOutput)));
      if (dead) throw new Error(`TransactionFailedToResolve: Resolve failed Dead(OutPoint(${ccc.hexFrom(dead.previousOutput.toBytes())}))`);
      return t.hash();
    };

    await spendInSession(session, client, d, binding, { to, amount: 61n * CKB });
    // The first payment is still pending as far as the node says, but tab B spent its outputs.
    chain.txs.set(sent[0].hash(), { transaction: sent[0], status: "pending" });
    chain.live = [cell(h("b2"), 1, lock, 278n * CKB), cell(h("b2"), 2, keyLock, 100n * CKB - 2000n)];

    const told: ccc.Hex[] = [];
    const hash = await spendInSession(session, client, d, binding, { to, amount: 61n * CKB, beforeSend: async (x) => void told.push(x) });
    expect(sent).toHaveLength(3); // the first payment, the rejected one, the rebuilt one
    expect(hash).toBe(sent[2].hash());
    expect(told).toEqual([sent[1].hash(), sent[2].hash()]);
    expect(sent[2].inputs.every((i) => chain.live.some((c) => c.outPoint.eq(i.previousOutput)))).toBe(true);
  });

  it("is not rebuilt for any other rejection", async () => {
    const client = new ccc.ClientPublicTestnet();
    const clear = vi.spyOn(client.cache, "clear");
    let runs = 0;
    const { rebuildOnDeadInputs } = await import("../src/onchain.js");
    await expect(
      rebuildOnDeadInputs(client, async () => {
        runs++;
        throw new Error("TransactionFailedToVerify: script error");
      }),
    ).rejects.toThrow(/FailedToVerify/);
    expect(runs).toBe(1);
    expect(clear).not.toHaveBeenCalled();
  });
});

describe("the CCC client cache keeps a tab's own outputs live after another tab spent them", () => {
  // Scenario: two tabs (or a tab and a phone) hold the same session. Tab A pays
  // once; CCC's cache in tab A now lists A's change cell and new key cell as live,
  // yields them before the indexer's cells, and never drops them. Tab B then pays
  // from those cells. Every later spend in tab A (and closeSession's sweep) is
  // built on the dead cached cells and rejected by the node, until tab A reloads.
  // The same holds for a tab whose own payment was dropped, and for the charge
  // route's module-level client across serverless instances (feeCells, subscriptionCells).
  it("builds the next spend from cells that are live on-chain", async () => {
    const client = new ccc.ClientPublicTestnet();
    const chain = fakeChain(client);
    const ownerLock = await secpLock(client, "11");
    const to = ccc.Address.fromScript(await secpLock(client, "44"), client).toString();
    const session = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: 100n * CKB } });
    const binding: OnChainBinding = {
      ownerLock: { codeHash: ownerLock.codeHash, hashType: ownerLock.hashType, args: ownerLock.args },
      minInterval: 0n,
    };
    const lock = await sessionLockOf(session, client, d, binding);
    const keyLock = await keyLockOf(session, client);
    const cell = (txHash: ccc.Hex, index: number, l: ccc.Script, capacity: bigint) =>
      ccc.Cell.from({ outPoint: { txHash, index }, cellOutput: { lock: l, capacity }, outputData: "0x" });
    chain.live = [cell(h("a1"), 0, lock, 400n * CKB), cell(h("a1"), 1, keyLock, 100n * CKB)];

    vi.spyOn(ccc.Transaction.prototype, "completeFeeChangeToOutput").mockImplementation(async function (this: ccc.Transaction) {
      const keyIn = await client.getCell(this.inputs[this.inputs.length - 1].previousOutput);
      this.outputs[this.outputs.length - 1].capacity = keyIn!.cellOutput.capacity - 1000n;
      return true;
    } as never);
    vi.spyOn(ccc.SignerCkbPrivateKey.prototype, "signTransaction").mockImplementation(async (tx) => ccc.Transaction.from(tx));
    const sent: ccc.Transaction[] = [];
    (client as unknown as Record<string, unknown>).sendTransactionNoCache = async (tx: ccc.TransactionLike) => {
      const t = ccc.Transaction.from(tx);
      sent.push(t);
      return t.hash();
    };

    await spendInSession(session, client, d, binding, { to, amount: 61n * CKB });
    // Tab B (its own client) pays from tab A's change and key cell; that commits.
    chain.live = [cell(h("b2"), 1, lock, 278n * CKB), cell(h("b2"), 2, keyLock, 100n * CKB - 2000n)];

    await spendInSession(session, client, d, binding, { to, amount: 61n * CKB }).catch(() => undefined);
    const second = sent[1];
    expect(second).toBeDefined();
    const live = (op: ccc.OutPoint) => chain.live.some((c) => c.outPoint.eq(op));
    expect(second.inputs.map((i) => live(i.previousOutput))).toEqual(second.inputs.map(() => true));
  });
});

describe("verifyAccess on a long-lived server client", () => {
  // Scenario: the demo's API routes keep one module-level client. CCC's
  // getTransaction falls back to its cache when the node no longer knows a
  // transaction (`transaction: null`), and every answer it saw is cached,
  // "committed" included. A payment that was committed, then reorged out and
  // replaced by a conflicting spend, keeps unlocking content on that instance.
  it("does not grant access once the node no longer knows the payment", async () => {
    const client = new ccc.ClientPublicTestnet();
    const chain = fakeChain(client);
    const payer = createSession({ expiresAt: new Date(Date.now() + 60_000), scope: { maxPerTx: 5n * CKB } });
    const keyLock = (await new ccc.SignerCkbPrivateKey(client, payer.privateKey).getAddressObjSecp256k1()).script;
    const creator = ccc.Script.from({ codeHash: h("cc"), hashType: "type", args: "0x01" });
    const memo = paymentMemo("read:a");
    const prev = (i: number) => ccc.OutPoint.from({ txHash: h("01"), index: i });
    const inputs = [
      { lock: creator, capacity: 61n * CKB },
      { lock: keyLock, capacity: 100n * CKB },
    ];
    const tx = ccc.Transaction.from({
      inputs: inputs.map((_, i) => ({ previousOutput: prev(i) })),
      outputs: [{ lock: creator, capacity: 62n * CKB }, { lock: keyLock, capacity: 99n * CKB - 1000n }],
      outputsData: ["0x", "0x"],
    });
    tx.setWitnessArgsAt(1, { inputType: memo, lock: "0x" + "00".repeat(65) });
    chain.txs.set(tx.hash(), { transaction: tx, status: "committed", blockNumber: 10n });
    chain.txs.set(h("01"), { transaction: ccc.Transaction.from({ outputs: inputs, outputsData: ["0x", "0x"] }), status: "committed", blockNumber: 5n });
    const proof = await signAccess(payer, tx.hash(), memo);
    const expect_ = { to: creator, minAmount: 1n * CKB, memo };

    expect((await verifyAccess(client, proof, expect_)).ok).toBe(true);
    chain.txs.delete(tx.hash()); // reorged out, its input spent elsewhere: the node answers transaction null
    expect(await client.getTransactionNoCache(tx.hash())).toBeUndefined();
    expect((await verifyAccess(client, proof, expect_)).ok).toBe(false);
  });
});
