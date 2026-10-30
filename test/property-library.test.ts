/**
 * Library and lock agree: every transaction the TypeScript library builds and
 * signs (spendInSession in CKB and tokens, with and without topUp, closeSession,
 * recoverSessions, chargeSubscription, cancelSubscription) for random valid
 * policies, balances and intervals is accepted by the real session lock in
 * CKB-VM. Then single mutations of each accepted transaction are refused with the
 * code the docs give (or accepted where the docs say so), and always with the
 * code of the independent model in test/fuzz/harness.ts.
 *
 * Seeded: FUZZ_SEED / FUZZ_SCALE change the run; FUZZ_SEED=<seed> FUZZ_ONE=1
 * replays one case. A library refusal (ScopeError, SessionBalanceError,
 * SessionPolicyError) is not a failure: the property is about what it does build.
 */
import { ccc } from "@ckb-ccc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSession, keyLockOf, recoverSessions, sessionLockOf, spendInSession, type OnChainBinding } from "../src/onchain.js";
import { createSession, type Session } from "../src/session.js";
import { cancelSubscription, chargeSubscription, subscriptionLock, type Subscription } from "../src/subscription.js";
import {
  CKB,
  Cells,
  compare,
  DEPLOYMENT,
  fakeClient,
  isSessionLock,
  model,
  modelOf,
  Rng,
  SCALE,
  SEED,
  skipLock,
  U128_MAX,
  U64_MAX,
} from "./fuzz/harness.js";

const ONE = !!process.env.FUZZ_ONE;
const NOW = new Date("2026-10-31T00:00:00Z");
const MAX_INTERVAL = (1n << 56n) - 1n;
const relativeBlocks = (n: bigint) => (1n << 63n) | n;

afterEach(() => vi.restoreAllMocks());

type Client = ccc.Client;
const secp = async (client: Client, rng: Rng) => {
  const signer = new ccc.SignerCkbPrivateKey(client, rng.hex(32));
  return { signer, lock: (await signer.getRecommendedAddressObj()).script };
};
const acpLock = async (client: Client, rng: Rng) =>
  ccc.Script.from({ ...(await client.getKnownScript(ccc.KnownScript.AnyoneCanPay)), args: rng.hex(20) });
const xudtType = async (client: Client, rng: Rng) =>
  ccc.Script.from({ ...(await client.getKnownScript(ccc.KnownScript.XUdt)), args: rng.hex(32) });
const addr = (lock: ccc.Script, client: Client) => ccc.Address.fromScript(lock, client).toString();
const tokenData = (v: bigint) => ccc.hexFrom(ccc.numLeToBytes(v, 16));

const REFUSALS = ["ScopeError", "SessionBalanceError", "SessionPolicyError"];
/**
 * Plain errors the library lets through from CCC: none since the fixes of 31 Oct.
 * Round 2 saw two, a refusal all the same (nothing built or sent) but not one a
 * caller could tell by its class or `reason`, and both are now typed:
 * - "Insufficient CKB" (key or charger cell above its floor but short of the
 *   fee) is a SessionBalanceError "no-fee-cell";
 * - "number overflow" (a token top-up taking the payee's cell past a u128 in
 *   addTopUp) is a SessionBalanceError "no-payout-cell", or another cell is used.
 * Any plain error now counts as UNEXPECTED and fails the run.
 */
const KNOWN_PLAIN: RegExp[] = [];

/** What a scenario built, and which roles its transactions' cells play. */
interface Built {
  cells: Cells;
  sent: ccc.Transaction[];
  /** The session-mode transaction to mutate, if any, with its roles. */
  roles?: { session: ccc.Script; key: ccc.Script; owner: ccc.Script; recipient?: ccc.Script; token?: ccc.Script };
  label: string;
  /** For an owner-mode sweep: the owner's lock. */
  owner?: ccc.Script;
}

// ---------------------------------------------------------------------------
// Scenarios: random valid inputs to each library entry point.

