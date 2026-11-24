/**
 * Regression tests for the hardening review of 24 Nov 2026
 * (liveness, recovery and how sessions are bound to wallets). Mocked chain as in
 * fund.test.ts: the CCC client, fee completion and signing are real; only its
 * RPC calls are replaced.
 */
import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexerFind } from "./fixtures/indexer.js";
import { codeCellAt, TEST_DEPLOYMENT } from "./fixtures/deployment.js";
import { sessionLockScript, TESTNET_DEPLOYMENT as d, TESTNET_LEGACY_DEPLOYMENTS } from "../src/lock.js";
import {
  closeSession,
  findOwnedSessionCells,
  fundInSession,
  keyLockOf,
  openSession,
  recoverSessions,
  SessionBalanceError,
  sendWithSession,
  sessionLockOf,
  spendInSession,
  type OnChainBinding,
} from "../src/onchain.js";
import { createSession, SessionPolicyError } from "../src/session.js";
import { ScopeError } from "../src/transfer.js";
import { indexedDbStore, memoryStore, SessionStoreConflict } from "../src/store.js";

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;
afterEach(() => vi.restoreAllMocks());

const cellOf = (txHash: ccc.Hex, index: number, out: ccc.CellOutputLike, data: ccc.HexLike = "0x") =>
  ccc.Cell.from({ outPoint: { txHash, index }, cellOutput: out, outputData: data });

async function setup(o: { maxPerTx: bigint; sessionCells: bigint[]; keyCells?: bigint[]; ownerKey?: ccc.Hex; recipient?: ccc.Script }) {
  const client = new ccc.ClientPublicTestnet();
  const owner = new ccc.SignerCkbPrivateKey(client, o.ownerKey ?? h("07"));
  const recipient = o.recipient && ccc.Address.fromScript(o.recipient, client).toString();
  const session = createSession({
    expiresAt: new Date(Date.now() + 3_600_000),
    scope: { maxPerTx: o.maxPerTx, ...(recipient && { recipients: [recipient] }) },
  });
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
    ...(o.recipient && { recipientLockHash: o.recipient.hash() }),
  };
  const lock = await sessionLockOf(session, client, d, binding);
  const keyLock = await keyLockOf(session, client);
  live.push(...o.sessionCells.map((cap, i) => cellOf(h("a1"), i, { lock, capacity: cap })));
  live.push(...(o.keyCells ?? [100n * CKB]).map((cap, i) => cellOf(h("b1"), i, { lock: keyLock, capacity: cap })));
  return { client, owner, ownerLock, session, binding, lock, keyLock, chain, sent, recipient };
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

