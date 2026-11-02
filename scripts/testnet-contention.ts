/**
 * Payout cell contention on testnet (mentor review, tracker #47, 2 Nov): several
 * readers pay one creator at the same moment, each from its own browser-like
 * client, and every payment lands.
 *
 *   node    — the node's fee and RBF settings (tx_pool_info: RBF is on when
 *             min_rbf_rate > min_fee_rate)
 *   cells   — the creator has CELLS plain anyone-can-pay cells (createPayoutCells
 *             adds what is missing, paid by the funder; they stay the creator's)
 *   payers  — PAYERS keys derived from FUNDER_KEY, funded in one transaction; each
 *             opens a 160 CKB session that can only pay the creator
 *   rounds  — ROUNDS times, every payer pays 1 CKB with topUp at once (Promise.all).
 *             Per payer: the payout cell each send consumed, the node's refusals
 *             (full text), pool checks, the final hash. A round passes when every
 *             payment commits: no two payers took one cell, or each one that lost
 *             a cell was refused and retried to a committed payment
 *   pool    — get_live_cell with include_tx_pool on a cell a pending top-up spends
 *             (expected: not live), and without the pool (expected: live)
 *   clash   — a second top-up of that same cell, built by hand outside the
 *             library's pick and sent while the first is pending: the node's exact
 *             refusal (Dead(OutPoint) with RBF off, RBFRejected -1111 with RBF on),
 *             and whether the library would retry it
 *   sweep   — sessions closed, every payer's and the probe's CKB back to the funder
 *
 * The derived keys are the same on every run, so a run cut short is swept back
 * at the start of the next one.
 *
 * Usage: FUNDER_KEY=0x... CREATOR_KEY=0x... npm run smoke:contention
 *        [-- --payers=4 --rounds=2 --cells=8] [-- --dry-run]
 * LOG=1 also writes docs/evidence/<date>-smoke-contention.log.
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import {
  closeSession,
  createPayoutCells,
  createSession,
  openSession,
  paymentMemo,
  poolConflict,
  recoverSessions,
  spendInSession,
  type OnChainBinding,
  type Session,
  type SessionLockDeployment,
} from "../src/index.js";
import { deadInputs } from "../src/onchain.js";
import {
  analyseRound,
  balanceOf,
  CKB,
  classifyRejection,
  committed,
  contentionCost,
  contentionOptions,
  deriveKey,
  errorText,
  explorer,
  instrument,
  isDryRun,
  liveStatus,
  outPointText,
  PAYER_BUDGET,
  PAYER_FUNDING,
  PAYMENT,
  plainCells,
  poolInfo,
  PROBE_FUNDING,
  rpcUrl,
  startLog,
  sweepAll,
  type ContentionOptions,
  type PayerRound,
  type RoundAnalysis,
  sleep,
  smokeKeys,
  SMOKE_KEY_FILE,
} from "./testnet-lib.js";

/** How long the pool view may lag a sent transaction before the check fails. */
const POOL_VIEW_WAIT_MS = 5_000;
const deployment = JSON.parse(readFileSync("deployment/testnet.json", "utf8")) as SessionLockDeployment;
const fmt = (n: bigint) => ccc.fixedPointToString(n);

interface Payer {
  index: number;
  client: ccc.Client;
  owner: ccc.SignerCkbPrivateKey;
  keySigner: ccc.SignerCkbPrivateKey;
  session: Session;
  binding?: OnChainBinding;
  current?: PayerRound;
}

/** The creator's payout cells this round, by "txHash:index". */
let payoutCells = new Map<string, ccc.Cell>();

function makePayer(funderKey: string, index: number, url: string, acpAddress: string): Payer {
  // Its own client and cache, like a reader's browser.
  const client = new ccc.ClientPublicTestnet({ url });
  const owner = new ccc.SignerCkbPrivateKey(client, deriveKey(funderKey, "contention-payer", index));
  const sessionKey = deriveKey(funderKey, "contention-session", index);
  // The library's own createSession, with the key bytes fixed so a run cut short can be swept back.
  const session = createSession(
    { expiresAt: new Date(Date.now() + 3 * 3_600_000), scope: { maxPerTx: 5n * CKB, recipients: [acpAddress] } },
    { randomBytes: () => ccc.bytesFrom(sessionKey) },
  );
  const payer: Payer = { index, client, owner, keySigner: new ccc.SignerCkbPrivateKey(client, sessionKey), session };
  instrument(client, (op) => payoutCells.has(op), () => payer.current);
  return payer;
}