async function sessionScenario(rng: Rng, kind: "ckb" | "ckb-topup" | "token" | "token-topup" | "ckb-in-token" | "close" | "recover"): Promise<Built> {
  const cells = new Cells(rng);
  const { client, sent } = fakeClient(cells);
  const owner = await secp(client, rng);
  const tokenSession = kind.startsWith("token") || kind === "ckb-in-token" || ((kind === "close" || kind === "recover") && rng.bool(0.4));
  const topUp = kind.endsWith("topup");
  const token = tokenSession ? await xudtType(client, rng) : undefined;

  // The recipient: an anyone-can-pay address for a top-up, else a plain one.
  const recipientLock = topUp ? await acpLock(client, rng) : rng.bool(0.8) ? (await secp(client, rng)).lock : await acpLock(client, rng);
  const recipientTo = addr(recipientLock, client);
  const withRecipient = rng.bool(0.6);

  const maxPerTx = rng.edgy(61n * CKB, U64_MAX, [61n * CKB, 100n * CKB, 143n * CKB, 1000n * CKB]);
  const minInterval = rng.pick([0n, 0n, 1n, rng.edgy(0n, MAX_INTERVAL, [10n, 100n])]);
  const tokenMax = rng.edgy(1n, U128_MAX, [1n, 1000n, U64_MAX]);
  const session = createSession(
    { expiresAt: new Date(NOW.getTime() + 3_600_000), scope: { maxPerTx, ...(withRecipient && { recipients: [recipientTo] }) } },
    { now: NOW, randomBytes: (n) => rng.bytes(n) },
  );
  const binding: OnChainBinding = {
    ownerLock: { codeHash: owner.lock.codeHash, hashType: owner.lock.hashType, args: owner.lock.args },
    minInterval,
    ...(withRecipient && { recipientLockHash: recipientLock.hash() }),
    ...(token && { token: { type: { codeHash: token.codeHash, hashType: token.hashType, args: token.args }, maxPerTx: tokenMax } }),
  };
  const lock = await sessionLockOf(session, client, DEPLOYMENT, binding);
  const keyLock = await keyLockOf(session, client);

  // Session cells: 1 to 3, mature (mostly), CKB near the 61 CKB floors, tokens near the u128 edges.
  const n = rng.int(1, 3);
  let tokenTotal = 0n;
  let ckbTotal = 0n;
  for (let i = 0; i < n; i++) {
    const typed = token && rng.bool(0.8);
    const floor = typed ? 143n * CKB : 61n * CKB; // occupied: 8 + lock (32+1+160) + type (32+1+32) + 16 data
    const amount = typed ? rng.edgy(0n, (U128_MAX - tokenTotal) / 2n, [1n, tokenMax, tokenMax + 1n, 1000n]) : 0n;
    tokenTotal += amount;
    const age = rng.bool(0.9) ? rng.edgy(minInterval, minInterval + 100n) : rng.big(0n, minInterval);
    const capacity = rng.edgy(floor, 5000n * CKB, [floor, floor + 1n, 2n * floor, maxPerTx]);
    ckbTotal += capacity;
    cells.add({
      lock,
      capacity,
      ...(typed && { type: token, data: tokenData(amount) }),
      age,
    });
  }
  // Key cells: at least one above the floor plus a fee.
  const keyCount = rng.int(1, 2);
  for (let i = 0; i < keyCount; i++) cells.add({ lock: keyLock, capacity: rng.edgy(61n * CKB, 200n * CKB, [62n * CKB, 61n * CKB + 100_000n]) });
  // The owner's plain cell (needed for a sweep) and the recipient's cells (for a top-up).
  cells.add({ lock: owner.lock, capacity: rng.edgy(62n * CKB, 1000n * CKB) });
  if (topUp || rng.bool(0.3)) {
    cells.add({ lock: recipientLock, capacity: rng.edgy(61n * CKB, 500n * CKB) });
    if (token) cells.add({ lock: recipientLock, capacity: 143n * CKB, type: token, data: tokenData(rng.edgy(0n, 1000n)) });
  }

  const roles = { session: lock, key: keyLock, owner: owner.lock, ...(withRecipient && { recipient: recipientLock }), token };
  const label = `${kind} max=${maxPerTx} interval=${minInterval} recipient=${withRecipient}${token ? ` tokenMax=${tokenMax}` : ""}`;

  if (kind === "close") {
    await closeSession(owner.signer, session, DEPLOYMENT, binding);
    return { cells, sent, label, owner: owner.lock };
  }
  if (kind === "recover") {
    // Two more sessions of the same owner, under other keys.
    for (let s = 0; s < rng.int(1, 2); s++) {
      const other = createSession({ expiresAt: new Date(NOW.getTime() + 3_600_000), scope: { maxPerTx } }, { now: NOW, randomBytes: (k) => rng.bytes(k) });
      const otherLock = await sessionLockOf(other, client, DEPLOYMENT, { ...binding, recipientLockHash: undefined, token: undefined });
      cells.add({ lock: otherLock, capacity: rng.edgy(61n * CKB, 1000n * CKB) });
    }
    await recoverSessions(owner.signer, DEPLOYMENT);
    return { cells, sent, label, owner: owner.lock };
  }
  const amount =
    kind === "token" || kind === "token-topup"
      ? { token: rng.edgy(1n, rng.bool(0.8) && tokenTotal > 0n && tokenTotal < tokenMax ? tokenTotal : tokenMax, [tokenMax, tokenTotal, 1n]) }
      : (() => {
          // Mostly within the balance, sometimes up to max_per_tx regardless.
          const hi = rng.bool(0.8) && ckbTotal < maxPerTx ? ckbTotal : maxPerTx;
          const lo = topUp ? 1n : 61n * CKB;
          return { amount: rng.edgy(lo, hi < lo ? lo : hi, [lo, maxPerTx, ckbTotal, ckbTotal - 61n * CKB]) };
        })();
  await spendInSession(session, client, DEPLOYMENT, binding, { to: recipientTo, topUp, ...amount } as never, NOW);
  return { cells, sent, roles, label: `${label} pay=${JSON.stringify(amount, (_, v) => (typeof v === "bigint" ? v.toString() : v))}` };
}

