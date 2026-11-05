/**
 * The accounting invariant across script groups, as a property of the deployed
 * session lock in CKB-VM (review #47, tydeptrai21042004, 5 Nov 2026, points 1 and 3).
 *
 * Each generated transaction holds 2 to 4 session-lock groups (sessions, CKB
 * subscriptions, token subscriptions) with independent owners, keys and
 * recipients (some shared on purpose: one charger key and one payout address
 * for several subscriptions), mixed rate-limit states, unrelated funding inputs
 * from strangers paying fees, and mixed outputs including value sent from one
 * group into another group's change.
 *
 * For every group the lock accepts, the test asserts the economics directly from
 * the transaction, not through the model of test/fuzz/harness.ts:
 *
 * - owner mode only with an input under the group's own owner lock; otherwise
 *   an input under its own key lock is present;
 * - net loss (group inputs minus what comes back to the group's own lock) is at
 *   most its max_per_tx in CKB, and at most max_per_tx_token in its token; for a
 *   subscription, at most one price;
 * - at most one output under the group's own lock;
 * - with a recipient: every other output is under the key, the owner or the
 *   recipient, those carry no foreign type, and the key's outputs do not grow;
 * - with min_interval: every group input carries a relative block-number since
 *   of at least min_interval;
 * - summed over the session-mode groups of one key, the loss is at most the sum
 *   of their limits.
 *
 * For every group refused under one of these rules, the same check run as if it
 * had been accepted must flag it, so the check is not vacuous. The lock is also
 * compared with the model (as in property-fuzz.test.ts), and a seed set is run
 * twice to show the generator and the lock reproduce.
 *
 * Listed in docs/SECURITY-EVIDENCE.md, "Accounting invariant across groups".
 *
 * Seeded like property-fuzz.test.ts: FUZZ_SEED, FUZZ_SCALE, FUZZ_ONE=1.
 */
import { ccc } from "@ckb-ccc/core";
import { describe, expect, it } from "vitest";
import { CKB, Cells, compare, DEPLOYMENT, type LockRun, Rng, SCALE, SEED, skipLock } from "./fuzz/harness.js";

const ONE = !!process.env.FUZZ_ONE;
/** Refusals for a rule the invariant states (authorisation, outflow, recipient, rate limit, splitting, key growth, token outflow). */
const ECONOMIC = new Set([11, 12, 13, 14, 16, 17, 20]);
const T = 100_000_000n; // one token unit, 8 decimals
const plain = (args: string) => ccc.Script.from({ codeHash: "0x" + "aa".repeat(32), hashType: "type", args });
const TOKENS = [plain("0x7171"), plain("0x7272")];
const OTHER_TYPE = plain("0x7070");
const u64le = (v: bigint) => ccc.numLeToBytes(v, 8);
const u128le = (v: bigint) => ccc.numLeToBytes(v, 16);
const relativeBlocks = (n: bigint) => (1n << 63n) | n;
const VALUE_MASK = (1n << 56n) - 1n;
const withSince = (cell: ccc.Cell, since: bigint) => {
  const input = ccc.CellInput.from({ previousOutput: cell.outPoint });
  input.since = since;
  return input;
};

type Kind = "session" | "subscription" | "token-subscription";
interface Group {
  name: string;
  kind: Kind;
  owner: ccc.Script;
  key: ccc.Script;
  recipient?: ccc.Script;
  maxPerTx: bigint;
  minInterval: bigint;
  token?: { type: ccc.Script; max: bigint };
  lock: ccc.Script;
  hash: ccc.Hex;
}

function makeGroup(name: string, kind: Kind, o: Omit<Group, "name" | "kind" | "lock" | "hash">, hashType: ccc.HashType = "data2"): Group {
  const args = ccc.bytesConcat(
    o.owner.hash(),
    o.key.hash(),
    u64le(o.maxPerTx),
    u64le(o.minInterval),
    ...(o.token ? [o.token.type.hash(), u128le(o.token.max)] : []),
    ...(o.recipient ? [o.recipient.hash()] : []),
  );
  const lock = ccc.Script.from({ codeHash: DEPLOYMENT.codeHash, hashType, args: ccc.hexFrom(args) });
  return { name, kind, ...o, lock, hash: lock.hash() };
}

/** A subscription as src/subscription.ts opens it: owner = subscriber, key = charger, recipient = payout. */
const subscription = (name: string, subscriber: ccc.Script, charger: ccc.Script, payTo: ccc.Script, price: bigint, period: bigint) =>
  makeGroup(name, "subscription", { owner: subscriber, key: charger, recipient: payTo, maxPerTx: price, minInterval: period });
const tokenSubscription = (name: string, subscriber: ccc.Script, charger: ccc.Script, payTo: ccc.Script, token: ccc.Script, price: bigint, period: bigint) =>
  makeGroup(name, "token-subscription", { owner: subscriber, key: charger, recipient: payTo, maxPerTx: 0n, minInterval: period, token: { type: token, max: price } });

// ---------------------------------------------------------------------------
// The invariant, checked directly on a transaction and the lock's results.

