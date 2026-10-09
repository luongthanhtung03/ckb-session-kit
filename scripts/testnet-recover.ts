/**
 * Device-loss recovery on testnet: the session keys are thrown away, and the
 * owner's wallet alone finds every session it opened and sweeps them back.
 *
 *   open ×2  — one session with a recipient (112-byte args), one without (80)
 *   spend    — the second session pays once, so its cell has moved
 *   decoy    — a cell under the session lock with malformed args that start with
 *              the owner's hash; the lock rejects it forever, so recovery must skip it
 *   lose     — both session keys are dropped
 *   recover  — the owner finds both sessions by args prefix and sweeps them in one tx
 *
 * Usage: FUNDER_KEY=0x... npm run smoke:recover
 */
import { ccc } from "@ckb-ccc/core";
import {
  createSession,
  findOwnedSessionCells,
  openSession,
  recoverSessions,
  spendInSession,
  TESTNET_DEPLOYMENT as deployment,
  type Session,
} from "../src/index.js";

const CKB = 100_000_000n;
const explorer = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;

async function committed(client: ccc.Client, hash: ccc.Hex): Promise<void> {
  for (let i = 0; i < 180; i++) {
    if ((await client.getTransaction(hash))?.status === "committed") return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`not committed after 15 minutes: ${explorer(hash)}`);
}

async function main(): Promise<void> {
  const key = process.env.FUNDER_KEY;
  if (!key) throw new Error("set FUNDER_KEY to a testnet private key");
  const client = new ccc.ClientPublicTestnet();
  const owner = new ccc.SignerCkbPrivateKey(client, key);
  const ownerAddress = await owner.getRecommendedAddress();
  const ownerHash = (await owner.getRecommendedAddressObj()).script.hash();

  const before = await findOwnedSessionCells(owner, deployment);
  console.log(`owner has ${before.length} live session cell(s) before the test`);

  let sessions: Session[] = [
    createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: 100n * CKB, recipients: [ownerAddress] } }),
    createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: 100n * CKB } }),
  ];

  console.log("open: two sessions (one owner signature each)");
  const a = await openSession(owner, sessions[0], deployment, { budget: 200n * CKB, recipient: ownerAddress, feeBudget: 61n * CKB });
  console.log(`  with recipient: ${explorer(a.txHash)}`);
  await committed(client, a.txHash);
  const b = await openSession(owner, sessions[1], deployment, { budget: 250n * CKB, feeBudget: 70n * CKB });
  sessions[1].onchain = b.binding;
  console.log(`  without      : ${explorer(b.txHash)}`);
  await committed(client, b.txHash);

  console.log("spend: the second session pays 61 CKB with its key");
  const spend = await spendInSession(sessions[1], client, deployment, b.binding, { to: ownerAddress, amount: 61n * CKB });
  console.log(`  ${explorer(spend)}`);
  await committed(client, spend);

  // A malformed session cell (args = owner hash + 1 byte) the lock will always
  // reject. Created once; later runs find it already there.
  const decoyLock = ccc.Script.from({ codeHash: deployment.codeHash, hashType: deployment.hashType, args: ownerHash + "00" });
  let decoyExists = false;
  for await (const _ of client.findCellsByLock(decoyLock, null, true)) decoyExists = true;
  if (!decoyExists) {
    console.log("decoy: a cell with malformed args that start with the owner's hash (74 CKB, unspendable)");
    const tx = ccc.Transaction.from({ outputs: [{ lock: decoyLock, capacity: 0n }] });
    await tx.completeInputsByCapacity(owner);
    await tx.completeFeeBy(owner);
    const hash = await owner.sendTransaction(tx);
    console.log(`  ${explorer(hash)}`);
    await committed(client, hash);
  } else {
    console.log("decoy: already on chain from an earlier run");
  }

  console.log("lose: both session keys dropped; recovery uses only the owner's wallet");
  sessions = [];

  const found = await findOwnedSessionCells(owner, deployment);
  console.log(`recover: found ${found.length} session cell(s) by args prefix (decoy skipped)`);
  if (found.length !== before.length + 2) throw new Error(`expected ${before.length + 2}, found ${found.length}`);
  if (found.some((c) => c.cellOutput.lock.eq(decoyLock))) throw new Error("decoy was not filtered out");

  const { txHash, recovered, cells } = await recoverSessions(owner, deployment);
  console.log(`  swept ${cells} cell(s), ${ccc.fixedPointToString(recovered)} CKB back to the owner, one signature`);
  console.log(`  ${explorer(txHash!)}`);
  await committed(client, txHash!);

  const after = await findOwnedSessionCells(owner, deployment);
  if (after.length) throw new Error(`${after.length} session cell(s) left after recovery`);
  console.log("done — sessions recovered without the lost keys; the decoy could not block it.");
  console.log("lost for good: the two key cells (fee budgets), which only the session keys can spend.");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