async function subscriptionScenario(rng: Rng, kind: "charge" | "charge-topup" | "charge-token" | "cancel"): Promise<Built> {
  const cells = new Cells(rng);
  const { client, sent } = fakeClient(cells);
  const subscriber = await secp(client, rng);
  const charger = await secp(client, rng);
  const tokenSub = kind === "charge-token" || (kind === "cancel" && rng.bool(0.4));
  const token = tokenSub ? await xudtType(client, rng) : undefined;
  const acp = tokenSub || kind === "charge-topup" || rng.bool(0.3);
  const payToLock = acp ? await acpLock(client, rng) : (await secp(client, rng)).lock;
  const price = token ? rng.edgy(1n, U128_MAX / 4n, [1n, 1000n]) : rng.edgy(acp ? 1n : 61n * CKB, 2000n * CKB, [61n * CKB, 100n * CKB]);
  const periodBlocks = rng.pick([1n, rng.edgy(1n, MAX_INTERVAL, [100n, 1000n])]);
  const sub: Subscription = {
    subscriberLockHash: subscriber.lock.hash(),
    chargerLockHash: charger.lock.hash(),
    payToLockHash: payToLock.hash(),
    price,
    periodBlocks,
    ...(token && { token: { type: { codeHash: token.codeHash, hashType: token.hashType, args: token.args } } }),
  };
  const lock = subscriptionLock(DEPLOYMENT, sub);
  const n = rng.int(1, 2);
  for (let i = 0; i < n; i++) {
    const floor = token ? 143n * CKB : 61n * CKB;
    cells.add({
      lock,
      capacity: rng.edgy(floor, 3000n * CKB, [floor, floor + price, floor + 2n * price]),
      ...(token && { type: token, data: tokenData(rng.bool(0.7) ? rng.pick([price, price - 1n, price + 1n, 2n * price, 3n * price]) : rng.edgy(0n, U128_MAX / 4n)) }),
      age: rng.bool(0.9) ? rng.edgy(periodBlocks, periodBlocks + 50n) : rng.big(0n, periodBlocks),
    });
  }
  for (let i = 0; i < rng.int(1, 2); i++) cells.add({ lock: charger.lock, capacity: rng.edgy(61n * CKB + 1n, 300n * CKB, [62n * CKB]) });
  cells.add({ lock: subscriber.lock, capacity: rng.edgy(62n * CKB, 1000n * CKB) });
  if (acp) {
    cells.add({ lock: payToLock, capacity: rng.edgy(61n * CKB, 300n * CKB) });
    if (token) cells.add({ lock: payToLock, capacity: 143n * CKB, type: token, data: tokenData(rng.edgy(0n, 1000n)) });
  }
  const label = `${kind} price=${price} period=${periodBlocks} acp=${acp}`;
  if (kind === "cancel") {
    await cancelSubscription(subscriber.signer, DEPLOYMENT, sub);
    return { cells, sent, label, owner: subscriber.lock };
  }
  await chargeSubscription(charger.signer, DEPLOYMENT, sub, { payTo: addr(payToLock, client), topUp: kind === "charge-topup" });
  return { cells, sent, roles: { session: lock, key: charger.lock, owner: subscriber.lock, recipient: payToLock, token }, label };
}

