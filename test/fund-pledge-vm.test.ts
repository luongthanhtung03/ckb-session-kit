/**
 * A CrowdCell pledge funded from a session, run in the real CKB-VM (ckb-testtool
 * and ckb-debugger), with the session lock binary and CrowdCell's own five
 * scripts as its live testnet frontend uses them (scripts/fetch-crowdcell.ts).
 *
 * The transaction is the one `fundInSession` builds: the app part has the shape
 * of the live pledge 0xd4602458... (campaign cell in and carried forward with
 * total_pledged raised, pledge cell under pledge-lock, receipt under the
 * wallet's lock), and the kit adds the session cells, change and key cell. Each
 * script group then runs on its own: the session lock, campaign lock, campaign
 * type, pledge type and receipt type. The key cell's secp256k1 lock is not run
 * (its code is not in the mock chain); signing is covered in test/fund.test.ts.
 *
 * The other cases take that transaction and change one thing, to show what
 * `fundInSession` refuses and why (plan section 4, cases 2-6).
 */
import { ccc } from "@ckb-ccc/core";
import { Resource, Verifier } from "ckb-testtool";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TESTNET_DEPLOYMENT, type SessionLockDeployment } from "../src/lock.js";
import { fundInSession, keyLockOf, sessionLockOf, type OnChainBinding } from "../src/onchain.js";
import { createSession, type Session } from "../src/session.js";

const SESSION_BINARY = "contracts/session-lock/target/riscv64imac-unknown-none-elf/release/session-lock";
const CC = "test/fixtures/crowdcell/";
const CC_NAMES = ["campaign", "campaignLock", "pledge", "pledgeLock", "receipt"] as const;
const skip = (!existsSync(SESSION_BINARY) || CC_NAMES.some((n) => !existsSync(CC + n))) && !process.env.REQUIRE_LOCK_TESTS;

const CKB = 100_000_000n;
const PLEDGE = 100n * CKB;
const PLEDGE_OVERHEAD = 252n * CKB;
/** What the live frontend puts in a receipt (300 CKB, block 22,942,266), not the 262 CKB of the source at 2fd13f6. */
const RECEIPT = 300n * CKB;
const PER_PLEDGE = PLEDGE + PLEDGE_OVERHEAD + RECEIPT;
const DEADLINE = 23_000_000n;
/** Session lock error codes (contracts/session-lock/src/main.rs). */
const E = { OUTFLOW_EXCEEDED: 12, RECIPIENT_NOT_ALLOWED: 13, RATE_LIMITED: 14, TOO_MANY_CHANGE_CELLS: 16, TYPED_CELL: 18 };

type TtTransaction = Parameters<Resource["deployCell"]>[1];
type TtScript = Parameters<Resource["mockCell"]>[0];
const tt = <T>(x: unknown) => x as T;
const u64le = (v: bigint) => ccc.hexFrom(ccc.numLeToBytes(v, 8)).slice(2);

interface Terms {
  maxPerTx?: bigint;
  minInterval?: bigint;
  recipientLockHash?: ccc.Hex;
}