describe("review 24 Nov, 2: the owner sweep proves ownership with a cell under the owner's lock itself", () => {
  /** An anyone-can-pay cell under the owner's own pubkey hash: CCC's private-key signer lists that address too. */
  async function withAcpCell(p: Awaited<ReturnType<typeof setup>>, args: ccc.Hex = p.ownerLock.args) {
    const acp = await p.client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
    const acpLock = ccc.Script.from({ codeHash: acp.codeHash, hashType: acp.hashType, args });
    p.chain.live.push(cellOf(h("c1"), 0, { lock: acpLock, capacity: 500n * CKB }));
    vi.spyOn(ccc.SignerCkbPrivateKey.prototype, "signTransaction").mockImplementation(async (tx) => ccc.Transaction.from(tx));
    return acpLock;
  }
  /** The node: refuses a sweep with no input under the owner's lock (the session lock's error 11). */
  function modelNode(p: Awaited<ReturnType<typeof setup>>) {
    const c = p.client as unknown as Record<string, unknown>;
    c.sendTransactionNoCache = async (tx: ccc.TransactionLike) => {
      const t = ccc.Transaction.from(tx);
      const locks = await Promise.all(t.inputs.map(async (i) => (await p.client.getCell(i.previousOutput))!.cellOutput.lock.hash()));
      if (!locks.includes(p.ownerLock.hash())) {
        throw new Error("TransactionFailedToVerify: Verification failed Script(TransactionScriptError { source: Inputs[0].Lock, cause: ValidationFailure: see error code 11");
      }
      p.sent.push(t);
      return t.hash();
    };
  }

  it("the signer does list the anyone-can-pay address (the premise)", async () => {
    const p = await setup({ maxPerTx: 10n * CKB, sessionCells: [300n * CKB], keyCells: [] });
    const acpLock = await withAcpCell(p);
    const addrs = await p.owner.getAddressObjs();
    expect(addrs.map((a) => a.script.hash())).toContain(acpLock.hash());
  });

  it("closeSession with only an anyone-can-pay cell: the clear 'owner needs one plain cell' error, nothing sent", async () => {
    const p = await setup({ maxPerTx: 10n * CKB, sessionCells: [300n * CKB], keyCells: [] });
    await withAcpCell(p);
    await expect(closeSession(p.owner, p.session, d, p.binding)).rejects.toThrow(/owner needs one plain cell/);
    expect(p.sent).toHaveLength(0);
  });

  it("recoverSessions with only an anyone-can-pay cell throws the same clear error, not a silent failed count", async () => {
    const p = await setup({ maxPerTx: 10n * CKB, sessionCells: [300n * CKB], keyCells: [] });
    await withAcpCell(p, (p.ownerLock.args + "00") as ccc.Hex);
    modelNode(p);
    await expect(recoverSessions(p.owner, d)).rejects.toBeInstanceOf(SessionBalanceError);
  });

  it("with a plain cell under the owner's lock as well, the sweep includes it and recovers the session", async () => {
    const p = await setup({ maxPerTx: 10n * CKB, sessionCells: [300n * CKB], keyCells: [] });
    await withAcpCell(p);
    p.chain.live.push(cellOf(h("d1"), 0, { lock: p.ownerLock, capacity: 200n * CKB }));
    modelNode(p);
    await expect(recoverSessions(p.owner, d)).resolves.toMatchObject({ failed: 0, recovered: 300n * CKB });
    const proof = await p.client.getCell(p.sent[0].inputs[1].previousOutput);
    expect(proof!.cellOutput.lock.eq(p.ownerLock)).toBe(true);
  });
});

describe("review 24 Nov, 3: a session opens once, and its stored binding is not replaced by another", () => {
  const binding = (owner: string, minInterval = 10n) => ({
    ownerLock: { codeHash: h("aa"), hashType: "type" as const, args: ("0x" + owner.repeat(20)) as ccc.Hex },
    minInterval,
  });
  const fresh = () => createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: 10n * CKB } });

  it.each([
    ["memoryStore", () => memoryStore()],
    ["indexedDbStore", () => indexedDbStore(fakeIdb())],
  ])("%s refuses another binding over a stored one, and allows adding or changing openTx", async (_, make) => {
    const store = make();
    const s = fresh();
    await store.save({ ...s, onchain: binding("11") });
    await store.save({ ...s, onchain: { ...binding("11"), openTx: h("01") } }); // the funding's hash
    await store.save({ ...s, onchain: { ...binding("11"), openTx: h("02") } }); // a resent funding
    for (const other of [binding("22"), binding("11", 0n), { ...binding("11"), recipientLockHash: h("33") }]) {
      const e = await store.save({ ...s, onchain: { ...other, openTx: h("03") } }).catch((x) => x);
      expect(e).toBeInstanceOf(SessionStoreConflict);
      expect(String(e)).toMatch(/another on-chain binding/);
    }
    expect((await store.load())!.onchain).toEqual({ ...binding("11"), openTx: h("02") });
  });

  /** A secp256k1 owner on a mocked testnet client whose indexer holds `cells`; sends are recorded. */
  async function opener(cells: ccc.Cell[] = []) {
    const client = new ccc.ClientPublicTestnet();
    const signer = new ccc.SignerCkbPrivateKey(client, h("42"));
    const sent: ccc.Transaction[] = [];
    vi.spyOn(signer, "signTransaction").mockImplementation(async (tx) => ccc.Transaction.from(tx));
    vi.spyOn(client, "sendTransaction").mockImplementation(async (tx) => {
      const t = ccc.Transaction.from(tx);
      sent.push(t);
      return t.hash();
    });
    vi.spyOn(client, "getCellLive").mockImplementation(async (op) => codeCellAt(op));
    vi.spyOn(client, "findCells").mockImplementation(async function* (k: ccc.ClientIndexerSearchKeyLike) {
      yield* indexerFind(cells, k);
    } as never);
    vi.spyOn(ccc.Transaction.prototype, "completeInputsByCapacity").mockResolvedValue(0 as never);
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    return { client, signer, sent };
  }

  it("openSession refuses a session whose onchain is set, before anything is signed", async () => {
    const { signer, sent } = await opener();
    const { binding: b } = await openSession(signer, fresh(), TEST_DEPLOYMENT, { budget: 200n * CKB });
    expect(sent).toHaveLength(1);
    const e = await openSession(signer, { ...fresh(), onchain: b }, TEST_DEPLOYMENT, { budget: 200n * CKB }).catch((x) => x);
    expect(e).toBeInstanceOf(SessionPolicyError);
    expect(e).toMatchObject({ reason: "session-already-open" });
    expect(sent).toHaveLength(1);
  });

  it("openSession refuses a session whose key already holds a cell (opened before, from a copy without onchain)", async () => {
    const s = fresh();
    const client = new ccc.ClientPublicTestnet();
    const keyCell = cellOf(h("b1"), 0, { lock: await keyLockOf(s, client), capacity: 62n * CKB });
    const { signer, sent } = await opener([keyCell]);
    await expect(openSession(signer, s, TEST_DEPLOYMENT, { budget: 200n * CKB })).rejects.toMatchObject({
      reason: "session-already-open",
    });
    expect(sent).toHaveLength(0);
  });
});