// ---------------------------------------------------------------------------
// Mutations of an accepted session-mode transaction.

const OTHER_TYPE = ccc.Script.from({ codeHash: "0x" + "70".repeat(32), hashType: "type", args: "0x" });
const STRANGER = ccc.Script.from({ codeHash: "0x" + "aa".repeat(32), hashType: "type", args: "0x04" });

function copy(tx: ccc.Transaction): ccc.Transaction {
  const t = ccc.Transaction.from({
    version: tx.version,
    cellDeps: tx.cellDeps,
    headerDeps: tx.headerDeps,
    outputs: tx.outputs.map((o) => ({ capacity: o.capacity, lock: o.lock, type: o.type })),
    outputsData: [...tx.outputsData],
    witnesses: [...tx.witnesses],
  });
  t.inputs = tx.inputs.map((i) => {
    const c = ccc.CellInput.from({ previousOutput: i.previousOutput });
    c.since = i.since;
    return c;
  });
  return t;
}

interface Mutation {
  name: string;
  tx: ccc.Transaction;
  /** The code the docs give, when the rule is unambiguous for this mutation; else only the model is checked. */
  want?: number;
}

function mutations(b: Built, base: ccc.Transaction, rng: Rng): Mutation[] {
  const r = b.roles!;
  const { cells } = b;
  const own = r.session.hash();
  const args = ccc.bytesFrom(r.session.args);
  const maxPerTx = ccc.numLeFromBytes(args.slice(64, 72));
  const minInterval = ccc.numLeFromBytes(args.slice(72, 80));
  const tokenMax = r.token ? ccc.numLeFromBytes(args.slice(112, 128)) : 0n;
  const { inputs, outputs } = modelOf(cells, base);
  const spent = inputs.filter((i) => i.lockHash === own).reduce((s, i) => s + i.capacity, 0n);
  const changeAt = base.outputs.findIndex((o) => o.lock.hash() === own);
  const change = changeAt >= 0 ? base.outputs[changeAt].capacity : 0n;
  const keyAt = base.outputs.map((o) => o.lock.hash()).lastIndexOf(r.key.hash());
  const payAt = base.outputs.findIndex((o) => o.lock.hash() !== own && o.lock.hash() !== r.key.hash());
  const groupAt = base.inputs.findIndex((i) => cells.get(i.previousOutput)!.cellOutput.lock.hash() === own);
  const tokensOf = (data: ccc.Hex) => ccc.numLeFromBytes(ccc.bytesFrom(data).slice(0, 16));
  const tokenIn = r.token
    ? inputs.filter((i) => i.lockHash === own && i.typeHash === r.token!.hash()).reduce((s, i) => s + ccc.numLeFromBytes(i.data.slice(0, 16)), 0n)
    : 0n;
  const out: Mutation[] = [];
  const m = (name: string, f: (t: ccc.Transaction) => void, want?: number) => {
    const t = copy(base);
    f(t);
    // An output below its occupied capacity is refused by consensus before any script runs
    // (and CCC would silently raise it): not a case for the lock.
    if (t.outputs.some((o, i) => o.capacity < ccc.fixedPointFrom(o.occupiedSize + ccc.bytesFrom(t.outputsData[i] ?? "0x").length))) return;
    out.push({ name, tx: t, want });
  };

  // Outflow: one more shannon out of the change, then exactly to the limit and one past it.
  if (changeAt >= 0 && change > 0n) {
    m("change -1 shannon", (t) => (t.outputs[changeAt].capacity -= 1n), spent - change + 1n > maxPerTx ? 12 : 0);
    if (spent > maxPerTx && spent - maxPerTx <= U64_MAX) {
      m("change = spent - max_per_tx (exactly at the limit)", (t) => (t.outputs[changeAt].capacity = spent - maxPerTx), 0);
      if (spent - maxPerTx >= 1n) m("change = spent - max_per_tx - 1", (t) => (t.outputs[changeAt].capacity = spent - maxPerTx - 1n), 12);
    }
    m("split change in two", (t) => {
      const half = t.outputs[changeAt].capacity / 2n;
      t.outputs[changeAt].capacity -= half;
      t.outputs.push(ccc.CellOutput.from({ lock: r.session, capacity: half, type: t.outputs[changeAt].type }));
      t.outputsData.push(t.outputsData[changeAt]);
    }, 16);
    m("change gets a foreign type", (t) => (t.outputs[changeAt].type = OTHER_TYPE), 18);
  } else if (spent > maxPerTx) {
    m("no change (all of it out)", () => {}, 0); // placeholder: base itself
  }
  if (changeAt < 0) {
    // Whole balance spent: a change of 1 shannon added is a top-up of zero outflow.
    m("add a 1-shannon change", (t) => {
      t.outputs.push(ccc.CellOutput.from({ lock: r.session, capacity: 1n }));
      t.outputsData.push("0x");
    });
  }
  // Recipient rule: extra output, one byte of the payee's args, a type on the payment.
  m("extra output to a stranger", (t) => {
    t.outputs.push(ccc.CellOutput.from({ lock: STRANGER, capacity: 61n * CKB }));
    t.outputsData.push("0x");
  }, r.recipient ? 13 : 0);
  if (payAt >= 0) {
    m("payee lock args: one byte flipped", (t) => {
      const a = ccc.bytesFrom(t.outputs[payAt].lock.args);
      a[rng.int(0, a.length - 1)] ^= 1 << rng.int(0, 7);
      t.outputs[payAt].lock = ccc.Script.from({ ...t.outputs[payAt].lock, args: ccc.hexFrom(a) });
    }, r.recipient ? 13 : 0);
    m("payee lock hash_type changed", (t) => {
      t.outputs[payAt].lock = ccc.Script.from({ ...t.outputs[payAt].lock, hashType: t.outputs[payAt].lock.hashType === "type" ? "data1" : "type" });
    }, r.recipient ? 13 : 0);
    m("payment gets a foreign type", (t) => (t.outputs[payAt].type = OTHER_TYPE), r.recipient ? 18 : 0);
  }
  // Key cell: may not grow with a recipient set.
  const keyIn = inputs.filter((i) => i.lockHash === r.key.hash()).reduce((s, i) => s + i.capacity, 0n);
  if (keyAt >= 0) {
    m("key cell = key inputs (fee from elsewhere)", (t) => (t.outputs[keyAt].capacity = keyIn), 0);
    m("key cell = key inputs + 1 shannon", (t) => (t.outputs[keyAt].capacity = keyIn + 1n), r.recipient ? 17 : 0);
    m("second key-locked output, 61 CKB", (t) => {
      t.outputs.push(ccc.CellOutput.from({ lock: r.key, capacity: 61n * CKB }));
      t.outputsData.push("0x");
    }, r.recipient ? 17 : 0);
  }
  m("every key input removed", (t) => {
    t.inputs = t.inputs.filter((i) => cells.get(i.previousOutput)!.cellOutput.lock.hash() !== r.key.hash());
  }, 11);

  // Rate limit.
  const setSince = (s: bigint) => (t: ccc.Transaction) => {
    t.inputs[groupAt].since = s;
  };
  if (minInterval > 0n) {
    m("since 0", setSince(0n), 14);
    m("since min_interval - 1", setSince(relativeBlocks(minInterval - 1n)), 14);
    m("since absolute block", setSince(minInterval), 14);
    m("since relative epoch", setSince(relativeBlocks(minInterval) | (1n << 61n)), 14);
    m("since relative timestamp", setSince(relativeBlocks(minInterval) | (2n << 61n)), 14);
    m("since min_interval exactly", setSince(relativeBlocks(minInterval)), 0);
    if (minInterval < MAX_INTERVAL) m("since min_interval + 1", setSince(relativeBlocks(minInterval + 1n)), 0);
  } else {
    m("since anything (no rate limit)", setSince(rng.big(0n, U64_MAX)), 0);
  }

  // Order and witnesses: the lock reads neither.
  m("inputs reversed", (t) => t.inputs.reverse(), 0);
  m("outputs other than the payment reordered", (t) => {
    const idx = t.outputs.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const outs = idx.map((i) => t.outputs[i]);
    const data = idx.map((i) => t.outputsData[i]);
    t.outputs = outs;
    t.outputsData = data;
  }, 0);
  m("witnesses replaced by random bytes", (t) => {
    t.witnesses = t.witnesses.map(() => rng.hex(rng.int(0, 120)));
  }, 0);
  m("witnesses removed", (t) => (t.witnesses = []), 0);
  // (The same input twice is a double spend: refused by consensus, and by ckb-debugger as a dead cell.)

  // Args: one byte longer or shorter, for every cell of the group and its change.
  for (const delta of [1, -1]) {
    m(`args ${delta > 0 ? "+1 byte" : "-1 byte"}`, (t) => {
      const a = ccc.bytesFrom(r.session.args);
      const moved = ccc.Script.from({ ...r.session, args: ccc.hexFrom(delta > 0 ? ccc.bytesConcat(a, [0]) : a.slice(0, -1)) });
      t.inputs = t.inputs.map((i) => {
        const c = cells.get(i.previousOutput)!;
        if (c.cellOutput.lock.hash() !== own) return i;
        const again = cells.add({ lock: moved, capacity: c.cellOutput.capacity, type: c.cellOutput.type, data: c.outputData });
        const n = ccc.CellInput.from({ previousOutput: again.outPoint });
        n.since = i.since;
        return n;
      });
      t.outputs.forEach((o) => {
        if (o.lock.hash() === own) o.lock = moved;
      });
    }, 10);
  }

  // Tokens.
  if (r.token && changeAt >= 0 && base.outputs[changeAt].type?.eq(r.token)) {
    const tc = tokensOf(base.outputsData[changeAt]);
    if (tc > 0n) m("token change -1 unit", (t) => (t.outputsData[changeAt] = tokenData(tc - 1n)), tokenIn - tc + 1n > tokenMax ? 20 : 0);
    m("token change with 17 data bytes", (t) => (t.outputsData[changeAt] = ccc.hexFrom(ccc.bytesConcat(ccc.bytesFrom(tokenData(tc)), [0]))), 19);
    m("token change with 15 data bytes", (t) => (t.outputsData[changeAt] = ccc.hexFrom(ccc.bytesFrom(tokenData(tc)).slice(0, 15))), 19);
    m("token change untyped (tokens burnt)", (t) => {
      t.outputs[changeAt].type = undefined;
    }, tokenIn > tokenMax ? 20 : 0);
    if (tokenIn > tokenMax) m("token change = in - max (exactly at the limit)", (t) => (t.outputsData[changeAt] = tokenData(tokenIn - tokenMax)), 0);
    if (keyAt >= 0 && r.recipient) {
      m("key cell gets 1 token unit", (t) => {
        t.outputs[keyAt].type = r.token;
        t.outputsData[keyAt] = tokenData(1n);
      }, 17);
    }
  }
  if (r.token && changeAt >= 0 && !base.outputs[changeAt].type) {
    m("untyped change claims tokens in its data", (t) => (t.outputsData[changeAt] = tokenData(U128_MAX)), 0);
  }
  return out;
}