interface View {
  lock: ccc.Hex;
  type?: ccc.Hex;
  data: Uint8Array;
  capacity: bigint;
  since: bigint;
}
function viewOf(cells: Cells, txLike: ccc.TransactionLike) {
  const tx = ccc.Transaction.from(txLike);
  const inputs: View[] = tx.inputs.map((i) => {
    const c = cells.get(i.previousOutput)!;
    return { lock: c.cellOutput.lock.hash(), type: c.cellOutput.type?.hash(), data: ccc.bytesFrom(c.outputData), capacity: c.cellOutput.capacity, since: i.since };
  });
  const outputs: View[] = tx.outputs.map((o, k) => ({ lock: o.lock.hash(), type: o.type?.hash(), data: ccc.bytesFrom(tx.outputsData[k] ?? "0x"), capacity: o.capacity, since: 0n }));
  return { inputs, outputs };
}
/** Token amount a cell holds for `token`: the u128 LE of its first 16 bytes if typed by it, else 0. */
const amountOf = (c: View, token?: Group["token"]) =>
  token && c.type === token.type.hash() && c.data.length >= 16 ? ccc.numLeFromBytes(c.data.slice(0, 16)) : 0n;
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

interface Accepted {
  group: Group;
  ownerMode: boolean;
  loss: bigint;
  tokenLoss: bigint;
  received: bigint; // grew: change above what its inputs held (a top-up, possibly from another group)
}

/** Every broken invariant for the groups the lock accepted, as text; empty if none. */
function checkInvariant(cells: Cells, tx: ccc.Transaction, groups: Group[], runs: LockRun[]): { violations: string[]; accepted: Accepted[] } {
  const { inputs, outputs } = viewOf(cells, tx);
  const violations: string[] = [];
  const accepted: Accepted[] = [];
  const v = (g: Group, msg: string) => violations.push(`${g.name} (${g.kind}): ${msg}`);
  for (const run of runs) {
    if (run.code !== 0) continue;
    const g = groups.find((x) => x.hash === run.lockHash);
    if (!g) {
      violations.push(`a group the generator did not make: ${run.lockHash}`);
      continue;
    }
    const groupIn = inputs.filter((c) => c.lock === g.hash);
    const own = outputs.filter((c) => c.lock === g.hash);
    const spent = sum(groupIn.map((c) => c.capacity));
    const back = sum(own.map((c) => c.capacity));
    const loss = spent > back ? spent - back : 0n;
    const tokIn = sum(groupIn.map((c) => amountOf(c, g.token)));
    const tokBack = sum(own.map((c) => amountOf(c, g.token)));
    const tokenLoss = tokIn > tokBack ? tokIn - tokBack : 0n;
    const ownerMode = inputs.some((c) => c.lock === g.owner.hash());
    accepted.push({ group: g, ownerMode, loss, tokenLoss, received: back > spent ? back - spent : 0n });
    if (ownerMode) continue; // the owner's own lock authorised the whole transaction

    if (!inputs.some((c) => c.lock === g.key.hash())) v(g, "accepted with neither its owner nor its key in the inputs");
    if (own.length > 1) v(g, `${own.length} outputs under its own lock`);
    if (loss > g.maxPerTx) v(g, `net CKB loss ${loss} > max_per_tx ${g.maxPerTx}`);
    if (g.token && tokenLoss > g.token.max) v(g, `net token loss ${tokenLoss} > max_per_tx_token ${g.token.max}`);
    if (g.kind === "token-subscription" && (loss > 0n || tokenLoss > g.token!.max)) v(g, `charged ${loss} CKB and ${tokenLoss} tokens, price ${g.token!.max} tokens`);
    for (const c of [...groupIn, ...own]) {
      if (c.type && c.type !== g.token?.type.hash()) v(g, `a group cell or its change carries type ${c.type}`);
    }
    if (g.minInterval > 0n) {
      for (const c of groupIn) {
        if (c.since >> 61n !== 0b100n || (c.since & VALUE_MASK) < g.minInterval) v(g, `input with since ${c.since.toString(16)} spent under min_interval ${g.minInterval}`);
      }
    }
    if (g.recipient) {
      const allowed = new Set([g.hash, g.key.hash(), g.owner.hash(), g.recipient.hash()]);
      for (const c of outputs) {
        if (!allowed.has(c.lock)) v(g, `paid ${c.capacity} to a lock outside recipient/owner/key/change: ${c.lock}`);
        else if (c.lock !== g.hash && c.lock !== g.key.hash() && c.type && c.type !== g.token?.type.hash()) v(g, `paid in a foreign-typed cell`);
      }
      const keyIn = inputs.filter((c) => c.lock === g.key.hash());
      const keyOut = outputs.filter((c) => c.lock === g.key.hash() && c.lock !== g.hash);
      if (sum(keyOut.map((c) => c.capacity)) > sum(keyIn.map((c) => c.capacity))) v(g, "the key's cells grew");
      if (g.token && sum(keyOut.map((c) => amountOf(c, g.token))) > sum(keyIn.map((c) => amountOf(c, g.token)))) v(g, "the key's tokens grew");
    }
  }
  // The one cross-group effect: one key, several sessions, each limit its owner's.
  const byKey = new Map<ccc.Hex, Accepted[]>();
  for (const a of accepted) if (!a.ownerMode) byKey.set(a.group.key.hash(), [...(byKey.get(a.group.key.hash()) ?? []), a]);
  for (const [key, as] of byKey) {
    if (sum(as.map((a) => a.loss)) > sum(as.map((a) => a.group.maxPerTx))) violations.push(`key ${key}: summed loss over its sessions above the sum of their limits`);
  }
  return { violations, accepted };
}

