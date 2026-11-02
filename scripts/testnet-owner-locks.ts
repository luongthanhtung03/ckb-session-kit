/**
 * The owner-lock allowlist on public testnet (mentor review, tracker #47, 2 Nov;
 * Week 6 plan: "the fixes on public testnet (... refused owner locks)").
 *
 *   deps     — each owner-lock class built as the real testnet script, from CCC's
 *              testnet table: code hash, hash type, and whether every cell dep it
 *              names is live on the node
 *   refusals — for each lock this script holds no key for, openSession with an
 *              owner whose lock it is: refused ones stop with their reason code
 *              before anything is signed or sent (the owner counts its signing
 *              calls and the client its sends: both must stay 0); the opt-in rows
 *              show allowUnreviewedOwnerLock turning "owner-lock-unreviewed" into a
 *              warning (openSession then goes on, and stops at funding: the lock
 *              has no cells), and PW-Lock refused even with the opt-in
 *   open     — for each accepted lock this script can sign for (secp256k1,
 *              multisig v2 1-of-1, Omnilock with Dogecoin auth, Nostr signing mode;
 *              keys derived from FUNDER_KEY), a real 130 CKB session opened and
 *              closed, everything swept back to the funder
 *   pw-proof — why PW-Lock is refused: a cell under the deployed PW-Lock code hash
 *              spent with no witness at all (its anyone-can-pay path), topped up by
 *              1 CKB. The 62 CKB stay under PW-Lock args nobody holds a key for;
 *              a later run reuses the cell instead of making another
 *
 * The derived keys are the same on every run, so a run cut short is swept back
 * at the start of the next one.
 *
 * Usage: npm run smoke:owner-locks [-- --dry-run] [-- --no-open] [-- --no-pw-proof]
 * Keys: FUNDER_KEY and CREATOR_KEY, else .env.smoke, else SMOKE_KEY_FILE=<path>.
 * CKB_RPC_URL defaults to https://testnet.ckbapp.dev/ here.
 * LOG=1 also writes docs/evidence/<date>-smoke-owner-locks.log.
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import {
  closeSession,
  createSession,
  openSession,
  recoverSessions,
  SessionBalanceError,
  type OnChainBinding,
  type Session,
  type SessionLockDeployment,
} from "../src/index.js";
import {
  balanceOf,
  checkOwnerLock,
  CKB,
  committed,
  deriveKey,
  errorText,
  explorer,
  isDryRun,
  OWNER_BUDGET,
  OWNER_FUNDING,
  OWNER_LOCK_CASES,
  ownerLockCost,
  ownerLockOptions,
  ownerLockVerdict,
  PW_CELL,
  PW_TOP_UP,
  rpcUrl,
  sleep,
  smokeKeys,
  startLog,
  sweepAll,
  type OwnerLockCase,
  type OwnerLockOptions,
  type OwnerLockSigner,
} from "./testnet-lib.js";

const DEFAULT_RPC = "https://testnet.ckbapp.dev/";
const deployment = JSON.parse(readFileSync("deployment/testnet.json", "utf8")) as SessionLockDeployment;
const fmt = (n: bigint) => ccc.fixedPointToString(n);
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

/** The lock of a key this script holds, from a key derived from `seed` (the funder's). */
function ownerSigner(kind: OwnerLockSigner, client: ccc.Client, seed: string): ccc.Signer {
  const key = deriveKey(seed, `owner-lock-${kind}`, 0);
  switch (kind) {
    case "secp256k1":
      return new ccc.SignerCkbPrivateKey(client, key);
    case "multisig": {
      const publicKey = new ccc.SignerCkbPrivateKey(client, key).publicKey;
      return new ccc.SignerMultisigCkbPrivateKey(
        client,
        key,
        { publicKeys: [publicKey], threshold: 1 },
        { scriptInfos: [ccc.KnownScript.Secp256k1MultisigV2] },
      );
    }
    case "omnilock-doge":
      return new ccc.SignerDogePrivateKey(client, key);
    case "nostr":
      return new ccc.SignerNostrPrivateKey(client, key);
  }
}