/** Mutations of an owner-mode sweep: anything goes while an owner input is there, nothing once it is gone. */
function ownerMutations(b: Built, base: ccc.Transaction, rng: Rng): Mutation[] {
  const owner = b.owner!.hash();
  const out: Mutation[] = [];
  const m = (name: string, f: (t: ccc.Transaction) => void, want?: number) => {
    const t = copy(base);
    f(t);
    out.push({ name, tx: t, want });
  };
  m("sweep: every output to a stranger", (t) => {
    t.outputs.forEach((o) => (o.lock = STRANGER));
  }, 0);
  m("sweep: an extra typed output", (t) => {
    t.outputs.push(ccc.CellOutput.from({ lock: STRANGER, type: OTHER_TYPE, capacity: 1000n * CKB }));
    t.outputsData.push(rng.hex(rng.int(0, 20)));
  }, 0);
  m("sweep: any since", (t) => t.inputs.forEach((i) => (i.since = rng.big(0n, U64_MAX))), 0);
  m("sweep: witnesses removed", (t) => (t.witnesses = []), 0);
  m("sweep: owner inputs removed", (t) => {
    t.inputs = t.inputs.filter((i) => b.cells.get(i.previousOutput)!.cellOutput.lock.hash() !== owner);
  }, 11);
  return out;
}