// ---------------------------------------------------------------------------
// The generator.

interface Plan {
  cells: Cells;
  tx: ccc.Transaction;
  groups: Group[];
  tags: Set<string>;
}

function randomCase(seed: number): Plan {
  const r = new Rng(seed);
  const cells = new Cells(r);
  const tags = new Set<string>();
  const tx = ccc.Transaction.default();
  let ent = 0;
  const fresh = (prefix: string) => plain(`0x${prefix}${(ent++).toString(16).padStart(4, "0")}`);

  // The shape of the transaction. "random" mixes everything, and most such transactions are refused by
  // some group; "free" (sessions without a recipient) and "creator" (one creator charging several
  // subscriptions, cells taken whole, a stranger paying the fee) are shapes a lock can accept whole,
  // so that the invariant is also exercised on transactions every group accepts.
  const shape = r.pick(["random", "random", "free", "creator"] as const);
  tags.add(shape);
  const cfg = {
    young: shape === "random" ? 0.15 : 0.03,
    honest: shape === "random" ? 0.7 : 0.95,
    keyPresent: shape === "random" ? 0.9 : 0.98,
    strangerChange: shape === "creator" ? 0 : 0.4,
    grow: shape === "free" ? 0.01 : 0.06,
  };

  // Groups: independent owners always; keys and recipients sometimes shared, as one creator's subscriptions are.
  const n = r.int(2, 4);
  const charger = fresh("20");
  const creatorPayTo = fresh("30");
  const keys: ccc.Script[] = [];
  const payouts: ccc.Script[] = [];
  const groups: Group[] = [];
  for (let i = 0; i < n; i++) {
    const owner = fresh("10");
    const key = shape === "creator" ? charger : keys.length && r.bool(0.3) ? r.pick(keys) : fresh("20");
    if (!keys.includes(key)) keys.push(key);
    const kind =
      shape === "free" ? "session" : shape === "creator" ? "subscription" : r.pick(["session", "session", "subscription", "token-subscription"] as const);
    const pickRecipient = (): ccc.Script => {
      const roll = r.float();
      if (payouts.length && roll < 0.45) return r.pick(payouts);
      if (groups.length && roll < 0.55) return r.pick(groups).lock; // pays into an earlier group's lock
      if (groups.length && roll < 0.6) return r.pick(groups).owner;
      const p = fresh("30");
      payouts.push(p);
      return p;
    };
    const token = r.pick(TOKENS);
    let g: Group;
    if (kind === "session") {
      const recipient = shape !== "free" && r.bool(0.5) ? pickRecipient() : undefined;
      const withToken = r.bool(0.35);
      g = makeGroup(
        `g${i}`,
        kind,
        {
          owner,
          key,
          recipient,
          maxPerTx: r.pick([0n, 10n * CKB, 61n * CKB, 100n * CKB, 500n * CKB, r.big(0n, 1000n * CKB)]),
          minInterval: r.bool(0.4) ? 0n : r.pick([1n, 10n, 100n]),
          ...(withToken && { token: { type: token, max: r.pick([0n, 10n * T, 100n * T, r.big(0n, 1000n * T)]) } }),
        },
        r.pick(["data2", "data2", "data1"] as const),
      );
    } else if (shape === "creator") {
      g = subscription(`g${i}`, owner, key, creatorPayTo, r.pick([200n * CKB, 300n * CKB, 500n * CKB]), r.pick([10n, 100n, 1000n]));
    } else if (kind === "subscription") {
      g = subscription(`g${i}`, owner, key, pickRecipient(), r.pick([10n * CKB, 100n * CKB, 200n * CKB, 300n * CKB]), r.pick([10n, 100n, 1000n]));
    } else {
      g = tokenSubscription(`g${i}`, owner, key, pickRecipient(), token, r.pick([1n * T, 10n * T, 100n * T]), r.pick([10n, 100n]));
    }
    groups.push(g);
  }
  if (new Set(groups.map((g) => g.key.hash())).size < groups.length) tags.add("shared-key");

  const tokenOf = (g: Group) => g.token?.type;
  const tokenCell = (type: ccc.Script, amount: bigint, len = 16) =>
    ({ type, data: len >= 16 ? ccc.bytesConcat(u128le(amount), new Uint8Array(len - 16)) : new Uint8Array(len) });

  // Group inputs.
  const spent = new Map<ccc.Hex, bigint>();
  const tokIn = new Map<ccc.Hex, bigint>();
  for (const g of groups) {
    const count = shape === "creator" ? 1 : r.int(1, 3);
    let s = 0n;
    let t = 0n;
    let mature = 0;
    let young = 0;
    for (let k = 0; k < count; k++) {
      const whole = g.kind === "subscription" && r.bool(shape === "creator" ? 0.95 : 0.3);
      const capacity = whole ? g.maxPerTx : r.edgy(61n * CKB, 2000n * CKB, [100n * CKB, 500n * CKB]);
      let type: ccc.Script | undefined;
      let data = new Uint8Array();
      if (g.token && r.bool(0.75)) {
        const amount = r.edgy(0n, 5000n * T, [g.token.max, 1000n * T]);
        ({ type, data } = tokenCell(g.token.type, amount, r.bool(0.04) ? 15 : 16));
        t += data.length >= 16 ? amount : 0n;
      } else if (r.bool(0.03)) type = OTHER_TYPE;
      const cell = cells.add({ lock: g.lock, capacity, type, data: ccc.hexFrom(data) });
      let since = 0n;
      if (g.minInterval > 0n) {
        const roll = r.float();
        if (roll < 1 - cfg.young) since = relativeBlocks(g.minInterval + BigInt(r.int(0, 3)));
        else if (roll < 1 - cfg.young / 4) since = relativeBlocks(g.minInterval - 1n);
        else since = r.pick([0n, (0b110n << 61n) | g.minInterval, (0b101n << 61n) | g.minInterval]);
        if (since === relativeBlocks(g.minInterval - 1n) || since >> 61n !== 0b100n) young++;
        else mature++;
      } else if (r.bool(0.2)) since = relativeBlocks(BigInt(r.int(0, 5)));
      tx.inputs.push(withSince(cell, since));
      s += cell.cellOutput.capacity; // CCC raises a capacity below the occupied size
    }
    if (mature && young) tags.add("mature+young in one group");
    spent.set(g.hash, s);
    tokIn.set(g.hash, t);
  }
  const groupsYoung = groups.filter((g) => g.minInterval > 0n);
  if (groupsYoung.length >= 2) tags.add("several rate-limited groups");

  // Authorisation and funding inputs.
  const keyIn = new Map<ccc.Hex, { capacity: bigint; type?: ccc.Script; amount: bigint }>();
  for (const key of keys) {
    if (!r.bool(cfg.keyPresent)) continue;
    const capacity = r.edgy(61n * CKB, 1000n * CKB);
    const tokenGroup = groups.find((g) => g.key.eq(key) && g.token);
    const typed = tokenGroup && r.bool(0.15) ? tokenCell(tokenGroup.token!.type, r.big(0n, 100n * T)) : undefined;
    const cell = cells.add({ lock: key, capacity, type: typed?.type, data: ccc.hexFrom(typed?.data ?? "0x") });
    tx.inputs.push(withSince(cell, 0n));
    keyIn.set(key.hash(), { capacity: cell.cellOutput.capacity, type: typed?.type, amount: typed ? ccc.numLeFromBytes(typed.data.slice(0, 16)) : 0n });
  }
  for (const g of groups) {
    if (r.bool(0.07)) tx.inputs.push(withSince(cells.add({ lock: g.owner, capacity: 100n * CKB }), 0n));
  }
  const strangers: { lock: ccc.Script; capacity: bigint }[] = [];
  for (let k = shape === "creator" ? r.pick([1, 1, 2]) : r.pick([0, 0, 1, 1, 2]); k > 0; k--) {
    const lock = fresh("40");
    const capacity = r.edgy(61n * CKB, 500n * CKB);
    tx.inputs.push(withSince(cells.add({ lock, capacity }), 0n));
    strangers.push({ lock, capacity });
  }
  if (payouts.length && r.bool(0.1)) {
    tx.inputs.push(withSince(cells.add({ lock: r.pick(payouts), capacity: 100n * CKB }), 0n));
    tags.add("payout input");
  }

  // Outputs: each group's change, payments, and value sent into another group's change.
  const change = new Map<ccc.Hex, { capacity: bigint; token: bigint; cell: boolean }>();
  for (const g of groups) change.set(g.hash, { capacity: 0n, token: 0n, cell: false });
  const outs: { lock: ccc.Script; capacity: bigint; type?: ccc.Script; data: Uint8Array }[] = [];
  for (const g of groups) {
    const s = spent.get(g.hash)!;
    const t = tokIn.get(g.hash)!;
    const honest = r.bool(cfg.honest);
    const limit = g.maxPerTx;
    // A creator takes a subscription cell whole (its price); otherwise near the limit, or past it.
    let out =
      honest && shape === "creator" ? s : honest ? r.edgy(0n, limit < s ? limit : s, [limit]) : r.pick([limit + 1n, s, limit * 2n + 1n, r.big(0n, s)]);
    if (out > s) out = s;
    let tokOut = 0n;
    if (g.token) {
      tokOut = honest ? r.edgy(0n, g.token.max < t ? g.token.max : t, [g.token.max]) : r.pick([g.token.max + 1n, t, r.big(0n, t)]);
      if (tokOut > t) tokOut = t;
    }
    const ch = change.get(g.hash)!;
    ch.capacity += s - out;
    ch.token += t - tokOut;
    ch.cell = ch.capacity > 0n || ch.token > 0n || (shape !== "creator" && r.bool(0.2));
    // Where the outflow goes: part to the fee, the rest to one destination.
    const f = r.pick([0n, 0n, 1000n, out]);
    const fee = f > out ? out : f;
    let pay = out - fee;
    const others = groups.filter((x) => x !== g);
    const dests = g.recipient && honest ? ["recipient", "recipient", "recipient", "owner"] : ["recipient", "owner", "stranger", "cross", "cross", "key"];
    const dest = r.pick(dests);
    const typed = g.token && tokOut > 0n ? g.token.type : undefined;
    if (dest === "cross" && others.length) {
      const b = r.pick(others);
      const bc = change.get(b.hash)!;
      bc.capacity += pay;
      if (typed && b.token?.type.eq(typed)) bc.token += tokOut;
      else if (tokOut > 0n) outs.push({ lock: b.lock, capacity: 0n, ...tokenCell(typed!, tokOut) }); // a second cell under B
      bc.cell = true;
      tags.add("cross-group");
      pay = 0n;
    } else {
      const lock = dest === "recipient" && g.recipient ? g.recipient : dest === "owner" ? g.owner : dest === "key" ? g.key : fresh("40");
      if (pay > 0n || tokOut > 0n) outs.push({ lock, capacity: pay, ...(typed ? tokenCell(typed, tokOut) : { data: new Uint8Array() }) });
    }
    if (!honest && r.bool(0.15)) {
      // A second cell under its own lock (no splitting), or a typed change.
      outs.push({ lock: g.lock, capacity: 61n * CKB, data: new Uint8Array() });
    }
  }
  for (const g of groups) {
    const ch = change.get(g.hash)!;
    if (!ch.cell) continue;
    const t = tokenOf(g);
    const typed = t && (ch.token > 0n || r.bool(0.3)) ? tokenCell(t, ch.token, r.bool(0.03) ? 32 : 16) : r.bool(0.02) ? { type: OTHER_TYPE, data: new Uint8Array() } : undefined;
    outs.push({ lock: g.lock, capacity: ch.capacity, type: typed?.type, data: typed?.data ?? new Uint8Array() });
  }
  for (const [hash, k] of keyIn) {
    const key = keys.find((x) => x.hash() === hash)!;
    const grow = r.bool(cfg.grow) ? CKB : 0n;
    const fee = r.pick([0n, 1000n, 100_000n]);
    const capacity = k.capacity - fee + grow;
    outs.push({ lock: key, capacity, ...(k.type ? tokenCell(k.type, k.amount) : { data: new Uint8Array() }) });
  }
  for (const s of strangers) {
    if (r.bool(cfg.strangerChange)) outs.push({ lock: s.lock, capacity: s.capacity - 100_000n, data: new Uint8Array() });
    else tags.add("stranger pays the fee");
  }

  // Conservation, as consensus and xUDT would require: a stranger funds any shortfall.
  for (const o of outs) {
    tx.outputs.push(ccc.CellOutput.from({ lock: o.lock, capacity: o.capacity, ...(o.type && { type: o.type }) }));
    tx.outputsData.push(ccc.hexFrom(o.data));
  }
  const view = viewOf(cells, tx);
  const capIn = sum(view.inputs.map((c) => c.capacity));
  const capOut = sum(view.outputs.map((c) => c.capacity));
  if (capOut >= capIn) {
    tx.inputs.push(withSince(cells.add({ lock: fresh("40"), capacity: capOut - capIn + 100_000n }), 0n));
    tags.add("stranger pays the fee");
  }
  for (const type of TOKENS) {
    const tk = { type, max: 0n };
    const ti = sum(view.inputs.map((c) => amountOf(c, tk)));
    const to = sum(view.outputs.map((c) => amountOf(c, tk)));
    if (to > ti) tx.inputs.push(withSince(cells.add({ lock: fresh("40"), capacity: 142n * CKB, type, data: ccc.hexFrom(u128le(to - ti)) }), 0n));
  }

  // Order never matters to the lock: shuffle both sides.
  const shuffle = <X,>(xs: X[]) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = r.int(0, i);
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  };
  shuffle(tx.inputs);
  const pairs = shuffle(tx.outputs.map((o, k) => [o, tx.outputsData[k]] as const));
  tx.outputs = pairs.map((p) => p[0]);
  tx.outputsData = pairs.map((p) => p[1]);
  return { cells, tx, groups, tags };
}