function printPlan(o: ContentionOptions): void {
  const worst = contentionCost(o, 0);
  console.log(`dry run: nothing is sent, no key is read`);
  console.log(`  payers ${o.payers}, rounds ${o.rounds}, payout cells wanted ${o.cells}`);
  console.log(`  needs FUNDER_KEY (funds everything) and CREATOR_KEY (only its anyone-can-pay address is used)`);
  console.log(`  lent by the funder for the run: ${fmt(worst.lent)} CKB (${o.payers} x ${fmt(PAYER_FUNDING)} + ${fmt(PROBE_FUNDING)} probe), swept back`);
  console.log(`  new payout cells: up to ${worst.created} x 61 = ${fmt(worst.payoutCells)} CKB, kept by the creator`);
  console.log(`  paid to the creator: ${fmt(worst.paid)} CKB (1 per payer per round, 1 by the probe), plus fees`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts = contentionOptions(argv);
  if (isDryRun(argv)) return printPlan(opts);
  const { funderKey, creatorKey, created } = smokeKeys();
  if (created) {
    const funderAddress = await new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet({ url: rpcUrl() }), funderKey).getRecommendedAddress();
    console.log(`created ${SMOKE_KEY_FILE} with two new testnet keys`);
    console.log(`fund this address from https://faucet.nervos.org, then run again:
  ${funderAddress}`);
    return;
  }
  const logFile = startLog("smoke-contention");
  const url = rpcUrl();
  const client = new ccc.ClientPublicTestnet({ url });
  const funder = new ccc.SignerCkbPrivateKey(client, funderKey);
  const funderLock = (await funder.getRecommendedAddressObj()).script;
  const creatorArgs = (await new ccc.SignerCkbPrivateKey(client, creatorKey).getRecommendedAddressObj()).script.args;
  const acp = await ccc.Address.fromKnownScript(client, ccc.KnownScript.AnyoneCanPay, creatorArgs);
  const acpAddress = acp.toString();

  const node = await poolInfo(url);
  console.log(`node: ${url} ${node.version ?? ""}`);
  console.log(
    `  tx_pool_info: min_fee_rate ${node.minFeeRate}, min_rbf_rate ${node.minRbfRate} shannons/KB: ` +
      `RBF ${node.rbf ? "on" : "off"}; ${node.pending} transactions pending`,
  );
  console.log(`creator: ${acpAddress}`);
  console.log(`payers ${opts.payers}, rounds ${opts.rounds}, payout cells wanted ${opts.cells}`);

  const payers = Array.from({ length: opts.payers }, (_, i) => makePayer(funderKey, i + 1, url, acpAddress));
  const probe = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet({ url }), deriveKey(funderKey, "contention-probe", 0));
  for (const p of payers) console.log(`  payer ${p.index}: ${(await p.owner.getRecommendedAddressObj()).toString()}`);
  console.log(`  probe  : ${(await probe.getRecommendedAddressObj()).toString()}`);

  // A run cut short leaves funds under the derived keys: take them back first.
  await reclaim(payers, probe, funderLock, "setup: funds left by an earlier run");
  const funderBefore = await balanceOf(client, funderLock);
  console.log(`funder balance ${fmt(funderBefore)} CKB`);

  const rounds: RoundAnalysis[] = [];
  let clash: { ok: boolean; why: string } = { ok: false, why: "not run" };
  let failure: unknown;
  try {
    const have = (await plainCells(client, acp.script)).length;
    const cost = contentionCost(opts, have);
    console.log(
      `cost: ${fmt(cost.lent)} CKB lent and swept back; ${cost.created} new payout cell(s), ${fmt(cost.payoutCells)} CKB kept by the creator; ` +
        `${fmt(cost.paid)} CKB paid to the creator; plus fees`,
    );
    if (cost.created) {
      console.log(`setup: ${cost.created} more payout cell(s) for the creator (createPayoutCells, ${have} already)`);
      const hash = await createPayoutCells(funder, acpAddress, { count: cost.created });
      console.log(`  ${explorer(hash)}`);
      await committed(client, hash);
    } else {
      console.log(`setup: the creator already has ${have} payout cells, reused`);
    }

    console.log(`setup: fund ${opts.payers} payers (${fmt(PAYER_FUNDING)} CKB each) and the probe (${fmt(PROBE_FUNDING)}), one transaction`);
    const funding = ccc.Transaction.from({
      outputs: [
        ...(await Promise.all(payers.map(async (p) => ({ lock: (await p.owner.getRecommendedAddressObj()).script, capacity: PAYER_FUNDING })))),
        { lock: (await probe.getRecommendedAddressObj()).script, capacity: PROBE_FUNDING },
      ],
    });
    await funding.completeInputsByCapacity(funder);
    await funding.completeFeeBy(funder);
    const fundHash = await funder.sendTransaction(funding);
    console.log(`  ${explorer(fundHash)}`);
    await committed(client, fundHash);

    console.log(`open: each payer opens a ${fmt(PAYER_BUDGET)} CKB session that can only pay the creator (no rate limit)`);
    const warnings = new Set<string>();
    await Promise.all(
      payers.map(async (p) => {
        const { txHash, binding } = await openSession(p.owner, p.session, deployment, {
          budget: PAYER_BUDGET,
          onWarning: (w) => void warnings.add(w.code),
        });
        p.binding = binding;
        p.session.onchain = binding;
        console.log(`  payer ${p.index}: ${explorer(txHash)}`);
        await committed(p.client, txHash);
      }),
    );
    if (warnings.size) console.log(`  warnings as expected: ${[...warnings].join(", ")}`);

    for (let r = 1; r <= opts.rounds; r++) rounds.push(await round(r, payers, client, acp, acpAddress, url));
    clash = await conflict(client, funder, probe, acp, url, node.rbf);
  } catch (e) {
    failure = e;
    console.error(`stopped: ${errorText(e)}`);
  } finally {
    await reclaim(payers, probe, funderLock, "sweep: sessions closed, everything back to the funder");
  }
  const funderAfter = await balanceOf(client, funderLock);
  console.log(`funder balance ${fmt(funderBefore)} → ${fmt(funderAfter)} CKB: spent ${fmt(funderBefore - funderAfter)} CKB in all`);
  if (failure) throw failure;

  const bad = rounds.flatMap((a, i) => (a.ok ? [] : [i + 1]));
  console.log(
    `summary: ${rounds.length} round(s) of ${opts.payers} simultaneous payments; ` +
      `${rounds.reduce((s, a) => s + a.firstCollisions.length, 0)} first-pick collision(s), ` +
      `${rounds.reduce((s, a) => s + a.retriedToSuccess.length, 0)} payment(s) retried to success; clash: ${clash.why}`,
  );
  if (bad.length || !clash.ok) throw new Error(`FAILED: ${bad.length ? `round(s) ${bad.join(", ")}` : ""}${!clash.ok ? ` clash: ${clash.why}` : ""}`);
  console.log("done: every simultaneous payment committed; the node's refusal of a double top-up is one the library retries");
  if (logFile) console.log(`log: ${logFile}`);
}

