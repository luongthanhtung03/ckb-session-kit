/**
 * The whole session lifecycle in one file: open, pay twice with no wallet,
 * close. A private-key signer stands in for the owner's wallet.
 *
 *   OWNER_KEY=0x… npx tsx examples/node-quickstart.ts
 *
 * Locks up about 360 testnet CKB while it runs; all of it comes back except fees.
 * Each payment here creates a cell, so it is at least 61 CKB; for small amounts
 * pay into an anyone-can-pay cell with `topUp: true` (see paywall-server.ts).
 */
import { ccc } from "@ckb-ccc/core";
import {
  closeSession,
  createSession,
  findSessionCells,
  openSession,
  spendInSession,
  TESTNET_DEPLOYMENT as deployment,
} from "ckb-session-kit";

const CKB = 100_000_000n;

async function committed(client: ccc.Client, hash: ccc.Hex): Promise<void> {
  while ((await client.getTransaction(hash))?.status !== "committed") await new Promise((r) => setTimeout(r, 4000));
}

async function main(): Promise<void> {
  const client = new ccc.ClientPublicTestnet();
  const owner = new ccc.SignerCkbPrivateKey(client, process.env.OWNER_KEY ?? "");
  const payee = await owner.getRecommendedAddress(); // pay ourselves, so nothing is lost

  // 1. A session key, created and kept here. The scope is checked twice: by the
  //    library before signing, and by the session lock on-chain.
  const session = createSession({
    expiresAt: new Date(Date.now() + 60 * 60_000), // checked off-chain only
    scope: { maxPerTx: 70n * CKB, recipients: [payee] }, // both enforced on-chain
  });

  // 2. The owner funds it: the only owner signature until close. A session cell
  //    with a recipient occupies 153 CKB itself, so 147 of the 300 can be spent.
  const { txHash, binding } = await openSession(owner, session, deployment, { budget: 300n * CKB });
  session.onchain = binding;
  console.log(`opened   ${txHash}`);
  await committed(client, txHash);

  // 3. The session key pays on its own: no wallet, no popup.
  for (const amount of [61n, 65n]) {
    const paid = await spendInSession(session, client, deployment, binding, { to: payee, amount: amount * CKB });
    console.log(`paid ${amount}   ${paid}`);
    await committed(client, paid);
  }

  const { balance } = await findSessionCells(session, client, deployment, binding);
  console.log(`left     ${ccc.fixedPointToString(balance)} CKB`);

  // 4. The owner takes everything back: the balance, then the key cell.
  const { sweepTx, keyTx, keyError } = await closeSession(owner, session, deployment, binding);
  console.log(`closed   sweep ${sweepTx} · key cell ${keyTx ?? keyError}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