async function caseLock(c: OwnerLockCase, client: ccc.Client, seed: string): Promise<ccc.Script> {
  if ("signer" in c.lock) return (await ownerSigner(c.lock.signer, client, seed).getRecommendedAddressObj()).script;
  if ("known" in c.lock) return ccc.Script.from({ ...(await client.getKnownScript(c.lock.known)), args: c.lock.args });
  return ccc.Script.from(c.lock.script);
}

/**
 * An owner whose lock is `lock`, holding a throwaway key: it can sign nothing for
 * that lock, and counts every attempt (signing, sending) so a refusal can be shown
 * to come before any of them.
 */
class ProbeOwner extends ccc.SignerCkbPrivateKey {
  signs = 0;
  sends = 0;
  constructor(
    client: ccc.Client,
    private readonly lock: ccc.Script,
  ) {
    super(client, "0x" + "42".repeat(32));
  }
  async getAddressObjs() {
    return [ccc.Address.fromScript(this.lock, this.client)];
  }
  async getRecommendedAddressObj() {
    return ccc.Address.fromScript(this.lock, this.client);
  }
  async signOnlyTransaction(): Promise<ccc.Transaction> {
    this.signs++;
    throw new Error("probe owner: signing attempted");
  }
  async sendTransaction(): Promise<ccc.Hex> {
    this.sends++;
    throw new Error("probe owner: send attempted");
  }
}

function printPlan(o: OwnerLockOptions, seed: string): Promise<void> {
  const cost = ownerLockCost(o);
  console.log("dry run: nothing is sent, no key is read, no node is asked (CCC's testnet tables only)");
  console.log(`  rows ${OWNER_LOCK_CASES.length}; open+close a real session for ${cost.openers} owner lock(s)`);
  console.log(`  lent by the funder for the run: ${fmt(cost.lent)} CKB (${cost.openers} x ${fmt(OWNER_FUNDING)}), swept back`);
  console.log(`  PW-Lock proof: ${o.pwProof ? `${fmt(cost.spent)} CKB left under PW-Lock for good (${fmt(PW_CELL)} + ${fmt(PW_TOP_UP)})` : "skipped"}`);
  console.log("  expected verdicts, from assertSigningLock run offline on placeholder keys:");
  return verdictTable(new ccc.ClientPublicTestnet({ url: DEFAULT_RPC }), seed).then(() => undefined);
}