// ---------------------------------------------------------------------------

/** ckb-debugger runs synchronously: let the worker answer vitest between cases, or a long sweep times out its RPC. */
const yieldToRunner = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function runCase(plan: Plan) {
  const { problems, runs } = await compare(plan.cells, plan.tx);
  const { violations, accepted } = checkInvariant(plan.cells, plan.tx, plan.groups, runs);
  return { problems, runs, violations, accepted };
}

describe.skipIf(skipLock)("accounting invariant across script groups (review #47, 5 Nov)", () => {
  it("generated transactions with 2 to 4 independent groups: every accepted group stays within its own limits", { timeout: 600_000 }, async () => {
    const seeds = ONE ? [SEED] : Array.from({ length: Math.round(800 * SCALE) }, (_, i) => SEED + 2_000_000 + i);
    const failures: string[] = [];
    const codes = new Map<number, number>();
    const stats = { groupsAccepted: 0, sessionModeAccepted: 0, txAllAccepted: 0, txAllAcceptedMulti: 0, txAllAccepted3: 0, crossAccepted: 0, strangerFeeSubs: 0, tokenMoved: 0, sharedKeyAccepted: 0, refusalsChecked: 0 };
    for (const seed of seeds) {
      await yieldToRunner();
      const plan = randomCase(seed);
      const { problems, runs, violations, accepted } = await runCase(plan);
      for (const r of runs) codes.set(r.code, (codes.get(r.code) ?? 0) + 1);
      if (problems.length || violations.length) failures.push(`seed ${seed}: ${[...violations, ...problems].join("; ")}`);
      // The check is not vacuous: had the lock accepted a group it refused for an economic rule, the check flags it.
      for (const run of runs) {
        if (!ECONOMIC.has(run.code)) continue;
        stats.refusalsChecked++;
        const forged = runs.map((x) => ({ ...x, code: x === run ? 0 : 1 }));
        if (!checkInvariant(plan.cells, plan.tx, plan.groups, forged).violations.length) failures.push(`seed ${seed}: the check would not flag group ${run.lockHash} (refused ${run.code}) as accepted`);
      }
      const session = accepted.filter((a) => !a.ownerMode);
      stats.groupsAccepted += accepted.length;
      stats.sessionModeAccepted += session.length;
      if (session.some((a) => a.tokenLoss > 0n)) stats.tokenMoved++;
      if (runs.length && runs.every((r) => r.code === 0)) {
        stats.txAllAccepted++;
        if (session.length >= 2) stats.txAllAcceptedMulti++;
        if (session.length >= 3) stats.txAllAccepted3++;
        if (session.some((a) => a.loss > 0n) && session.some((a) => a.received > 0n)) stats.crossAccepted++;
        if (plan.tags.has("stranger pays the fee") && session.filter((a) => a.group.kind !== "session").length >= 2) stats.strangerFeeSubs++;
        if (plan.tags.has("shared-key") && session.length >= 2) stats.sharedKeyAccepted++;
      }
    }
    console.log("multi-group codes:", Object.fromEntries([...codes].sort((a, b) => a[0] - b[0])), stats);
    expect(failures).toEqual([]);
    if (ONE) return;
    // The generator must reach the cases the property is about, or it says little.
    for (const c of [0, 11, 12, 13, 14, 16, 17, 18, 20]) expect(codes.get(c) ?? 0, `code ${c}`).toBeGreaterThan(0);
    expect(stats.txAllAcceptedMulti).toBeGreaterThan(20);
    expect(stats.txAllAccepted3).toBeGreaterThan(0);
    expect(stats.crossAccepted).toBeGreaterThan(0);
    expect(stats.strangerFeeSubs).toBeGreaterThan(0);
    expect(stats.tokenMoved).toBeGreaterThan(0);
    expect(stats.sharedKeyAccepted).toBeGreaterThan(0);
  });

  it("a fixed seed set reproduces: same transactions, same results", { timeout: 120_000 }, async () => {
    const seeds = Array.from({ length: 25 }, (_, i) => 20261105 + i);
    const once = async () => {
      const out: string[] = [];
      for (const seed of seeds) {
        await yieldToRunner();
        const plan = randomCase(seed);
        const { runs } = await runCase(plan);
        out.push(`${plan.tx.hash()}:${runs.map((r) => `${r.lockHash.slice(2, 10)}=${r.code}`).join(",")}`);
      }
      return out;
    };
    const a = await once();
    const b = await once();
    expect(b).toEqual(a);
    expect(new Set(a).size).toBe(seeds.length); // distinct transactions, not one repeated
  });

  // Fixed cases the review asked about, each checked by the same invariant.
  describe("regression cases", () => {
    const PRICE = 200n * CKB; // a cell holds at least its occupied 153 CKB, so a price this size can be taken whole
    const PERIOD = 100n;
    const mature = relativeBlocks(PERIOD);

    function tx(cells: Cells, inputs: [ccc.Cell, bigint][], outputs: { lock: ccc.Script; capacity: bigint; type?: ccc.Script; data?: Uint8Array }[]) {
      const t = ccc.Transaction.default();
      for (const [c, since] of inputs) t.inputs.push(withSince(c, since));
      for (const o of outputs) {
        t.outputs.push(ccc.CellOutput.from({ lock: o.lock, capacity: o.capacity, ...(o.type && { type: o.type }) }));
        t.outputsData.push(ccc.hexFrom(o.data ?? "0x"));
      }
      return t;
    }
    async function run(cells: Cells, t: ccc.Transaction, groups: Group[]) {
      const { problems, runs, violations } = await runCase({ cells, tx: t, groups, tags: new Set() });
      expect(problems).toEqual([]);
      expect(violations).toEqual([]);
      return Object.fromEntries(groups.map((g) => [g.name, runs.find((r) => r.lockHash === g.hash)?.code]));
    }
    const setup = () => {
      const cells = new Cells(new Rng(5));
      const charger = plain("0x2001");
      const payTo = plain("0x3001");
      const stranger = plain("0x4001");
      const a = subscription("A", plain("0x1001"), charger, payTo, PRICE, PERIOD);
      const b = subscription("B", plain("0x1002"), charger, payTo, PRICE, PERIOD);
      return { cells, charger, payTo, stranger, a, b };
    };

    it("a stranger pays the fee for two subscriptions charged in one transaction: each takes one price, the stranger's change is refused", async () => {
      const { cells, charger, payTo, stranger, a, b } = setup();
      const key = cells.add({ lock: charger, capacity: 100n * CKB });
      const fund = () => cells.add({ lock: stranger, capacity: 70n * CKB });
      // Taken whole (each cell holds one price): both accept, the stranger's whole cell is the fee.
      let t = tx(
        cells,
        [[cells.add({ lock: a.lock, capacity: PRICE }), mature], [cells.add({ lock: b.lock, capacity: PRICE }), mature], [key, 0n], [fund(), 0n]],
        [{ lock: payTo, capacity: 2n * PRICE }, { lock: charger, capacity: 100n * CKB }],
      );
      expect(await run(cells, t, [a, b])).toEqual({ A: 0, B: 0 });
      // The same, with the stranger taking change: both refuse it, 13.
      t = tx(
        cells,
        [[cells.add({ lock: a.lock, capacity: PRICE }), mature], [cells.add({ lock: b.lock, capacity: PRICE }), mature], [key, 0n], [fund(), 0n]],
        [{ lock: payTo, capacity: 2n * PRICE }, { lock: charger, capacity: 100n * CKB }, { lock: stranger, capacity: 69n * CKB }],
      );
      expect(await run(cells, t, [a, b])).toEqual({ A: 13, B: 13 });
      // With change for each: each one's change is "anyone else" to the other, 13.
      t = tx(
        cells,
        [[cells.add({ lock: a.lock, capacity: 500n * CKB }), mature], [cells.add({ lock: b.lock, capacity: 500n * CKB }), mature], [key, 0n], [fund(), 0n]],
        [{ lock: payTo, capacity: 2n * PRICE }, { lock: a.lock, capacity: 300n * CKB }, { lock: b.lock, capacity: 300n * CKB }, { lock: charger, capacity: 100n * CKB }],
      );
      expect(await run(cells, t, [a, b])).toEqual({ A: 13, B: 13 });
      // Two prices taken from A, one from B: A refuses, 12, B accepts; the stranger's fee is no one's charge.
      t = tx(
        cells,
        [[cells.add({ lock: a.lock, capacity: 2n * PRICE }), mature], [cells.add({ lock: b.lock, capacity: PRICE }), mature], [key, 0n], [fund(), 0n]],
        [{ lock: payTo, capacity: 3n * PRICE }, { lock: charger, capacity: 100n * CKB }],
      );
      expect(await run(cells, t, [a, b])).toEqual({ A: 12, B: 0 });
    });

    it("token subscriptions: a stranger's CKB funds the payout cell and the fee; one price of token, no CKB, leaves each", async () => {
      const cells = new Cells(new Rng(6));
      const charger = plain("0x2002");
      const payTo = plain("0x3002");
      const stranger = plain("0x4002");
      const [token] = TOKENS;
      const a = tokenSubscription("A", plain("0x1003"), charger, payTo, token, 10n * T, PERIOD);
      const b = tokenSubscription("B", plain("0x1004"), charger, payTo, token, 10n * T, PERIOD);
      const tc = (amount: bigint) => ({ type: token, data: ccc.hexFrom(u128le(amount)) });
      const key = cells.add({ lock: charger, capacity: 100n * CKB });
      const fund = () => cells.add({ lock: stranger, capacity: 200n * CKB });
      const charge = (aBack: bigint) =>
        tx(
          cells,
          [[cells.add({ lock: a.lock, capacity: 300n * CKB, ...tc(50n * T) }), mature], [key, 0n], [fund(), 0n]],
          [
            { lock: a.lock, capacity: aBack, type: token, data: u128le(40n * T) },
            { lock: payTo, capacity: 142n * CKB, type: token, data: u128le(10n * T) },
            { lock: charger, capacity: 100n * CKB },
          ],
        );
      // One subscription charged, the stranger paying for the payout cell and the fee: accepted.
      expect(await run(cells, charge(300n * CKB), [a])).toEqual({ A: 0 });
      // One shannon of CKB from the subscription toward the fee: refused, 12 (max_per_tx 0).
      expect(await run(cells, charge(300n * CKB - 1n), [a])).toEqual({ A: 12 });
      // Two token subscriptions with change in one transaction: each one's change is anyone else to the other, 13.
      const t = tx(
        cells,
        [
          [cells.add({ lock: a.lock, capacity: 300n * CKB, ...tc(50n * T) }), mature],
          [cells.add({ lock: b.lock, capacity: 300n * CKB, ...tc(50n * T) }), mature],
          [key, 0n],
          [fund(), 0n],
        ],
        [
          { lock: a.lock, capacity: 300n * CKB, type: token, data: u128le(40n * T) },
          { lock: b.lock, capacity: 300n * CKB, type: token, data: u128le(40n * T) },
          { lock: payTo, capacity: 142n * CKB, type: token, data: u128le(20n * T) },
          { lock: charger, capacity: 100n * CKB },
        ],
      );
      expect(await run(cells, t, [a, b])).toEqual({ A: 13, B: 13 });
    });

    it("mature and immature subscription inputs together: the young one refuses, 14, each group on its own", async () => {
      const { cells, charger, payTo, stranger, a, b } = setup();
      const key = cells.add({ lock: charger, capacity: 100n * CKB });
      const young = relativeBlocks(PERIOD - 1n);
      // Two subscriptions, A mature, B young, both taken whole, a stranger paying the fee.
      let t = tx(
        cells,
        [[cells.add({ lock: a.lock, capacity: PRICE }), mature], [cells.add({ lock: b.lock, capacity: PRICE }), young], [key, 0n], [cells.add({ lock: stranger, capacity: 70n * CKB }), 0n]],
        [{ lock: payTo, capacity: 2n * PRICE }, { lock: charger, capacity: 100n * CKB }],
      );
      expect(await run(cells, t, [a, b])).toEqual({ A: 0, B: 14 });
      // One subscription, a mature cell merged with a young one: refused, 14.
      t = tx(
        cells,
        [[cells.add({ lock: a.lock, capacity: 300n * CKB }), mature], [cells.add({ lock: a.lock, capacity: 300n * CKB }), young], [key, 0n]],
        [{ lock: payTo, capacity: PRICE }, { lock: a.lock, capacity: 400n * CKB }, { lock: charger, capacity: 100n * CKB - 1000n }],
      );
      expect(await run(cells, t, [a])).toEqual({ A: 14 });
      // The same with no since at all on the young one: refused, 14.
      t = tx(
        cells,
        [[cells.add({ lock: a.lock, capacity: 300n * CKB }), mature], [cells.add({ lock: a.lock, capacity: 300n * CKB }), 0n], [key, 0n]],
        [{ lock: payTo, capacity: PRICE }, { lock: a.lock, capacity: 400n * CKB }, { lock: charger, capacity: 100n * CKB - 1000n }],
      );
      expect(await run(cells, t, [a])).toEqual({ A: 14 });
    });

    it("group A sends into group B's change: A's outflow, B's top-up; refused where A's limit or a recipient says so", async () => {
      const cells = new Cells(new Rng(7));
      const keyA = plain("0x2003");
      const keyB = plain("0x2004");
      const ownerA = plain("0x1005");
      const ownerB = plain("0x1006");
      const recipient = plain("0x3003");
      const A = (maxPerTx: bigint, r?: ccc.Script) => makeGroup("A", "session", { owner: ownerA, key: keyA, maxPerTx, minInterval: 0n, ...(r && { recipient: r }) });
      const B = (r?: ccc.Script) => makeGroup("B", "session", { owner: ownerB, key: keyB, maxPerTx: 100n * CKB, minInterval: 0n, ...(r && { recipient: r }) });
      const shape = (a: Group, b: Group) =>
        tx(
          cells,
          [[cells.add({ lock: a.lock, capacity: 500n * CKB }), 0n], [cells.add({ lock: b.lock, capacity: 300n * CKB }), 0n], [cells.add({ lock: keyA, capacity: 100n * CKB }), 0n], [cells.add({ lock: keyB, capacity: 100n * CKB }), 0n]],
          [{ lock: a.lock, capacity: 450n * CKB }, { lock: b.lock, capacity: 350n * CKB }, { lock: keyA, capacity: 100n * CKB - 1000n }, { lock: keyB, capacity: 100n * CKB }],
        );
      // 50 CKB from A into B's change: within A's 100, B grows (outflow 0).
      expect(await run(cells, shape(A(100n * CKB), B()), [A(100n * CKB), B()])).toEqual({ A: 0, B: 0 });
      // A's limit 40: the move is A's outflow, refused, 12; B still accepts.
      expect(await run(cells, shape(A(40n * CKB), B()), [A(40n * CKB), B()])).toEqual({ A: 12, B: 0 });
      // B recipient-scoped: A's change and A's key cell are anyone else to B, 13.
      expect(await run(cells, shape(A(100n * CKB), B(recipient)), [A(100n * CKB), B(recipient)])).toEqual({ A: 0, B: 13 });
      // A recipient-scoped to someone else: B's change is not A's recipient, 13.
      expect(await run(cells, shape(A(100n * CKB, recipient), B()), [A(100n * CKB, recipient), B()])).toEqual({ A: 13, B: 0 });
      // A recipient-scoped to B's own lock: paying B is paying A's recipient, within A's limit, but keyB's cell is anyone else to A, 13.
      const b = B();
      expect(await run(cells, shape(A(100n * CKB, b.lock), b), [A(100n * CKB, b.lock), b])).toEqual({ A: 13, B: 0 });
      // The same with B spent by its owner (no key cell of B's in the outputs): A pays its recipient, B's lock, within its limit.
      const a = A(100n * CKB, b.lock);
      const t = tx(
        cells,
        [[cells.add({ lock: a.lock, capacity: 500n * CKB }), 0n], [cells.add({ lock: b.lock, capacity: 300n * CKB }), 0n], [cells.add({ lock: keyA, capacity: 100n * CKB }), 0n], [cells.add({ lock: ownerB, capacity: 100n * CKB }), 0n]],
        [{ lock: a.lock, capacity: 450n * CKB }, { lock: b.lock, capacity: 350n * CKB }, { lock: keyA, capacity: 100n * CKB - 1000n }],
      );
      expect(await run(cells, t, [a, b])).toEqual({ A: 0, B: 0 });
    });

    it("one key holding two sessions draws up to the sum of their limits, and no more", async () => {
      const cells = new Cells(new Rng(8));
      const key = plain("0x2005");
      const a = makeGroup("A", "session", { owner: plain("0x1007"), key, maxPerTx: 100n * CKB, minInterval: 0n });
      const b = makeGroup("B", "session", { owner: plain("0x1008"), key, maxPerTx: 50n * CKB, minInterval: 0n });
      const shape = (toKey: bigint) =>
        tx(
          cells,
          [[cells.add({ lock: a.lock, capacity: 500n * CKB }), 0n], [cells.add({ lock: b.lock, capacity: 500n * CKB }), 0n], [cells.add({ lock: key, capacity: 100n * CKB }), 0n]],
          [{ lock: a.lock, capacity: 400n * CKB }, { lock: b.lock, capacity: 500n * CKB - (toKey - 100n * CKB) }, { lock: key, capacity: 100n * CKB + toKey }],
        );
      expect(await run(cells, shape(150n * CKB), [a, b])).toEqual({ A: 0, B: 0 }); // 100 + 50
      expect(await run(cells, shape(150n * CKB + 1n), [a, b])).toEqual({ A: 0, B: 12 });
    });
  });
});
