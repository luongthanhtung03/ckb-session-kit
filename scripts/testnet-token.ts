/**
 * Token sessions on testnet, end to end:
 *
 *  1. The funder issues a test xUDT (its own lock hash as the xUDT args) if it
 *     holds none, and gives the creator's anyone-can-pay address a token cell.
 *  2. One owner signature opens a token session: 100 units, at most 10 per
 *     spend, paying only the creator.
 *  3. The session key pays 3 units twice, topping up the creator's token cell,
 *     with no wallet.
 *  4. A hand-built spend of 11 units is rejected by the network (code 20).
 *  5. The owner closes the session: the tokens come back as tokens.
 *
 * Usage: FUNDER_KEY=0x... npm run smoke:token
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import {
  closeSession,
  createSession,
  findSessionCells,
  openSession,
  sessionLockErrorFrom,
  sessionSigner,
  spendInSession,
  TESTNET_DEPLOYMENT as deployment,
  tokenAmount,
  relativeBlocksSince,
  sessionLockCellDep,
} from "../src/index.js";

const CKB = 100_000_000n;
const explorer = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
// The pay-per-read creator: an anyone-can-pay address (setup:creator).
const CREATOR = readFileSync("demo/app/read/config.ts", "utf8").match(/"(ckt1\w+)"/)?.[1] ?? "";

async function committed(client: ccc.Client, hash: ccc.Hex): Promise<void> {
  for (let i = 0; i < 180; i++) {
    if ((await client.getTransaction(hash))?.status === "committed") return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`not committed after 15 minutes: ${explorer(hash)}`);
}

const units = (v: bigint) => ccc.hexFrom(ccc.numLeToBytes(v, 16));

async function main(): Promise<void> {
  const key = process.env.FUNDER_KEY;
  if (!key) throw new Error("set FUNDER_KEY to a testnet private key");
  if (!CREATOR) throw new Error("no creator address in demo/app/read/config.ts");
  const client = new ccc.ClientPublicTestnet();
  const owner = new ccc.SignerCkbPrivateKey(client, key);
  const ownerLock = (await owner.getRecommendedAddressObj()).script;
  const { script: creatorLock } = await ccc.Address.fromString(CREATOR, client);
  const xudt = await client.getKnownScript(ccc.KnownScript.XUdt);
  const token = ccc.Script.from({ codeHash: xudt.codeHash, hashType: xudt.hashType, args: ownerLock.hash() });
  console.log(`token: xUDT issued by the funder, type hash ${token.hash()}`);

  // 1. Supply: mint 1,000 units to the funder, and a token cell for the creator to be paid into.
  let held = 0n;
  for await (const c of client.findCells({ script: ownerLock, scriptType: "lock", scriptSearchMode: "exact", filter: { script: token }, withData: true })) {
    held += tokenAmount(c.outputData);
  }
  let creatorHasCell = false;
  for await (const _ of client.findCells({ script: creatorLock, scriptType: "lock", scriptSearchMode: "exact", filter: { script: token } })) {
    creatorHasCell = true;
  }
  if (held < 100n || !creatorHasCell) {
    const tx = ccc.Transaction.from({ outputs: [], outputsData: [] });
    if (held < 100n) tx.addOutput({ lock: ownerLock, type: token }, units(1000n)); // owner mode: the issuer mints
    if (!creatorHasCell) tx.addOutput({ lock: creatorLock, type: token }, units(0n));
    await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt);
    await tx.completeInputsByCapacity(owner);
    await tx.completeFeeBy(owner);
    const minted = await owner.sendTransaction(tx);
    console.log(`supply: ${held < 100n ? "minted 1,000 units" : ""}${!creatorHasCell ? ", creator token cell" : ""}: ${explorer(minted)}`);
    await committed(client, minted);
  }

  // 2. Open.
  const session = createSession({
    expiresAt: new Date(Date.now() + 60 * 60_000),
    scope: { maxPerTx: 10n * CKB, recipients: [CREATOR] },
  });
  console.log("open: a token session, 100 units, at most 10 per spend, paying only the creator");
  const { txHash, binding } = await openSession(owner, session, deployment, {
    budget: 300n * CKB,
    token: { type: token, amount: 100n, maxPerTx: 10n },
  });
  session.onchain = binding;
  console.log(`  ${explorer(txHash)}`);
  await committed(client, txHash);

  // 3. Pay.
  for (const i of [1, 2]) {
    const paid = await spendInSession(session, client, deployment, binding, { to: CREATOR, token: 3n, topUp: true });
    await committed(client, paid);
    console.log(`  ✓ payment ${i}: 3 units to the creator, no wallet: ${explorer(paid)}`);
  }
  const state = await findSessionCells(session, client, deployment, binding);
  if (state.tokenBalance !== 94n) throw new Error(`session holds ${state.tokenBalance} units, expected 94`);
  console.log(`  session now holds ${state.tokenBalance} units and ${ccc.fixedPointToString(state.balance)} CKB`);

  // 4. Over the token limit, built by hand so the library's own check does not stop it first.
  const [sessionCell] = state.sessionCells;
  let target: ccc.Cell | undefined;
  for await (const c of client.findCells({ script: creatorLock, scriptType: "lock", scriptSearchMode: "exact", filter: { script: token }, withData: true })) {
    if (ccc.bytesFrom(c.outputData).length === 16) target = c;
  }
  if (!target) throw new Error("creator token cell not found");
  const over = ccc.Transaction.from({
    inputs: [
      { previousOutput: sessionCell.outPoint, since: binding.minInterval ? relativeBlocksSince(binding.minInterval) : 0n },
      { previousOutput: target.outPoint },
      { previousOutput: state.keyCells[0].outPoint },
    ],
    outputs: [
      { lock: creatorLock, type: token, capacity: target.cellOutput.capacity },
      { lock: state.lock, type: token, capacity: sessionCell.cellOutput.capacity },
      { lock: state.keyLock, capacity: 0n },
    ],
    outputsData: [units(tokenAmount(target.outputData) + 11n), units(tokenAmount(sessionCell.outputData) - 11n), "0x"],
    cellDeps: [sessionLockCellDep(deployment)],
  });
  await over.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt, ccc.KnownScript.AnyoneCanPay);
  await over.completeFeeChangeToOutput(sessionSigner(session, client), 2);
  try {
    await sessionSigner(session, client).sendTransaction(over);
    throw new Error("the network ACCEPTED 11 units in a 10-unit session");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const err = sessionLockErrorFrom(msg);
    if (err?.code !== 20) throw new Error(`expected code 20, node said:\n${msg}`);
    console.log(`  ✓ 11 units: rejected by the network, code 20 (${err.meaning})`);
    console.log(`    node: ${msg.replace(/\s+/g, " ")}`);
  }

  // 5. Close: the tokens come back.
  const { sweepTx, keyTx, keyError } = await closeSession(owner, session, deployment, binding);
  if (!sweepTx) throw new Error("nothing swept");
  await committed(client, sweepTx);
  const swept = (await client.getTransaction(sweepTx))!.transaction;
  const back = swept.outputs.findIndex((o) => o.type?.eq(token) && o.lock.eq(ownerLock));
  if (back < 0 || tokenAmount(swept.outputsData[back]) !== 94n) throw new Error("the sweep did not return 94 units");
  console.log(`close: 94 units back to the owner ${explorer(sweepTx)} · key cell ${keyTx ? explorer(keyTx) : keyError}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
