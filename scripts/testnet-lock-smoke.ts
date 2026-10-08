/**
 * The session lock, enforced by the real testnet — not a simulator.
 *
 *  1. Owner funds two session cells (one with a rate limit) and the session key's
 *     key cell. A session-lock cell occupies 121 CKB (80-byte args), so every
 *     change output here stays above that.
 *  2. Session spends exactly max_per_tx            → the network accepts it.
 *  3. Session tries one shannon over max_per_tx    → the network rejects it (12).
 *  4. Rate-limited cell, spent with no since       → the network rejects it (14).
 *  5. Rate-limited cell, spent with since = N blocks → accepted once N blocks pass.
 *  6. Owner sweeps everything back                  → accepted, ignoring the scope.
 *
 * Usage: FUNDER_KEY=0x... npm run smoke:lock
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import {
  createSession,
  relativeBlocksSince,
  sessionLockCellDep,
  sessionLockErrorFrom,
  sessionLockScript,
  sessionSigner,
  type SessionLockDeployment,
} from "../src/index.js";

const CKB = 100_000_000n;
const MAX = 100n * CKB;
const INTERVAL = 3n;
const explorer = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
const deployment = JSON.parse(readFileSync("deployment/testnet.json", "utf8")) as SessionLockDeployment;

async function committed(client: ccc.Client, hash: ccc.Hex): Promise<void> {
  for (let i = 0; i < 180; i++) {
    if ((await client.getTransaction(hash))?.status === "committed") return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`not committed after 15 minutes: ${explorer(hash)}`);
}

/** Sends and expects the network to refuse with a given session-lock code. */
async function expectRejected(send: () => Promise<unknown>, code: number, label: string): Promise<void> {
  try {
    await send();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = sessionLockErrorFrom(msg);
    if (err?.code !== code) throw new Error(`${label}: expected code ${code}, node said:\n${msg}`);
    console.log(`  ✓ rejected by the network: code ${err.code} (${err.meaning})`);
    console.log(`    node: ${msg.slice(0, 220)}…`);
    return;
  }
  throw new Error(`${label}: the network ACCEPTED a spend it should have rejected`);
}

async function main(): Promise<void> {
  const key = process.env.FUNDER_KEY;
  if (!key) throw new Error("set FUNDER_KEY to a testnet private key");
  const client = new ccc.ClientPublicTestnet();
  const owner = new ccc.SignerCkbPrivateKey(client, key);
  const ownerLock = (await owner.getRecommendedAddressObj()).script;

  const session = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: MAX } });
  const keySigner = sessionSigner(session, client);
  const keyLock = (await keySigner.getRecommendedAddressObj()).script;

  const params = { ownerLockHash: ownerLock.hash(), sessionLockHash: keyLock.hash(), maxPerTx: MAX };
  const plainLock = sessionLockScript(deployment, params);
  const limitedLock = sessionLockScript(deployment, { ...params, minInterval: INTERVAL });
  const dep = sessionLockCellDep(deployment);

  console.log("1. owner funds two session cells (400 CKB each) and the key cell (200 CKB)");
  const setup = ccc.Transaction.from({
    outputs: [
      { lock: plainLock, capacity: 400n * CKB },
      { lock: limitedLock, capacity: 400n * CKB },
      { lock: keyLock, capacity: 200n * CKB },
    ],
  });
  await setup.completeInputsByCapacity(owner);
  await setup.completeFeeBy(owner);
  const setupHash = await owner.sendTransaction(setup);
  console.log(`  ${explorer(setupHash)}`);
  await committed(client, setupHash);

  const at = (txHash: ccc.Hex, index: number, since = 0n) =>
    ccc.CellInput.from({ previousOutput: { txHash, index }, since });

  // Session-mode spend: session cell + key cell in; payment, change, key cell out.
  // The fee comes out of the key cell, so the session cell's outflow is exactly `pay`.
  const sessionSpend = async (sessionIn: ccc.CellInput, lock: ccc.Script, inCap: bigint, pay: bigint, keyIn: ccc.CellInput) => {
    const tx = ccc.Transaction.from({
      inputs: [sessionIn, keyIn],
      outputs: [
        { lock: ownerLock, capacity: pay },
        { lock, capacity: inCap - pay },
        { lock: keyLock, capacity: 0n },
      ],
      cellDeps: [dep],
    });
    // CCC silently raises an output below its occupied capacity (121 CKB for a
    // session-lock cell). That would change what this test is testing, so refuse.
    if (tx.outputs[1].capacity !== inCap - pay) {
      throw new Error(`change ${inCap - pay} is below the cell's occupied capacity; CCC raised it`);
    }
    await tx.completeFeeChangeToOutput(keySigner, 2);
    return keySigner.sendTransaction(tx);
  };

  console.log(`2. session spends exactly max_per_tx (100 CKB), no owner signature`);
  const okHash = await sessionSpend(at(setupHash, 0), plainLock, 400n * CKB, MAX, at(setupHash, 2));
  console.log(`  ✓ accepted: ${explorer(okHash)}`);
  await committed(client, okHash);

  console.log(`3. session tries 100 CKB + 1 shannon`);
  await expectRejected(
    () => sessionSpend(at(okHash, 1), plainLock, 300n * CKB, MAX + 1n, at(okHash, 2)),
    12,
    "over-limit spend",
  );

  console.log(`4. rate-limited cell (min_interval ${INTERVAL} blocks), spent with no since`);
  await expectRejected(
    () => sessionSpend(at(setupHash, 1), limitedLock, 400n * CKB, MAX, at(okHash, 2)),
    14,
    "rate-limited spend without since",
  );

  console.log(`5. same cell with since = ${INTERVAL} relative blocks (waits for maturity)`);
  let rateHash: ccc.Hex | undefined;
  for (let i = 0; i < 60 && !rateHash; i++) {
    try {
      rateHash = await sessionSpend(
        at(setupHash, 1, relativeBlocksSince(INTERVAL)),
        limitedLock,
        400n * CKB,
        MAX,
        at(okHash, 2),
      );
    } catch (e) {
      if (!/Immature/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 10_000)); // not old enough yet: the network says so
    }
  }
  if (!rateHash) throw new Error("rate-limited spend never matured");
  console.log(`  ✓ accepted once mature: ${explorer(rateHash)}`);
  await committed(client, rateHash);

  console.log(`6. owner sweeps both session cells and the key cell back`);
  const sweep = ccc.Transaction.from({
    inputs: [at(okHash, 1), at(rateHash, 1), at(rateHash, 2)],
    outputs: [],
    cellDeps: [dep],
  });
  // Owner mode needs an owner-locked input in the transaction: add one owner cell.
  for await (const cell of client.findCellsByLock(ownerLock, null, true)) {
    if (cell.cellOutput.type === undefined && cell.outputData === "0x") {
      sweep.inputs.push(ccc.CellInput.from({ previousOutput: cell.outPoint }));
      break;
    }
  }
  await keySigner.prepareTransaction(sweep); // reserve the key cell's witness before the fee is computed
  await sweep.completeFeeBy(owner); // everything left goes to the owner as change
  const signed = await keySigner.signOnlyTransaction(await owner.signOnlyTransaction(sweep));
  const sweepHash = await client.sendTransaction(signed);
  console.log(`  ✓ accepted: ${explorer(sweepHash)}`);
  await committed(client, sweepHash);
  console.log("done — every rule held on the real network.");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
