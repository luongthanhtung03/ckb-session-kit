/**
 * The library's on-chain session flow, end to end on testnet — exactly what the
 * web demo does, with a private-key signer standing in for the owner's wallet.
 *
 *   open (owner signs once) → spend, spend (session key only) → over-limit refused
 *   → close (key cell back, owner sweeps)
 *
 * Usage: FUNDER_KEY=0x... npm run smoke:flow
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import {
  closeSession,
  createSession,
  findSessionCells,
  openSession,
  ScopeError,
  spendInSession,
  type SessionLockDeployment,
} from "../src/index.js";

const CKB = 100_000_000n;
const explorer = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
const deployment = JSON.parse(readFileSync("deployment/testnet.json", "utf8")) as SessionLockDeployment;

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
  const payee = await owner.getRecommendedAddress();

  const session = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: 100n * CKB } });

  console.log("open: owner funds a 400 CKB session + 100 CKB fee budget (one owner signature)");
  const { txHash: openTx, binding } = await openSession(owner, session, deployment, { budget: 400n * CKB });
  session.onchain = binding;
  console.log(`  ${explorer(openTx)}`);
  await committed(client, openTx);

  for (const amount of [100n, 80n]) {
    console.log(`spend ${amount} CKB with the session key only`);
    const tx = await spendInSession(session, client, deployment, binding, { to: payee, amount: amount * CKB });
    console.log(`  ✓ ${explorer(tx)}`);
    await committed(client, tx);
  }

  const state = await findSessionCells(session, client, deployment, binding);
  console.log(`  session balance ${ccc.fixedPointToString(state.balance)} CKB, fee budget ${ccc.fixedPointToString(state.feeBalance)} CKB`);
  if (state.balance !== 220n * CKB) throw new Error(`expected 220 CKB left, found ${state.balance}`);

  console.log("spend 150 CKB (limit 100)");
  try {
    await spendInSession(session, client, deployment, binding, { to: payee, amount: 150n * CKB });
    throw new Error("over-limit spend was not refused");
  } catch (e) {
    if (!(e instanceof ScopeError)) throw e;
    console.log(`  ✓ refused before signing: ${e.message}`);
  }

  console.log("close: key cell back to the owner, owner sweeps the session");
  const { keyTx, sweepTx } = await closeSession(owner, session, deployment, binding);
  console.log(`  key cell: ${explorer(keyTx!)}`);
  console.log(`  sweep   : ${explorer(sweepTx!)}`);
  await committed(client, sweepTx!);
  const after = await findSessionCells(session, client, deployment, binding);
  if (after.balance !== 0n) throw new Error("session cells remain after close");
  console.log("done — session opened, used twice with no owner signature, closed.");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