describe("review 24 Nov, 4: the fee comes only from cells under the key's own lock", () => {
  it("a recipient session whose key cell cannot pay the fee refuses with no-fee-cell, not taking the key's anyone-can-pay cell", async () => {
    const sec = await new ccc.ClientPublicTestnet().getKnownScript(ccc.KnownScript.Secp256k1Blake160);
    const recipient = ccc.Script.from({ codeHash: sec.codeHash, hashType: sec.hashType, args: "0x" + "33".repeat(20) });
    // The key cell holds its floor and a few shannons: not enough for a fee.
    const p = await setup({ maxPerTx: 100n * CKB, sessionCells: [500n * CKB], keyCells: [61n * CKB + 100n], recipient });
    // Anyone can create a cell at the key's anyone-can-pay address (same key hash).
    const acp = await p.client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
    const acpLock = ccc.Script.from({ codeHash: acp.codeHash, hashType: acp.hashType, args: p.keyLock.args });
    p.chain.live.push(cellOf(h("e1"), 0, { lock: acpLock, capacity: 200n * CKB }));
    const e = await spendInSession(p.session, p.client, d, p.binding, { to: p.recipient!, amount: 70n * CKB }).catch((x) => x);
    expect(e).toBeInstanceOf(SessionBalanceError);
    expect(e).toMatchObject({ reason: "no-fee-cell" });
    expect(p.sent).toHaveLength(0);
  });

  it("the same payment goes through once the key cell can pay the fee, with only key-lock cells as key inputs", async () => {
    const sec = await new ccc.ClientPublicTestnet().getKnownScript(ccc.KnownScript.Secp256k1Blake160);
    const recipient = ccc.Script.from({ codeHash: sec.codeHash, hashType: sec.hashType, args: "0x" + "33".repeat(20) });
    const p = await setup({ maxPerTx: 100n * CKB, sessionCells: [500n * CKB], keyCells: [100n * CKB], recipient });
    await expect(spendInSession(p.session, p.client, d, p.binding, { to: p.recipient!, amount: 70n * CKB })).resolves.toMatch(/^0x/);
    const locks = await Promise.all(p.sent[0].inputs.map(async (i) => (await p.client.getCell(i.previousOutput))!.cellOutput.lock));
    expect(locks.every((l) => l.eq(p.lock) || l.eq(p.keyLock))).toBe(true);
  });
});