/** assertSigningLock on every row; prints one line per row, returns the rows that did not match. */
async function verdictTable(client: ccc.Client, seed: string): Promise<string[]> {
  const bad: string[] = [];
  for (const c of OWNER_LOCK_CASES) {
    const lock = await caseLock(c, client, seed);
    const r = await checkOwnerLock(lock, client, c.optIn);
    const ok = r.verdict === c.expect;
    if (!ok) bad.push(c.name);
    const warned = r.warnings.length ? " (warned)" : "";
    console.log(`  ${ok ? "✓" : "✗"} ${c.name.padEnd(40)} ${r.verdict}${warned}  — ${c.why}`);
  }
  return bad;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts = ownerLockOptions(argv);
  if (isDryRun(argv)) return printPlan(opts, "0x" + "07".repeat(32));
  const { funderKey, created } = smokeKeys();
  if (created) {
    console.log(`created .env.smoke (at the repository root) with two new testnet keys: fund the funder from https://faucet.nervos.org, then run again`);
    return;
  }
  const logFile = startLog("smoke-owner-locks");
  const url = rpcUrl(process.env, DEFAULT_RPC);
  const client = new ccc.ClientPublicTestnet({ url });
  const funder = new ccc.SignerCkbPrivateKey(client, funderKey);
  const funderLock = (await funder.getRecommendedAddressObj()).script;
  const before = await balanceOf(client, funderLock);
  console.log(`node ${url}, tip ${await client.getTip()}`);
  console.log(`funder ${await funder.getRecommendedAddress()}: ${fmt(before)} CKB`);
  console.log(`session lock ${deployment.codeHash} (${deployment.hashType})`);
  const failures: string[] = [];

  // --- deps --------------------------------------------------------------
  console.log("\ndeps: each lock class as the real testnet script, and whether its cell deps are live");
  const knowns = [...new Set(OWNER_LOCK_CASES.flatMap((c) => ("known" in c.lock ? [c.lock.known] : [])))];
  knowns.push(ccc.KnownScript.Secp256k1Blake160, ccc.KnownScript.Secp256k1MultisigV2);
  for (const k of [...new Set(knowns)]) {
    const info = await client.getKnownScript(k);
    const deps = await Promise.all(
      info.cellDeps.map(async (d) => {
        const op = d.cellDep.outPoint;
        const live = await client.getCellLive(op, false, false);
        return `${short(op.txHash)}:${op.index} ${d.cellDep.depType} ${live ? "live" : "NOT LIVE"}`;
      }),
    );
    if (deps.some((d) => d.endsWith("NOT LIVE"))) failures.push(`deps of ${k}`);
    console.log(`  ${k.padEnd(20)} ${info.codeHash} ${info.hashType}`);
    for (const d of deps) console.log(`      dep ${d}`);
  }

  // --- verdicts ----------------------------------------------------------
  console.log("\nverdicts: assertSigningLock on every row (✓ = the verdict the allowlist promises)");
  failures.push(...(await verdictTable(client, funderKey)).map((n) => `verdict of ${n}`));

  // --- refusals ----------------------------------------------------------
  console.log("\nrefusals: openSession with an owner under each lock this script cannot sign for");
  for (const c of OWNER_LOCK_CASES.filter((c) => !("signer" in c.lock))) {
    const probeClient = new ccc.ClientPublicTestnet({ url });
    let nodeSends = 0;
    const send = probeClient.sendTransaction.bind(probeClient);
    probeClient.sendTransaction = (async (...args: Parameters<typeof send>) => {
      nodeSends++;
      return send(...args);
    }) as typeof probeClient.sendTransaction;
    const lock = await caseLock(c, probeClient, funderKey);
    const owner = new ProbeOwner(probeClient, lock);
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    let error: unknown;
    try {
      await openSession(owner, probeSession(funderKey, 99), deployment, {
        budget: OWNER_BUDGET,
        allowUnreviewedOwnerLock: c.optIn,
        onWarning: () => {},
      });
    } catch (e) {
      error = e;
    } finally {
      console.warn = warn;
    }
    const untouched = owner.signs === 0 && owner.sends === 0 && nodeSends === 0;
    const tag = c.optIn ? " [allowUnreviewedOwnerLock]" : "";
    let verdict: string;
    try {
      verdict = ownerLockVerdict(error);
    } catch {
      verdict = "accepted"; // past the owner check, stopped by something else
    }
    const ok = verdict === c.expect && untouched;
    if (!ok) failures.push(`refusal of ${c.name}`);
    console.log(`  ${ok ? "✓" : "✗"} ${c.name}${tag}`);
    console.log(`      lock ${short(lock.codeHash)} ${lock.hashType} args ${lock.args}`);
    if (verdict !== "accepted") {
      console.log(`      refused: reason "${verdict}": ${(error as Error).message}`);
    } else {
      for (const w of warnings) console.log(`      warning: ${w}`);
      if (!c.optIn) console.log("      accepted; this script holds no key for this lock, so no session is opened under it");
      const stop = error instanceof Error ? error.message : String(error ?? "nothing (opened?)");
      console.log(`      past the owner check; openSession stopped at funding: ${stop.slice(0, 160)}`);
    }
    console.log(`      signing calls ${owner.signs}, owner sends ${owner.sends}, node sends ${nodeSends}`);
  }

  // --- open --------------------------------------------------------------
  const openers = OWNER_LOCK_CASES.filter((c): c is OwnerLockCase & { lock: { signer: OwnerLockSigner } } => "signer" in c.lock);
  if (opts.open) {
    const owners = openers.map((c, i) => ({
      c,
      owner: ownerSigner(c.lock.signer, client, funderKey),
      key: deriveKey(funderKey, "owner-lock-session", i),
      session: probeSession(funderKey, i),
      binding: undefined as OnChainBinding | undefined,
    }));
    await reclaim(owners, funderLock, "reclaim: anything a cut-short run left, back to the funder");

    console.log(`\nopen: one ${fmt(OWNER_FUNDING)} CKB cell for each of ${owners.length} owners, in one transaction`);
    const funding = ccc.Transaction.from({ outputs: [] });
    for (const o of owners) funding.addOutput({ lock: (await o.owner.getRecommendedAddressObj()).script, capacity: OWNER_FUNDING });
    await funding.completeInputsByCapacity(funder);
    await funding.completeFeeBy(funder);
    const fundHash = await funder.sendTransaction(funding);
    console.log(`  ${explorer(fundHash)}`);
    await committed(client, fundHash);
    await sleep(3000);

    for (const o of owners) {
      const lock = (await o.owner.getRecommendedAddressObj()).script;
      console.log(`  ${o.c.name}: lock ${short(lock.codeHash)} ${lock.hashType} args ${lock.args}`);
      try {
        const warnings: string[] = [];
        const { txHash, binding } = await openSession(o.owner, o.session, deployment, {
          budget: OWNER_BUDGET,
          onWarning: (w) => void warnings.push(w.code),
        });
        o.binding = binding;
        console.log(`      opened ${fmt(OWNER_BUDGET)} CKB (session warnings: ${warnings.join(", ") || "none"}): ${explorer(txHash)}`);
        await committed(client, txHash);
        const closed = await closeWithRetry(o.owner, o.session, binding);
        if (closed.sweepTx) console.log(`      closed, session swept to the owner: ${explorer(closed.sweepTx)}`);
        if (closed.keyTx) console.log(`      key cell back to the owner: ${explorer(closed.keyTx)}`);
        if (closed.keyError) console.log(`      key cell not returned: ${closed.keyError}`);
        if (!closed.sweepTx) failures.push(`close of ${o.c.name}`);
        for (const h of [closed.sweepTx, closed.keyTx]) if (h) await committed(client, h);
        o.binding = undefined;
      } catch (e) {
        failures.push(`open/close of ${o.c.name}`);
        console.log(`      ✗ ${errorText(e)}`);
      }
    }
    await reclaim(owners, funderLock, "\nsweep: every owner's and key's CKB back to the funder");
  } else {
    console.log("\nopen: skipped (--no-open)");
  }

  // --- pw-proof ----------------------------------------------------------
  if (opts.pwProof) {
    try {
      await pwProof(client, funder, funderKey);
    } catch (e) {
      failures.push("PW-Lock proof");
      console.log(`  ✗ ${errorText(e)}`);
    }
  } else {
    console.log("\npw-proof: skipped (--no-pw-proof)");
  }

  await sleep(3000);
  const after = await balanceOf(client, funderLock);
  console.log(`\nfunder: ${fmt(before)} → ${fmt(after)} CKB, net spend ${fmt(before - after)} CKB`);
  console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "all rows as expected");
  if (logFile) console.log(`log: ${logFile}`);
  if (failures.length) process.exitCode = 1;
}