// ---------------------------------------------------------------------------

type Kind = Parameters<typeof sessionScenario>[1] | Parameters<typeof subscriptionScenario>[1];
const KINDS: Kind[] = ["ckb", "ckb", "ckb-topup", "token", "token-topup", "ckb-in-token", "close", "recover", "charge", "charge-topup", "charge-token", "cancel"];
const SUB_KINDS = new Set<Kind>(["charge", "charge-topup", "charge-token", "cancel"]);

interface Stats {
  built: number;
  refused: Map<string, number>;
  accepted: number;
  mutations: number;
  mutationCodes: Map<string, Map<number, number>>;
  failures: string[];
  /** The first seed of each refusal kind, to replay it. */
  example: Map<string, number>;
}

async function runCase(seed: number, kind: Kind, stats: Stats, withMutations: boolean) {
  const rng = new Rng(seed);
  vi.spyOn(Math, "random").mockImplementation(() => rng.float());
  let b: Built;
  try {
    b = SUB_KINDS.has(kind)
      ? await subscriptionScenario(rng, kind as never)
      : await sessionScenario(rng, kind as never);
  } catch (e) {
    const name = e instanceof Error ? e.name : "throw";
    const message = e instanceof Error ? e.message : String(e);
    const known = KNOWN_PLAIN.find((re) => re.test(message));
    const key = `${kind}: ${REFUSALS.includes(name) ? `${name} (${message.replace(/[0-9.]+/g, "#").slice(0, 60)})` : known ? `plain Error ${known.source}` : `UNEXPECTED ${name}: ${message.slice(0, 120)}`}`;
    stats.refused.set(key, (stats.refused.get(key) ?? 0) + 1);
    if (!stats.example.has(key)) stats.example.set(key, seed);
    if (ONE) console.log((e as Error).stack);
    return;
  } finally {
    vi.restoreAllMocks();
  }
  stats.built++;
  for (const tx of b.sent) {
    const groups = tx.inputs.filter((i) => isSessionLock(b.cells.get(i.previousOutput)!.cellOutput.lock));
    if (!groups.length) continue; // the key cell's return in closeSession
    const { problems, runs } = await compare(b.cells, tx);
    for (const r of runs) {
      if (r.code !== 0) problems.push(`library tx refused by the lock: code ${r.code}`);
    }
    if (problems.length) {
      stats.failures.push(`seed ${seed} [${b.label}] built tx: ${problems.join("; ")}`);
      continue;
    }
    stats.accepted++;
    if (!withMutations) continue;
    const ownerMode = !b.roles;
    if (ownerMode && !b.owner) continue;
    for (const mu of ownerMode ? ownerMutations(b, tx, rng) : mutations(b, tx, rng)) {
      stats.mutations++;
      const res = await compare(b.cells, mu.tx);
      // The args mutations move the group to another lock: then it is the only group.
      const own = ownerMode
        ? res.runs.find((r) => r.code !== 0) ?? res.runs[0] // a sweep may hold several groups: the worst one
        : res.runs.find((r) => r.lockHash === b.roles!.session.hash()) ?? (res.runs.length === 1 ? res.runs[0] : undefined);
      const code = own?.code ?? -1;
      const byName = stats.mutationCodes.get(mu.name) ?? new Map<number, number>();
      byName.set(code, (byName.get(code) ?? 0) + 1);
      stats.mutationCodes.set(mu.name, byName);
      const why = [...res.problems];
      if (ONE && process.env.FUZZ_DEBUG === mu.name) {
        const show = (t: ccc.Transaction) => {
          const v = modelOf(b.cells, t);
          return JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? ccc.hexFrom(x) : x), 1);
        };
        console.log("roles", b.roles!.session.hash(), b.roles!.key.hash(), "BASE", show(tx), "MUTATED", show(mu.tx), res.runs.map((r) => [r.lockHash, r.code]));
      }
      if (mu.want !== undefined && code !== mu.want) why.push(`expected code ${mu.want} (docs), lock gave ${code}`);
      if (why.length) stats.failures.push(`seed ${seed} [${b.label}] mutation "${mu.name}": ${why.join("; ")}`);
    }
  }
}