async function round(
  r: number,
  payers: Payer[],
  client: ccc.Client,
  acp: ccc.Address,
  acpAddress: string,
  url: string,
): Promise<RoundAnalysis> {
  payoutCells = new Map((await plainCells(client, acp.script)).map((c) => [outPointText(c.outPoint), c]));
  const before = await balanceOf(client, acp.script);
  console.log(`round ${r}: ${payers.length} payers pay 1 CKB each into the creator at the same moment (${payoutCells.size} payout cells)`);
  for (const p of payers) p.current = { payer: p.index, sends: [], checks: 0, taken: 0, committed: false };
  const started = Date.now();
  await Promise.all(
    payers.map(async (p) => {
      const rec = p.current!;
      try {
        rec.final = await spendInSession(p.session, p.client, deployment, p.binding!, {
          to: acpAddress,
          amount: PAYMENT,
          topUp: true,
          memo: paymentMemo(`contention:round-${r}:payer-${p.index}`),
        });
      } catch (e) {
        rec.error = errorText(e);
      }
    }),
  );
  const elapsed = Date.now() - started;
  const recs = payers.map((p) => p.current!);
  for (const p of payers) p.current = undefined;

  for (const rec of recs) {
    // A send that threw while the node took it anyway is the payment (signAndSend returned its hash).
    for (const s of rec.sends) if (s.hash === rec.final) delete s.error;
    const last = rec.sends.find((s) => s.hash === rec.final);
    const refusals = rec.sends.filter((s) => s.error).length;
    console.log(
      `  payer ${rec.payer}: ${rec.sends.length} send(s), ${refusals} refused, ` +
        `${rec.checks} pool check(s) (${rec.taken} spent in the pool)`,
    );
    for (const [i, s] of rec.sends.entries()) {
      if (s.error) console.log(`    attempt ${i + 1}: cell ${s.cell ?? "?"}, tx ${s.hash} refused (${s.kind}): ${s.error}`);
      else console.log(`    attempt ${i + 1}: cell ${s.cell ?? "?"}, accepted`);
    }
    if (rec.error) {
      console.log(`    ✗ payment failed: ${rec.error}`);
      continue;
    }
    // The pool's view of the cell this payment spends, before it commits.
    const cell = last?.cell && payoutCells.get(last.cell);
    if (cell) {
      const [seen, tx] = await Promise.all([liveStatus(url, cell.outPoint), client.getTransaction(rec.final!)]);
      console.log(`    pool view of ${last!.cell} (payment ${tx?.status ?? "?"}): include_tx_pool → ${seen.withPool}, without → ${seen.withoutPool}`);
    }
  }
  await Promise.all(
    recs.map(async (rec) => {
      if (!rec.final) return;
      try {
        await committed(client, rec.final);
        rec.committed = true;
        console.log(`  ✓ payer ${rec.payer}: ${explorer(rec.final)}`);
      } catch (e) {
        console.log(`  ✗ payer ${rec.payer}: ${rec.final} not committed: ${errorText(e)}`);
      }
    }),
  );
  const a = analyseRound(recs);
  const after = await balanceOf(client, acp.script);
  console.log(`  sent in ${(elapsed / 1000).toFixed(1)} s; creator's anyone-can-pay balance ${fmt(before)} → ${fmt(after)} CKB`);
  console.log(
    `  first picks: ${a.firstCollisions.length ? a.firstCollisions.map((c) => `payers ${c.payers.join("+")} on ${c.cell}`).join("; ") : "no two payers on one cell"}`,
  );
  if (a.retriedToSuccess.length) console.log(`  retried to success: payer(s) ${a.retriedToSuccess.join(", ")}`);
  if (a.doubleAccepted.length) console.log(`  ✗ two accepted payments on one cell: ${a.doubleAccepted.join(", ")}`);
  console.log(a.ok ? `  ✓ round ${r}: all ${recs.length} payments committed` : `  ✗ round ${r}: payer(s) ${a.failed.join(", ")} did not commit`);
  return a;
}

