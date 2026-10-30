/**
 * Token sessions, client side: args layout, the xUDT checks, storage, spends
 * built against a mocked chain, and sweeps that return tokens instead of
 * burning them. The lock's own rules are tested in CKB-VM (session-lock.test.ts).
 */
import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionLockArgs, sessionLockScript, TESTNET_DEPLOYMENT as d } from "../src/lock.js";
import {
  assertPlainXudt,
  keyLockOf,
  matureCells,
  recoverSessions,
  SessionBalanceError,
  sessionLockOf,
  spendInSession,
  tokenAmount,
  type OnChainBinding,
} from "../src/onchain.js";
import { createSession, SessionPolicyError } from "../src/session.js";
import { deserializeSession, serializeSession } from "../src/store.js";
import { ScopeError } from "../src/transfer.js";

const CKB = 100_000_000n;
const h = (b: string) => ("0x" + b.repeat(32)) as ccc.Hex;
const client = new ccc.ClientPublicTestnet();
const amount = (v: bigint) => ccc.hexFrom(ccc.numLeToBytes(v, 16));
const xudtOf = async (args: string) =>
  ccc.Script.from({ ...(await client.getKnownScript(ccc.KnownScript.XUdt)), args });

afterEach(() => vi.restoreAllMocks());

describe("token session args", () => {
  const base = { ownerLockHash: h("01"), sessionLockHash: h("02"), maxPerTx: 5n * CKB };

  it("puts the token between the CKB limits and the recipient", () => {
    const token = { typeHash: h("07"), maxPerTx: (1n << 100n) + 3n };
    const bytes = ccc.bytesFrom(sessionLockArgs({ ...base, token }));
    expect(bytes.length).toBe(128);
    expect(ccc.hexFrom(bytes.slice(80, 112))).toBe(h("07"));
    expect(ccc.numLeFromBytes(bytes.slice(112, 128))).toBe(token.maxPerTx);
    const withRecipient = ccc.bytesFrom(sessionLockArgs({ ...base, token, recipientLockHash: h("09") }));
    expect(withRecipient.length).toBe(160);
    expect(ccc.hexFrom(withRecipient.slice(128))).toBe(h("09"));
  });

  it("refuses a token limit that is not a u128", () => {
    expect(() => sessionLockArgs({ ...base, token: { typeHash: h("07"), maxPerTx: 1n << 128n } })).toThrow(RangeError);
  });
});

describe("tokenAmount", () => {
  it("reads the u128 LE in the first 16 bytes and ignores extension data", () => {
    expect(tokenAmount(amount(1234n))).toBe(1234n);
    expect(tokenAmount(amount(7n) + "ffff")).toBe(7n);
  });

  it("refuses data under 16 bytes", () => {
    expect(() => tokenAmount("0x" + "00".repeat(15))).toThrow(RangeError);
  });
});

describe("assertPlainXudt", () => {
  it("accepts an xUDT with owner-only args, or with every flag clear", async () => {
    await expect(assertPlainXudt(await xudtOf(h("11")), client)).resolves.toBeUndefined();
    await expect(assertPlainXudt(await xudtOf(h("11") + "00000000"), client)).resolves.toBeUndefined();
  });

  // From the design review: extension scripts run code the owner did not choose.
  it("refuses an xUDT with extension flags, a non-xUDT type, and short args", async () => {
    await expect(assertPlainXudt(await xudtOf(h("11") + "01000000"), client)).rejects.toBeInstanceOf(SessionPolicyError);
    // Code review, 14 Oct: the owner-mode flags widen who may mint.
    for (const flags of ["00000080", "00000040", "00000020"]) {
      await expect(assertPlainXudt(await xudtOf(h("11") + flags), client)).rejects.toBeInstanceOf(SessionPolicyError);
    }
    const notXudt = ccc.Script.from({ ...(await client.getKnownScript(ccc.KnownScript.AnyoneCanPay)), args: h("11") });
    await expect(assertPlainXudt(notXudt, client)).rejects.toBeInstanceOf(SessionPolicyError);
    await expect(assertPlainXudt(await xudtOf("0x" + "11".repeat(20)), client)).rejects.toBeInstanceOf(SessionPolicyError);
  });
});