const newStats = (): Stats => ({ built: 0, refused: new Map(), accepted: 0, mutations: 0, mutationCodes: new Map(), failures: [], example: new Map() });
const report = (s: Stats) => {
  console.log(
    `built ${s.built}, accepted txs ${s.accepted}, mutations ${s.mutations}\nrefused by the library:`,
    Object.fromEntries([...s.refused].map(([k, v]) => [k, `${v} (first seed ${s.example.get(k)})`])),
    "\nmutation codes:",
    Object.fromEntries([...s.mutationCodes].map(([k, v]) => [k, Object.fromEntries(v)])),
  );
};

describe.skipIf(skipLock)("library and lock agree (random valid policies, CKB-VM)", () => {
  it("every transaction the library builds is accepted; single mutations get the documented code", { timeout: 300_000 }, async () => {
    const stats = newStats();
    const count = ONE ? 1 : Math.round(240 * SCALE);
    for (let i = 0; i < count; i++) {
      const seed = ONE ? SEED : SEED + 2_000_000 + i;
      const kind = ONE && process.env.FUZZ_KIND ? (process.env.FUZZ_KIND as Kind) : KINDS[i % KINDS.length];
      await runCase(seed, kind, stats, true);
    }
    report(stats);
    expect(stats.failures).toEqual([]);
    expect([...stats.refused.keys()].filter((k) => k.includes("UNEXPECTED"))).toEqual([]);
    // Each kind must build often enough for the property to mean something.
    if (!ONE) expect(stats.accepted).toBeGreaterThan(count / 2);
  });

  it("model sanity: max_per_tx and min_interval at their maxima admit an outflow of u64::MAX", async () => {
    const args = ccc.bytesConcat("0x" + "01".repeat(32), "0x" + "02".repeat(32), ccc.numLeToBytes(U64_MAX, 8), ccc.numLeToBytes(MAX_INTERVAL, 8));
    expect(
      model(args, ("0x" + "ee".repeat(32)) as ccc.Hex, [
        { lockHash: ("0x" + "02".repeat(32)) as ccc.Hex, data: new Uint8Array(), capacity: 61n * CKB },
        { lockHash: ("0x" + "ee".repeat(32)) as ccc.Hex, data: new Uint8Array(), capacity: U64_MAX, since: relativeBlocks(MAX_INTERVAL) },
      ], []),
    ).toBe(0);
  });
});