/** A session with key bytes fixed by `index`, so a run cut short can be swept back. */
function probeSession(seed: string, index: number): Session {
  const key = deriveKey(seed, "owner-lock-session", index);
  return createSession(
    { expiresAt: new Date(Date.now() + 3 * 3_600_000), scope: { maxPerTx: 5n * CKB } },
    { randomBytes: () => ccc.bytesFrom(key) },
  );
}

/** closeSession, again while the indexer has not caught up with the opening. */
async function closeWithRetry(owner: ccc.Signer, session: Session, binding: OnChainBinding) {
  for (let i = 0; ; i++) {
    try {
      const r = await closeSession(owner, session, deployment, binding);
      if (r.nothingFound && i < 12) throw new SessionBalanceError("nothing indexed yet");
      return r;
    } catch (e) {
      if (!(e instanceof SessionBalanceError) || i >= 12) throw e;
      owner.client.cache.clear();
      await sleep(5000);
    }
  }
}

async function reclaim(
  owners: { c: OwnerLockCase; owner: ccc.Signer; key: ccc.Hex }[],
  funderLock: ccc.Script,
  what: string,
): Promise<void> {
  let printed = false;
  const say = (line: string) => {
    if (!printed) console.log(what);
    printed = true;
    console.log(line);
  };
  for (const { c, owner, key } of owners) {
    try {
      const client = owner.client;
      const keyBack = await sweepAll(new ccc.SignerCkbPrivateKey(client, key), funderLock);
      if (keyBack) {
        say(`  ${c.name}: key cell(s), ${fmt(keyBack.amount)} CKB: ${explorer(keyBack.hash)}`);
        await committed(client, keyBack.hash);
      }
      const rec = await recoverSessions(owner, deployment);
      for (const h of rec.txHashes) {
        say(`  ${c.name}: session(s) recovered, ${fmt(rec.recovered)} CKB: ${explorer(h)}`);
        await committed(client, h);
      }
      if (rec.txHashes.length) await sleep(3000);
      client.cache.clear();
      const back = await sweepAll(owner, funderLock);
      if (back) {
        say(`  ${c.name} → funder, ${fmt(back.amount)} CKB: ${explorer(back.hash)}`);
        await committed(client, back.hash);
      }
    } catch (e) {
      say(`  ✗ ${c.name}: ${errorText(e)} (run again to sweep it)`);
    }
  }
}

