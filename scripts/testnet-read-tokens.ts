/**
 * The /tokens page's flow on testnet, with the funder as the reader:
 *
 *   mint  — 20 units of the demo token, with no key but the minter's (setup:token first)
 *   open  — one signature puts them in a session that pays only the creator, 5 units at most
 *   read  — the session key pays 2 units for an article, memo signed; the claim is
 *           checked against the chain the way the server route does (verifyAccess, token)
 *   close — the unspent units and the CKB go back to the reader
 *
 * Usage: FUNDER_KEY=0x... npm run smoke:read-tokens
 * With ARTICLE_API=http://localhost:3000/api/article-token (the demo running),
 * the article is also claimed through the demo's server route.
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import { demoToken, mintDemoToken } from "../demo/app/tokens/token.js";
import {
  closeSession,
  createSession,
  findSessionCells,
  openSession,
  paymentMemo,
  signAccess,
  spendInSession,
  TESTNET_DEPLOYMENT as deployment,
  tokenAmount,
  verifyAccess,
} from "../src/index.js";

const CKB = 100_000_000n;
const explorer = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
const CREATOR = readFileSync("demo/app/read/config.ts", "utf8").match(/"(ckt1\w+)"/)?.[1] ?? "";
const ARTICLE = "occupied-capacity";
const MEMO = paymentMemo(`read-token:${ARTICLE}`); // as demo/app/tokens/config.ts

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
  const reader = new ccc.SignerCkbPrivateKey(client, key);
  const token = await demoToken(client);
  const { script: creatorLock } = await ccc.Address.fromString(CREATOR, client);

  const minted = await mintDemoToken(reader, 20n);
  console.log(`mint: 20 demo tokens, signed by the minter alone: ${explorer(minted)}`);
  await committed(client, minted);

  const session = createSession({
    expiresAt: new Date(Date.now() + 60 * 60_000),
    scope: { maxPerTx: 1n * CKB, recipients: [CREATOR] },
  });
  const { txHash, binding } = await openSession(reader, session, deployment, {
    budget: 300n * CKB,
    token: { type: token, amount: 20n, maxPerTx: 5n },
  });
  session.onchain = binding;
  console.log(`open: 20 units, at most 5 per payment, creator only: ${explorer(txHash)}`);
  await committed(client, txHash);

  const paid = await spendInSession(session, client, deployment, binding, { to: CREATOR, token: 2n, topUp: true, memo: MEMO });
  console.log(`read: 2 units for "${ARTICLE}", session key only: ${explorer(paid)}`);
  await committed(client, paid);
  const proof = await signAccess(session, paid, MEMO);
  const check = await verifyAccess(client, proof, { to: creatorLock, minAmount: 2n, memo: MEMO, token });
  if (!check.ok || check.paid !== 2n) throw new Error(`verifyAccess: ${JSON.stringify(check, (_, v) => (typeof v === "bigint" ? `${v}` : v))}`);
  console.log("  ✓ verifyAccess (token): this key paid 2 units for this article");
  const cheap = await verifyAccess(client, proof, { to: creatorLock, minAmount: 3n, memo: MEMO, token });
  if (cheap.ok) throw new Error("verifyAccess accepted 2 units for a 3-unit price");
  console.log(`  ✓ at a 3-unit price it is refused: ${cheap.reason}`);
  const api = process.env.ARTICLE_API;
  if (api) {
    const res = await fetch(api, { method: "POST", body: JSON.stringify({ id: ARTICLE, proof }) });
    if (!res.ok) throw new Error(`${api} refused: ${await res.text()}`);
    console.log(`  ✓ ${api} released the article`);
  }
  const left = (await findSessionCells(session, client, deployment, binding)).tokenBalance;
  if (left !== 18n) throw new Error(`session holds ${left} units, expected 18`);

  const { sweepTx, keyTx, keyError } = await closeSession(reader, session, deployment, binding);
  if (!sweepTx) throw new Error("nothing swept");
  await committed(client, sweepTx);
  const swept = (await client.getTransaction(sweepTx))!.transaction;
  const back = swept.outputs.findIndex((o) => o.type?.eq(token));
  if (back < 0 || tokenAmount(swept.outputsData[back]) !== 18n) throw new Error("the sweep did not return 18 units");
  console.log(`close: 18 units back to the reader ${explorer(sweepTx)} · key cell ${keyTx ? explorer(keyTx) : keyError}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