describe("a stored token session", () => {
  it("keeps its token through serialize and deserialize", async () => {
    const type = await xudtOf(h("11"));
    const s = createSession({ expiresAt: new Date(Date.now() + 60_000), scope: { maxPerTx: 5n * CKB } });
    s.onchain = {
      ownerLock: { codeHash: h("aa"), hashType: "type", args: ccc.hexFrom("0x" + "11".repeat(20)) },
      minInterval: 0n,
      token: { type: { codeHash: type.codeHash, hashType: type.hashType, args: type.args }, maxPerTx: 1n << 120n },
    };
    expect(deserializeSession(serializeSession(s)).onchain).toEqual(s.onchain);
  });
});

describe("spendInSession in a token session", () => {
  const T = 1_000_000n;
  const ownerLock = ccc.Script.from({ codeHash: h("aa"), hashType: "type", args: "0x" + "11".repeat(20) });
  let n = 0;
  const cellOf = (lock: ccc.Script, capacity: bigint, type?: ccc.Script, data: ccc.Hex = "0x") =>
    ccc.Cell.from({
      outPoint: { txHash: h("0" + (n++ % 10)), index: n },
      cellOutput: { lock, capacity, ...(type && { type }) },
      outputData: data,
    });

  /** A session holding `tokens` in one cell of `capacity`, and a chain that serves it. */
  async function setup(opts: { tokens: bigint; capacity: bigint; recipient?: boolean; minInterval?: bigint }) {
    const type = await xudtOf(h("33"));
    const acp = await client.getKnownScript(ccc.KnownScript.AnyoneCanPay);
    const recipientLock = ccc.Script.from({ codeHash: acp.codeHash, hashType: acp.hashType, args: "0x" + "44".repeat(20) });
    const recipient = ccc.Address.fromScript(recipientLock, client).toString();
    const session = createSession({
      expiresAt: new Date(Date.now() + 60 * 60_000),
      scope: { maxPerTx: 100n * CKB, ...(opts.recipient && { recipients: [recipient] }) },
    });
    const binding: OnChainBinding = {
      ownerLock: { codeHash: ownerLock.codeHash, hashType: ownerLock.hashType, args: ownerLock.args },
      minInterval: opts.minInterval ?? 0n,
      ...(opts.recipient && { recipientLockHash: recipientLock.hash() }),
      token: { type: { codeHash: type.codeHash, hashType: type.hashType, args: type.args }, maxPerTx: 10n * T },
    };
    const lock = await sessionLockOf(session, client, d, binding);
    const keyLock = await keyLockOf(session, client);
    const cells = [
      cellOf(lock, opts.capacity, type, amount(opts.tokens)),
      cellOf(keyLock, 62n * CKB),
      cellOf(recipientLock, 142n * CKB, type, amount(5n * T)),
      cellOf(recipientLock, 61n * CKB),
    ];
    vi.spyOn(client, "findCellsByLock").mockImplementation(async function* (l: ccc.ScriptLike) {
      for (const c of cells) if (c.cellOutput.lock.eq(l)) yield c;
    } as never);
    vi.spyOn(ccc.Transaction.prototype, "completeFeeChangeToOutput").mockResolvedValue(true as never);
    const sent: ccc.Transaction[] = [];
    vi.spyOn(ccc.SignerCkbPrivateKey.prototype, "signTransaction").mockImplementation(async (tx) => ccc.Transaction.from(tx));
    vi.spyOn(client, "sendTransaction").mockImplementation(async (tx) => {
      sent.push(ccc.Transaction.from(tx));
      return h("ee");
    });
    return { session, binding, recipient, lock, keyLock, type, sent, cells };
  }

  it("tops up the recipient's token cell, keeping the rest of the tokens and all the CKB", async () => {
    const { session, binding, recipient, lock, type, sent } = await setup({ tokens: 100n * T, capacity: 300n * CKB, recipient: true });
    let recorded: ccc.Hex | undefined;
    const hash = await spendInSession(session, client, d, binding, {
      to: recipient,
      token: 3n * T,
      topUp: true,
      beforeSend: async (txHash) => void (recorded = txHash),
    });
    const [tx] = sent;
    // The payment is recorded against its final hash before it is sent (hardening review M2).
    expect(recorded).toBe(tx.hash());
    expect(hash).toBe(h("ee"));
    expect(tx.outputs[0].type?.eq(type)).toBe(true);
    expect(tx.outputs[0].capacity).toBe(142n * CKB);
    expect(tokenAmount(tx.outputsData[0])).toBe(8n * T);
    expect(tx.outputs[1].lock.eq(lock)).toBe(true);
    expect(tx.outputs[1].capacity).toBe(300n * CKB);
    expect(tx.outputsData[1]).toBe(amount(97n * T)); // exactly 16 bytes, as the lock requires
  });

  it("a CKB payment from a cell holding tokens returns them in the change", async () => {
    const { session, binding, recipient, type, sent } = await setup({ tokens: 100n * T, capacity: 400n * CKB, recipient: true });
    await spendInSession(session, client, d, binding, { to: recipient, amount: 2n * CKB, topUp: true });
    const [tx] = sent;
    expect(tx.outputs[0].type).toBeUndefined(); // the plain ACP cell
    expect(tx.outputs[0].capacity).toBe(63n * CKB);
    expect(tx.outputs[1].type?.eq(type)).toBe(true);
    expect(tx.outputsData[1]).toBe(amount(100n * T));
    expect(tx.outputs[1].capacity).toBe(398n * CKB);
  });

  it("refuses a CKB payment that would leave the token change too small to exist", async () => {
    const { session, binding, recipient } = await setup({ tokens: 100n * T, capacity: 300n * CKB, recipient: true });
    await expect(
      spendInSession(session, client, d, binding, { to: recipient, amount: 20n * CKB, topUp: true }),
    ).rejects.toThrow(/still holds tokens/);
  });

  it("refuses more tokens than the session's token maxPerTx", async () => {
    const { session, binding, recipient } = await setup({ tokens: 100n * T, capacity: 250n * CKB });
    await expect(
      spendInSession(session, client, d, binding, { to: recipient, token: 10n * T + 1n, topUp: true }),
    ).rejects.toBeInstanceOf(ScopeError);
  });

  it("refuses a new token cell whose capacity is over maxPerTx", async () => {
    const { session, binding, recipient } = await setup({ tokens: 100n * T, capacity: 500n * CKB });
    await expect(spendInSession(session, client, d, binding, { to: recipient, token: 1n * T })).rejects.toThrow(
      /over maxPerTx/,
    );
  });

  // Code review, 14 Oct (L2): anyone can plant a fresh cell under the session lock;
  // picking it would make a rate-limited spend fail on chain.
  it("with a rate limit, spends only cells old enough and skips a freshly planted one", async () => {
    const { session, binding, recipient, lock, type, sent, cells } = await setup({
      tokens: 100n * T,
      capacity: 300n * CKB,
      recipient: true,
      minInterval: 10n,
    });
    const planted = cellOf(lock, 300n * CKB, type, amount(1n));
    cells.unshift(planted);
    vi.spyOn(client, "getTip").mockResolvedValue(1000n);
    vi.spyOn(client, "getTransaction").mockImplementation(async (hash: ccc.HexLike) =>
      ({ blockNumber: ccc.hexFrom(hash) === planted.outPoint.txHash ? 995n : 900n }) as never,
    );
    await spendInSession(session, client, d, binding, { to: recipient, token: 3n * T, topUp: true });
    const [tx] = sent;
    expect(tx.inputs.some((i) => i.previousOutput.eq(planted.outPoint))).toBe(false);
    expect(tx.inputs[0].since).toBe((1n << 63n) | 10n);
  });

  it("with a rate limit and no cell old enough, says so instead of sending a doomed spend", async () => {
    const { session, binding, recipient } = await setup({ tokens: 100n * T, capacity: 300n * CKB, recipient: true, minInterval: 10n });
    vi.spyOn(client, "getTip").mockResolvedValue(1000n);
    vi.spyOn(client, "getTransaction").mockResolvedValue({ blockNumber: 995n } as never);
    await expect(
      spendInSession(session, client, d, binding, { to: recipient, token: 3n * T, topUp: true }),
    ).rejects.toThrow(/rate limited/);
  });

  it("refuses more tokens than the session holds", async () => {
    const { session, binding, recipient } = await setup({ tokens: 2n * T, capacity: 250n * CKB });
    await expect(
      spendInSession(session, client, d, binding, { to: recipient, token: 3n * T, topUp: true }),
    ).rejects.toBeInstanceOf(SessionBalanceError);
  });
});