/** The mock chain: CrowdCell's code, the session lock, a campaign, and a session holding `budget`. */
function world() {
  const resource = Resource.default();
  const deps = ccc.Transaction.default();
  const deploy = (path: string) => tt<ccc.Script>(resource.deployCell(ccc.hexFrom(readFileSync(path)), tt<TtTransaction>(deps), false));
  const sessionCode = deploy(SESSION_BINARY);
  const code = Object.fromEntries(CC_NAMES.map((n) => [n, deploy(CC + n)])) as Record<(typeof CC_NAMES)[number], ccc.Script>;
  const at = (s: ccc.Script, args: ccc.HexLike) => ccc.Script.from({ codeHash: s.codeHash, hashType: s.hashType, args });
  const deployment: SessionLockDeployment = {
    codeHash: sessionCode.codeHash,
    hashType: sessionCode.hashType,
    cellDep: deps.cellDeps[0],
  };
  const mock = (lock: ccc.ScriptLike, type: ccc.ScriptLike | undefined, data: ccc.HexLike, capacity: bigint) =>
    tt<ccc.Cell>(
      resource.mockCell(
        tt<TtScript>(ccc.Script.from(lock)),
        type && tt<TtScript>(ccc.Script.from(type)),
        ccc.hexFrom(data),
        capacity,
      ),
    );

  const client = new ccc.ClientPublicTestnet();
  const cells = () => [...resource.cells.values()] as unknown as ccc.Cell[];
  const c = client as unknown as Record<string, unknown>;
  c.getCell = async (op: ccc.OutPointLike) => cells().find((x) => x.outPoint.eq(ccc.OutPoint.from(op)))?.clone();
  c.findCellsPagedNoCache = async (k: ccc.ClientIndexerSearchKeyLike) => {
    const key = ccc.ClientIndexerSearchKey.from(k);
    return { cells: cells().filter((x) => x.cellOutput.lock.eq(key.script)), lastCursor: "0x" };
  };
  c.getTip = async () => DEADLINE - 1000n;
  c.getTransactionNoCache = async () =>
    ccc.ClientTransactionResponse.from({ transaction: {}, status: "committed", blockNumber: DEADLINE - 2000n });

  return { resource, deps, code, at, deployment, mock, client };
}

type World = ReturnType<typeof world>;

async function sessionIn(w: World, terms: Terms, budget: bigint[]) {
  const s = await w.client.getKnownScript(ccc.KnownScript.Secp256k1Blake160);
  const ownerLock = ccc.Script.from({ codeHash: s.codeHash, hashType: s.hashType, args: "0x" + "11".repeat(20) });
  const session = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: terms.maxPerTx ?? PER_PLEDGE } });
  const binding: OnChainBinding = {
    ownerLock: { codeHash: ownerLock.codeHash, hashType: ownerLock.hashType, args: ownerLock.args },
    minInterval: terms.minInterval ?? 0n,
    ...(terms.recipientLockHash && { recipientLockHash: terms.recipientLockHash }),
  };
  const lock = await sessionLockOf(session, w.client, w.deployment, binding);
  const keyLock = await keyLockOf(session, w.client);
  for (const b of budget) w.mock(lock, undefined, "0x", b);
  w.mock(keyLock, undefined, "0x", 100n * CKB);
  return { session, binding, lock, keyLock, ownerLock };
}

/** A campaign cell as CrowdCell creates one (tx 0xa4980c63...), with a title and a description. */
function campaign(w: World, creator: ccc.Hex) {
  const typeId = "0x" + "ba".repeat(32);
  const lock = w.at(w.code.campaignLock, "0x" + u64le(DEADLINE));
  const type = w.at(w.code.campaign, typeId + w.code.pledgeLock.codeHash.slice(2));
  const text = (t: string) => {
    const b = ccc.bytesFrom(t, "utf8");
    return ccc.hexFrom(ccc.numLeToBytes(b.length, 2)).slice(2) + ccc.hexFrom(b).slice(2);
  };
  const data = (total: bigint) =>
    creator + u64le(1_000_000n * CKB) + u64le(DEADLINE) + u64le(total) + "00" + "00".repeat(8) + text("session test") + text("pledges funded from a session");
  const cell = w.mock(lock, type, data(0n), 405n * CKB);
  return { cell, lock, type, data };
}

/** The pledge transaction CrowdCell's frontend builds, before the wallet (here: the session) funds it. */
function pledgeTx(w: World, camp: ReturnType<typeof campaign>, backer: ccc.Script) {
  const typeHash = camp.type.hash().slice(2);
  const backerHash = backer.hash().slice(2);
  const linkage = "a4".repeat(32);
  return ccc.Transaction.from({
    inputs: [{ previousOutput: camp.cell.outPoint }],
    outputs: [
      { lock: camp.lock, type: camp.type, capacity: camp.cell.cellOutput.capacity },
      {
        lock: w.at(w.code.pledgeLock, "0x" + typeHash + u64le(DEADLINE) + backerHash),
        type: w.at(w.code.pledge, w.code.receipt.codeHash),
        capacity: PLEDGE + PLEDGE_OVERHEAD,
      },
      {
        lock: backer,
        type: w.at(w.code.receipt, w.code.pledge.codeHash + w.code.pledgeLock.codeHash.slice(2)),
        capacity: RECEIPT,
      },
    ],
    outputsData: [
      camp.data(PLEDGE),
      "0x" + linkage + backerHash + u64le(PLEDGE),
      "0x" + u64le(PLEDGE) + backerHash + typeHash + u64le(DEADLINE),
    ],
    cellDeps: w.deps.cellDeps.slice(1), // CrowdCell's five
    witnesses: ["0x"],
  });
}