describe("review 24 Nov, 5: a payment is amount or token, never both", () => {
  it("refuses both, and neither, before anything is built (plain JS can pass them)", async () => {
    const p = await setup({ maxPerTx: 200n * CKB, sessionCells: [500n * CKB] });
    const to = ccc.Address.fromScript(p.ownerLock, p.client).toString();
    for (const request of [
      { to, amount: 50n * CKB, token: 1n, topUp: true },
      { to, amount: 50n * CKB, token: 1n },
      { to, topUp: true },
    ]) {
      const e = await spendInSession(p.session, p.client, d, p.binding, request as never).catch((x) => x);
      expect(e).toBeInstanceOf(ScopeError);
      expect(String(e)).toMatch(/either amount .* or token/);
    }
    expect(p.sent).toHaveLength(0);
  });
});

describe("review 24 Nov, 6: recovery leaves out token-session args under a legacy deployment", () => {
  it("a plain 128-byte-args cell planted under each legacy code is not found; the same args under the current code are", async () => {
    const p = await setup({ maxPerTx: 10n * CKB, sessionCells: [300n * CKB], keyCells: [] });
    const tokenArgs = { ownerLockHash: p.ownerLock.hash(), sessionLockHash: h("b4"), maxPerTx: 5n * CKB, token: { typeHash: h("c5"), maxPerTx: 3n } };
    const planted = TESTNET_LEGACY_DEPLOYMENTS.map((legacy, i) =>
      cellOf(h("f" + (i + 1)), 0, { lock: sessionLockScript(legacy, tokenArgs), capacity: 169n * CKB }),
    );
    expect(ccc.bytesFrom(planted[0].cellOutput.lock.args)).toHaveLength(128);
    const current = cellOf(h("f9"), 0, { lock: sessionLockScript(d, tokenArgs), capacity: 169n * CKB });
    p.chain.live.push(...planted, current);
    const found = await findOwnedSessionCells(p.owner, [d, ...TESTNET_LEGACY_DEPLOYMENTS]);
    const ids = found.map((c) => c.outPoint.txHash);
    expect(ids).toContain(h("a1")); // the owner's own session
    expect(ids).toContain(h("f9")); // a token-session cell the current lock can sweep
    for (const c of planted) expect(ids).not.toContain(c.outPoint.txHash);
  });
});

describe("review 24 Nov, 7: hardening", () => {
  it("the check hook gets a copy: what it changes is neither returned nor signed", async () => {
    const p = await setup({ maxPerTx: 200n * CKB, sessionCells: [500n * CKB] });
    const app = () => ccc.Transaction.from({ outputs: [{ lock: p.ownerLock, capacity: 150n * CKB }], outputsData: ["0x"] });
    const meddle = (tx: ccc.Transaction) => {
      tx.outputs[0].capacity += 40n * CKB; // after the kit's outflow checks
      tx.addOutput({ lock: p.ownerLock, capacity: 100n * CKB }, "0x");
    };
    const { tx, outflow } = await fundInSession(p.session, p.client, d, p.binding, app(), { check: meddle });
    expect(outflow).toBe(150n * CKB);
    expect(tx.outputs[0].capacity).toBe(150n * CKB);
    expect(tx.outputs).toHaveLength(3); // payment, change, key cell
    await sendWithSession(p.session, p.client, d, p.binding, async () => app(), { check: meddle });
    expect(p.sent[0].outputs.map((o) => o.capacity).slice(0, 2)).toEqual([150n * CKB, 350n * CKB]);
    expect(p.sent[0].outputs).toHaveLength(3);
  });
});

/** Just enough of IndexedDB for the store (as in store.test.ts). */
function fakeIdb(): IDBFactory {
  const backing = new Map<string, unknown>();
  const req = <T>(fn: () => T) => {
    const r: { result?: T; onsuccess?: () => void } = {};
    queueMicrotask(() => {
      r.result = fn();
      r.onsuccess?.();
    });
    return r;
  };
  const store = {
    get: (k: string) => req(() => backing.get(k)),
    put: (v: unknown, k: string) => req(() => void backing.set(k, v)),
    delete: (k: string) => req(() => void backing.delete(k)),
  };
  // A transaction completes once the requests made on it have run.
  const db = {
    transaction: () => {
      const tx: { objectStore: () => typeof store; oncomplete?: () => void; abort: () => void } = {
        objectStore: () => store,
        abort: () => {},
      };
      setTimeout(() => tx.oncomplete?.(), 0);
      return tx;
    },
    close: () => {},
  };
  return { open: () => req(() => db) } as unknown as IDBFactory;
}