/**
 * A cell under the deployed PW-Lock, spent with no witness for it at all: the
 * transaction carries the funder's signature for the funder's own input only.
 */
async function pwProof(client: ccc.Client, funder: ccc.SignerCkbPrivateKey, seed: string): Promise<void> {
  const info = await client.getKnownScript(ccc.KnownScript.PWLock);
  // 20 bytes of a hash: no Ethereum key is known for them.
  const args = ccc.hexFrom(ccc.bytesFrom(deriveKey(seed, "pw-proof", 0)).slice(0, 20));
  const pwLock = ccc.Script.from({ codeHash: info.codeHash, hashType: info.hashType, args });
  console.log(`\npw-proof: why PW-Lock is refused. PW-Lock ${info.codeHash} (${info.hashType}), args ${args}`);

  let cell: ccc.Cell | undefined;
  for await (const c of client.findCellsByLock(pwLock, null, true)) {
    cell = c;
    break;
  }
  if (cell) {
    console.log(`  reusing the cell a previous run left: ${cell.outPoint.txHash}:${cell.outPoint.index}, ${fmt(cell.cellOutput.capacity)} CKB`);
  } else {
    const tx = ccc.Transaction.from({ outputs: [{ lock: pwLock, capacity: PW_CELL }] });
    await tx.completeInputsByCapacity(funder);
    await tx.completeFeeBy(funder);
    const hash = await funder.sendTransaction(tx);
    console.log(`  a ${fmt(PW_CELL)} CKB cell under PW-Lock: ${explorer(hash)}`);
    await committed(client, hash);
    cell = (await client.getCell({ txHash: hash, index: 0 }))!;
  }

  // Funder inputs first (their witness is the signature at index 0), the PW-Lock
  // input after them, with no witness: PW-Lock finds none and takes its
  // anyone-can-pay path, which only asks that the cell come back with no less.
  const tx = ccc.Transaction.from({ outputs: [{ lock: pwLock, capacity: cell.cellOutput.capacity + PW_TOP_UP }] });
  await tx.completeInputsByCapacity(funder);
  const pwIndex = tx.inputs.length;
  tx.inputs.push(ccc.CellInput.from({ previousOutput: cell.outPoint }));
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.PWLock);
  await tx.completeFeeBy(funder);
  const signed = await funder.signTransaction(tx);
  const pwWitness = signed.witnesses[pwIndex];
  if (pwWitness !== undefined && pwWitness !== "0x") throw new Error(`the PW-Lock input got a witness: ${pwWitness}`);
  console.log(
    `  spend: inputs ${signed.inputs.length} (PW-Lock at ${pwIndex}), witnesses ${signed.witnesses.length}: ` +
      `the PW-Lock input has ${pwWitness === undefined ? "no witness" : "an empty witness"}, no signature`,
  );
  try {
    const hash = await client.sendTransaction(signed);
    console.log(`  accepted with no signature, PW-Lock cell ${fmt(cell.cellOutput.capacity)} → ${fmt(cell.cellOutput.capacity + PW_TOP_UP)} CKB: ${explorer(hash)}`);
    await committed(client, hash);
    console.log("  committed: an input under PW-Lock needs nobody's signature, so a stranger could add one to any");
    console.log("  transaction and get the session lock's owner mode. Hence \"owner-lock-unsafe\", opt-in or not.");
  } catch (e) {
    console.log(`  refused by the node: ${errorText(e)}`);
    console.log("  not clear-cut on chain: the refusal rests on the source (lay2dev/pw-lock, secp256k1_keccak256_sighash_all_acpl)");
    throw e;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