/** The cell deps the mock chain does not hold (secp256k1's dep group) are dropped: that lock is not run. */
function verifier(w: World, tx: ccc.Transaction) {
  const run = tx.clone();
  run.cellDeps = run.cellDeps.filter((d) => [...w.resource.cells.values()].some((c) => (c as unknown as ccc.Cell).outPoint.eq(d.outPoint)));
  return Verifier.from(w.resource, tt<TtTransaction>(run));
}

/** Runs each named script group on its own; all must pass. Returns the cycles. */
async function passes(w: World, tx: ccc.Transaction, scripts: ccc.Script[]) {
  let cycles = 0;
  for (const s of scripts) {
    const ran = await verifier(w, tx).verifySuccess(false, { codeHash: s.hash() });
    expect(ran, `script ${s.codeHash} ran`).toBeGreaterThan(0); // the filter matched a group, which then passed
    cycles += ran;
  }
  return cycles;
}

/** The funded transaction with its session cells and change moved under `lock` (another scope for the same key). */
function underLock(w: World, tx: ccc.Transaction, from: ccc.Script, to: ccc.Script) {
  const moved = tx.clone();
  const cells = [...w.resource.cells.values()] as unknown as ccc.Cell[];
  for (const input of moved.inputs) {
    const cell = cells.find((c) => c.outPoint.eq(input.previousOutput));
    if (!cell?.cellOutput.lock.eq(from)) continue;
    input.previousOutput = w.mock(to, undefined, "0x", cell.cellOutput.capacity).outPoint;
  }
  for (const o of moved.outputs) if (o.lock.eq(from)) o.lock = to;
  return moved;
}

async function funded(terms: Terms = {}, budget = [1000n * CKB]) {
  const w = world();
  const s = await sessionIn(w, terms, budget);
  const camp = campaign(w, s.ownerLock.hash());
  const app = pledgeTx(w, camp, s.ownerLock);
  const { tx, outflow } = await fundInSession(s.session, w.client, w.deployment, s.binding, app);
  const groups = [s.lock, camp.lock, camp.type, app.outputs[1].type!, app.outputs[2].type!];
  return { w, s, camp, app, tx, outflow, groups };
}

/** The same session key under other terms: the lock script a different scope would give it. */
async function relocked(session: Session, w: World, binding: OnChainBinding, terms: Terms) {
  return sessionLockOf(
    { ...session, policy: { ...session.policy, scope: { maxPerTx: terms.maxPerTx ?? session.policy.scope.maxPerTx } } },
    w.client,
    w.deployment,
    { ...binding, ...terms },
  );
}