/**
 * Two top-ups of one payout cell: A by the funder, then B by the probe key while
 * A is pending, both at the node's current fee rate. B is built by hand, so no
 * pick or pool check steers it away from A's cell.
 */
async function conflict(
  client: ccc.Client,
  funder: ccc.Signer,
  probe: ccc.Signer,
  acp: ccc.Address,
  url: string,
  rbf: boolean,
): Promise<{ ok: boolean; why: string }> {
  console.log("clash: two top-ups of one payout cell, the second built by hand outside the library's pick");
  let target: ccc.Cell | undefined;
  for (const c of await plainCells(client, acp.script)) {
    if ((await liveStatus(url, c.outPoint)).withPool === "live") {
      target = c;
      break;
    }
  }
  if (!target) return { ok: false, why: "no payout cell free in the pool" };
  const feeRate = await client.getFeeRate();
  const topUp = async (signer: ccc.Signer) => {
    const tx = ccc.Transaction.from({
      inputs: [{ previousOutput: target.outPoint }],
      outputs: [{ lock: acp.script, capacity: target.cellOutput.capacity + PAYMENT }],
      outputsData: ["0x"],
    });
    await tx.addCellDepsOfKnownScripts(signer.client, ccc.KnownScript.AnyoneCanPay);
    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer, feeRate);
    return signer.signTransaction(tx);
  };
  const cell = outPointText(target.outPoint);
  const a = await topUp(funder);
  const hashA = await client.sendTransaction(a);
  console.log(`  A, the funder tops up ${cell} by 1 CKB (fee rate ${feeRate}): ${explorer(hashA)}`);
  // The node verifies a sent transaction before it enters the pool, so for a moment the pool view
  // still shows its inputs live. Measure that window: a pick inside it is what the retry covers.
  const sentAt = Date.now();
  let pending = await liveStatus(url, target.outPoint);
  const firstView = pending.withPool;
  while (pending.withPool === "live" && Date.now() - sentAt < POOL_VIEW_WAIT_MS) {
    await sleep(100);
    pending = await liveStatus(url, target.outPoint);
  }
  const statusA = (await client.getTransaction(hashA))?.status;
  const poolOk = statusA === "committed" || pending.withPool !== "live";
  console.log(
    `  pool view of ${cell} right after A was sent: get_live_cell include_tx_pool=true → ${firstView}` +
      (firstView === "live" ? ` (A not in the pool yet); → ${pending.withPool} after ${Date.now() - sentAt} ms` : "") +
      `, false → ${pending.withoutPool}, A ${statusA} ${poolOk ? "✓" : "✗ (a pick would take this cell)"}`,
  );

  const b = await topUp(probe);
  const hashB = b.hash();
  let refusedOk = false;
  let why: string;
  try {
    await probe.client.sendTransaction(b);
    // With RBF on, a B paying enough more would replace A; at the same rate it should not.
    why = `B ${hashB} was ACCEPTED: the node ${rbf ? "replaced A with it (RBF)" : "took both"}`;
    console.log(`  ✗ ${why}: ${explorer(hashB)}`);
  } catch (e) {
    const text = errorText(e);
    const kind = classifyRejection(text);
    const retried = deadInputs(e) || poolConflict(e);
    refusedOk = (kind === "rbf" || kind === "dead" || kind === "unknown") && retried;
    console.log(`  B, the probe tops up the same cell: tx ${hashB} (never committed)`);
    console.log(`  ✓ refused by the node (${kind}): ${text}`);
    console.log(
      `    ${kind === "rbf" ? "RBF is on at this node: a conflict is refused as an RBF replacement that pays too little" : kind === "dead" ? "RBF is off at this node: a conflict is refused as a dead input" : "neither RBF nor Dead"}` +
        `; the library ${retried ? "retries it (deadInputs/poolConflict)" : "would NOT retry it"}`,
    );
    why = `B refused as ${kind}, ${retried ? "retried" : "not retried"} by the library`;
  }
  await committed(client, hashA);
  const spent = await liveStatus(url, target.outPoint);
  console.log(`  ✓ A committed; ${cell} now: include_tx_pool → ${spent.withPool}, without → ${spent.withoutPool}`);
  return { ok: refusedOk && poolOk, why };
}