describe("recoverSessions with token sessions", () => {
  const ownerLock = ccc.Script.from({ codeHash: h("aa"), hashType: "type", args: "0x" + "11".repeat(20) });

  it("sweeps token cells back as tokens, and skips cells that could block the sweep", async () => {
    const token = await xudtOf(h("33"));
    const foreign = await xudtOf(h("34"));
    const tokenLock = sessionLockScript(d, {
      ownerLockHash: ownerLock.hash(),
      sessionLockHash: h("b1"),
      maxPerTx: 5n * CKB,
      token: { typeHash: token.hash(), maxPerTx: 10n },
    });
    const plainLock = sessionLockScript(d, { ownerLockHash: ownerLock.hash(), sessionLockHash: h("b2"), maxPerTx: 5n * CKB });
    let i = 0;
    const cell = (lock: ccc.Script, capacity: bigint, type?: ccc.Script, data: ccc.Hex = "0x") =>
      ccc.Cell.from({
        outPoint: { txHash: h("0" + i), index: i++ },
        cellOutput: { lock, capacity, ...(type && { type }) },
        outputData: data,
      });
    const cells = [
      cell(tokenLock, 300n * CKB, token, amount(70n)),
      cell(tokenLock, 300n * CKB, token, ccc.hexFrom(amount(30n) + "aa")), // extension bytes: still the token
      cell(tokenLock, 200n * CKB), // untyped CKB in a token session
      cell(tokenLock, 250n * CKB, foreign, amount(1n)), // planted: another token
      cell(tokenLock, 250n * CKB, token, "0x01"), // planted: malformed token data
      cell(plainLock, 250n * CKB, token, amount(5n)), // planted: a token in a plain session
    ];
    const sent: ccc.Transaction[] = [];
    const owner = {
      client: {
        async *findCells(key: { script: ccc.ScriptLike }) {
          const prefix = ccc.Script.from(key.script).args;
          for (const c of cells) if (c.cellOutput.lock.args.startsWith(prefix)) yield c;
        },
      },
      getRecommendedAddressObj: async () => ({ script: ownerLock }),
      async *findCells() {
        yield ccc.Cell.from({ outPoint: { txHash: h("09"), index: 9 }, cellOutput: { lock: ownerLock, capacity: 100n * CKB }, outputData: "0x" });
      },
      signTransaction: async (tx: ccc.Transaction) => tx,
    } as unknown as ccc.Signer;
    Object.assign(owner.client, {
      sendTransaction: async (tx: ccc.Transaction) => {
        sent.push(tx);
        return h("ee");
      },
    });
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    vi.spyOn(ccc.Transaction.prototype, "addCellDepsOfKnownScripts").mockResolvedValue(undefined as never);

    expect(await recoverSessions(owner, d)).toMatchObject({ recovered: 800n * CKB, cells: 3, failed: 0 });
    const [tx] = sent;
    expect(tx.inputs.map((x) => Number(x.previousOutput.index))).toEqual([0, 1, 2, 9]);
    expect(tx.outputs).toHaveLength(1);
    expect(tx.outputs[0].lock.eq(ownerLock)).toBe(true);
    expect(tx.outputs[0].type?.eq(token)).toBe(true);
    expect(tx.outputsData[0]).toBe(amount(100n));
  });

  // Review, 28 Oct: planted cells whose tokens overflow a u128 with the owner's
  // must not block the sweep, even when each is smaller than the owner's cell.
  it("leaves out planted cells that would overflow the token sum, keeping the owner's own", async () => {
    const token = await xudtOf(h("33"));
    const lock = sessionLockScript(d, {
      ownerLockHash: ownerLock.hash(),
      sessionLockHash: h("b1"),
      maxPerTx: 5n * CKB,
      token: { typeHash: token.hash(), maxPerTx: 10n },
    });
    const strangerLock = ccc.Script.from({ codeHash: h("aa"), hashType: "type", args: "0x" + "66".repeat(20) });
    const at = (i: number, l: ccc.Script, capacity: bigint, data: ccc.Hex = "0x", type?: ccc.Script) =>
      ccc.Cell.from({ outPoint: { txHash: h("0" + i), index: i }, cellOutput: { lock: l, capacity, ...(type && { type }) }, outputData: data });
    const half = 1n << 127n;
    const planted = [at(1, lock, 142n * CKB, amount(half - 1n), token), at(2, lock, 142n * CKB, amount(half - 1n), token)];
    const mine = at(3, lock, 300n * CKB, amount(half), token);
    const ownCell = at(7, ownerLock, 500n * CKB);
    const strangerCell = at(8, strangerLock, 500n * CKB);
    const cells = [...planted, mine];
    const sent: ccc.Transaction[] = [];
    const owner = {
      client: {
        async *findCells(key: { script: ccc.ScriptLike }) {
          const prefix = ccc.Script.from(key.script).args;
          for (const c of cells) if (c.cellOutput.lock.args.startsWith(prefix)) yield c;
        },
        // The owner's cell was funded by the owner; the planted ones by a stranger.
        getTransaction: async (hash: ccc.HexLike) => ({
          transaction: ccc.Transaction.from({
            inputs: [{ previousOutput: (ccc.hexFrom(hash) === h("03") ? ownCell : strangerCell).outPoint }],
          }),
        }),
        getCell: async (op: ccc.OutPointLike) => [ownCell, strangerCell].find((c) => c.outPoint.eq(ccc.OutPoint.from(op))),
      },
      getRecommendedAddressObj: async () => ({ script: ownerLock }),
      async *findCells() {
        yield at(9, ownerLock, 100n * CKB);
      },
      signTransaction: async (tx: ccc.Transaction) => tx,
    } as unknown as ccc.Signer;
    Object.assign(owner.client, {
      sendTransaction: async (tx: ccc.Transaction) => {
        sent.push(tx);
        return h("ee");
      },
    });
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockResolvedValue([0, false] as never);
    vi.spyOn(ccc.Transaction.prototype, "addCellDepsOfKnownScripts").mockResolvedValue(undefined as never);

    expect(await recoverSessions(owner, d)).toMatchObject({ cells: 2, failed: 0 });
    const [tx] = sent;
    expect(tx.inputs.some((x) => x.previousOutput.eq(mine.outPoint))).toBe(true);
    expect(tx.outputsData[0]).toBe(amount(half + half - 1n));
  });
});

describe("matureCells", () => {
  it("keeps cells at least `blocks` blocks below the tip, and drops unknown ones", async () => {
    const lock = ccc.Script.from({ codeHash: h("aa"), hashType: "type", args: "0x" });
    const at = (i: number) =>
      ccc.Cell.from({ outPoint: { txHash: h("0" + i), index: 0 }, cellOutput: { lock, capacity: 61n * CKB }, outputData: "0x" });
    const born: Record<string, bigint | undefined> = { [h("01")]: 990n, [h("02")]: 991n, [h("03")]: undefined };
    vi.spyOn(client, "getTip").mockResolvedValue(1000n);
    vi.spyOn(client, "getTransaction").mockImplementation(async (hash: ccc.HexLike) => {
      const b = born[ccc.hexFrom(hash)];
      return (b === undefined ? undefined : { blockNumber: b }) as never;
    });
    const kept = await matureCells(client, [at(1), at(2), at(3)], 10n);
    expect(kept.map((c) => c.outPoint.txHash)).toEqual([h("01")]);
  });
});