describe.skipIf(skip)("a CrowdCell pledge funded from a session, in the CKB-VM", () => {
  it("the session lock under test is the deployed one, byte for byte", () => {
    const w = world();
    expect(w.deployment.codeHash).toBe(TESTNET_DEPLOYMENT.codeHash);
    expect(w.deployment.hashType).toBe(TESTNET_DEPLOYMENT.hashType);
  });

  it("passes every script: session lock, campaign lock, campaign type, pledge type, receipt type", async () => {
    const f = await funded();
    expect(f.outflow).toBe(PER_PLEDGE);
    const cycles = await passes(f.w, f.tx, f.groups);
    expect(cycles).toBeGreaterThan(0);
  });

  it("passes at outflow exactly maxPerTx with nothing left (the whole session spent)", async () => {
    const f = await funded({}, [PER_PLEDGE]);
    expect(f.tx.outputs.some((o) => o.lock.eq(f.s.lock))).toBe(false);
    await passes(f.w, f.tx, f.groups);
  });

  it("rate limited: since on the session cells and 0 on the campaign cell passes; since too low fails with 14", async () => {
    const f = await funded({ minInterval: 10n });
    expect(f.tx.inputs[0].since).toBe(0n);
    await passes(f.w, f.tx, f.groups);
    const low = f.tx.clone();
    for (const i of low.inputs) if (i.since !== 0n) i.since = (1n << 63n) | 9n;
    await verifier(f.w, low).verifyFailure(E.RATE_LIMITED, false, { codeHash: f.s.lock.hash() });
  });

  it("one shannon over maxPerTx fails with 12", async () => {
    const f = await funded();
    const tighter = await relocked(f.s.session, f.w, f.s.binding, { maxPerTx: PER_PLEDGE - 1n });
    const tx = underLock(f.w, f.tx, f.s.lock, tighter);
    await verifier(f.w, tx).verifyFailure(E.OUTFLOW_EXCEEDED, false, { codeHash: tighter.hash() });
  });

  it("a recipient-scoped session cannot fund it: 13 for an output to another lock, 18 for a typed one to the recipient", async () => {
    const f = await funded();
    const pledgeLock = f.app.outputs[1].lock;
    // Recipient = the pledge lock, or the owner: the campaign output (campaign lock) is neither.
    for (const recipient of [pledgeLock.hash(), f.s.ownerLock.hash()]) {
      const scoped = await relocked(f.s.session, f.w, f.s.binding, { recipientLockHash: recipient });
      await verifier(f.w, underLock(f.w, f.tx, f.s.lock, scoped)).verifyFailure(E.RECIPIENT_NOT_ALLOWED, false, { codeHash: scoped.hash() });
    }
    // Recipient = the campaign lock: the campaign output is the recipient's, but typed.
    const scoped = await relocked(f.s.session, f.w, f.s.binding, { recipientLockHash: f.camp.lock.hash() });
    await verifier(f.w, underLock(f.w, f.tx, f.s.lock, scoped)).verifyFailure(E.TYPED_CELL, false, { codeHash: scoped.hash() });
  });

  it("two change cells fail with 16; a typed change cell with 18", async () => {
    const f = await funded();
    const change = f.tx.outputs.findIndex((o) => o.lock.eq(f.s.lock));
    const split = f.tx.clone();
    const half = split.outputs[change].capacity / 2n;
    split.outputs[change].capacity -= half;
    split.outputs.splice(change, 0, ccc.CellOutput.from({ lock: f.s.lock, capacity: half }));
    split.outputsData.splice(change, 0, "0x");
    await verifier(f.w, split).verifyFailure(E.TOO_MANY_CHANGE_CELLS, false, { codeHash: f.s.lock.hash() });

    const typed = f.tx.clone();
    typed.outputs[change].type = f.app.outputs[2].type;
    await verifier(f.w, typed).verifyFailure(E.TYPED_CELL, false, { codeHash: f.s.lock.hash() });
  });

  it("a wallet input switches the lock to owner mode: over maxPerTx then passes, which is why fundInSession refuses one", async () => {
    const f = await funded();
    const tighter = await relocked(f.s.session, f.w, f.s.binding, { maxPerTx: 1n * CKB });
    const tx = underLock(f.w, f.tx, f.s.lock, tighter);
    await verifier(f.w, tx).verifyFailure(E.OUTFLOW_EXCEEDED, false, { codeHash: tighter.hash() });
    const wallet = f.w.mock(f.s.ownerLock, undefined, "0x", 100n * CKB);
    tx.inputs.push(ccc.CellInput.from({ previousOutput: wallet.outPoint }));
    tx.outputs.push(ccc.CellOutput.from({ lock: f.s.ownerLock, capacity: 100n * CKB }));
    tx.outputsData.push("0x");
    await verifier(f.w, tx).verifySuccess(false, { codeHash: tighter.hash() });
  });

  it("CrowdCell's own scripts refuse a pledge whose campaign total is not raised by it (the app part is checked for real)", async () => {
    const f = await funded();
    const wrong = f.tx.clone();
    wrong.outputsData[0] = ccc.hexFrom(f.camp.data(PLEDGE + 1n));
    const result = await verifier(f.w, wrong).verify({ codeHash: f.camp.type.hash() });
    expect(result.some((r) => r.status !== 0)).toBe(true);
  });
});
