/**
 * Pay-per-minute on testnet, end to end: one owner signature opens a session
 * that may only pay the creator; the session key pays two minutes of a track
 * with no wallet; the server's own gating (demo/app/listen/release.ts) releases
 * each minute to the key that paid it, and refuses a minute nobody paid for.
 *
 * Usage: FUNDER_KEY=0x... npm run smoke:listen
 */
import { ccc } from "@ckb-ccc/core";
import {
  closeSession,
  createSession,
  openSession,
  paymentMemo,
  signAccess,
  spendInSession,
  TESTNET_DEPLOYMENT as deployment,
} from "ckb-session-kit";
import { CREATOR, memoLabel, PRICE_PER_MINUTE } from "../demo/app/listen/config";
import { release } from "../demo/app/listen/release";

const CKB = 100_000_000n;
const TRACK = "tide";
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

  const session = createSession({
    expiresAt: new Date(Date.now() + 60 * 60_000),
    scope: { maxPerTx: PRICE_PER_MINUTE, recipients: [CREATOR] },
  });
  console.log("open: a session that may only pay the creator");
  const { txHash, binding } = await openSession(owner, session, deployment, { budget: 200n * CKB });
  session.onchain = binding;
  console.log(`  ${explorer(txHash)}`);
  await committed(client, txHash);

  let first: ccc.Hex | undefined;
  for (const minute of [0, 1]) {
    const memo = paymentMemo(memoLabel(TRACK, minute));
    const paid = await spendInSession(session, client, deployment, binding, {
      to: CREATOR,
      amount: PRICE_PER_MINUTE,
      topUp: true,
      memo,
    });
    await committed(client, paid);
    first ??= paid;
    const r = await release(client, { track: TRACK, minute, proof: await signAccess(session, paid, memo) });
    if (r.status !== 200) throw new Error(`minute ${minute} not released: ${JSON.stringify(r.body)}`);
    console.log(`  ✓ minute ${minute}: paid 0.5 CKB with no wallet, released by the server: ${explorer(paid)}`);
  }

  // Minute 0's payment cannot unlock minute 2.
  const memo2 = paymentMemo(memoLabel(TRACK, 2));
  const refused = await release(client, { track: TRACK, minute: 2, proof: await signAccess(session, first!, memo2) });
  if (refused.status !== 402) throw new Error(`minute 2 was not refused: ${JSON.stringify(refused)}`);
  console.log(`  ✓ minute 2 with minute 0's payment: refused (${(refused.body as { error: string }).error})`);

  const { sweepTx, keyTx, keyError } = await closeSession(owner, session, deployment, binding);
  console.log(`close: sweep ${sweepTx && explorer(sweepTx)} · key cell ${keyTx ? explorer(keyTx) : keyError}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