/** Sessions closed (or recovered by the owner), key cells and every payer's and the probe's CKB back to the funder. */
async function reclaim(payers: Payer[], probe: ccc.Signer, funderLock: ccc.Script, what: string): Promise<void> {
  let printed = false;
  const say = (line: string) => {
    if (!printed) console.log(what);
    printed = true;
    console.log(line);
  };
  await Promise.all(
    payers.map(async (p) => {
      try {
        const waits: ccc.Hex[] = [];
        if (p.binding) {
          const { keyTx, sweepTx, keyError } = await closeSession(p.owner, p.session, deployment, p.binding);
          if (keyTx) say(`  payer ${p.index} key cell back: ${explorer(keyTx)}`);
          if (sweepTx) say(`  payer ${p.index} session swept: ${explorer(sweepTx)}`);
          if (keyError) say(`  payer ${p.index} key cell not returned: ${keyError}`);
          waits.push(...[keyTx, sweepTx].filter((h): h is ccc.Hex => !!h));
          p.binding = undefined;
        } else {
          const key = await sweepAll(p.keySigner, funderLock);
          if (key) say(`  payer ${p.index} key cell(s), ${fmt(key.amount)} CKB: ${explorer(key.hash)}`);
          const rec = await recoverSessions(p.owner, deployment);
          for (const h of rec.txHashes) say(`  payer ${p.index} session(s) recovered, ${fmt(rec.recovered)} CKB: ${explorer(h)}`);
          waits.push(...(key ? [key.hash] : []), ...rec.txHashes);
        }
        for (const h of waits) await committed(p.client, h);
        p.client.cache.clear();
        const back = await sweepAll(p.owner, funderLock);
        if (back) {
          say(`  payer ${p.index} → funder, ${fmt(back.amount)} CKB: ${explorer(back.hash)}`);
          await committed(p.client, back.hash);
        }
      } catch (e) {
        say(`  ✗ payer ${p.index}: ${errorText(e)} (run again to sweep it)`);
      }
    }),
  );
  try {
    const back = await sweepAll(probe, funderLock);
    if (back) {
      say(`  probe → funder, ${fmt(back.amount)} CKB: ${explorer(back.hash)}`);
      await committed(probe.client, back.hash);
    }
  } catch (e) {
    say(`  ✗ probe: ${errorText(e)} (run again to sweep it)`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
