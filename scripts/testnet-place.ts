/**
 * CKB Place on testnet, end to end: one owner signature opens a session that
 * may only pay the board, the session key paints "CKB" in a few payments with
 * no wallet, each placement is checked the way the page checks it, then the
 * session is closed.
 *
 * Usage: FUNDER_KEY=0x... npm run smoke:place
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import {
  checkPlacement,
  closeSession,
  createSession,
  encodePlacement,
  openSession,
  PLACE_BOARD as PLACE,
  spendInSession,
  TESTNET_DEPLOYMENT as deployment,
  type Pixel,
} from "../src/index.js";

// The board the demo paints on: the address setup:board printed, kept in the demo's config.
const BOARD = readFileSync("demo/app/place/config.ts", "utf8").match(/BOARD: string =\s*"(ckt1\w+)"/)?.[1] ?? "";

const CKB = 100_000_000n;
const explorer = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;

/** "CKB" in a 3×5 font, top-left at (11, 13). */
const GLYPHS = ["###.#.#.##.", "#...#.#.#.#", "#...##..##.", "#...#.#.#.#", "###.#.#.##."];
const GREEN = 10;

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
  const { script: boardLock } = await ccc.Address.fromString(BOARD, client);

  const pixels: Pixel[] = [];
  GLYPHS.forEach((row, y) =>
    [...row].forEach((c, x) => c === "#" && pixels.push({ x: 11 + x, y: 13 + y, colour: GREEN })),
  );

  const session = createSession({
    expiresAt: new Date(Date.now() + 60 * 60_000),
    scope: { maxPerTx: PLACE.price * BigInt(PLACE.maxPixels), recipients: [BOARD] },
  });
  console.log(`open: a session that may only pay the board (${pixels.length} pixels to paint)`);
  const { txHash, binding } = await openSession(owner, session, deployment, { budget: 200n * CKB });
  session.onchain = binding;
  console.log(`  ${explorer(txHash)}`);
  await committed(client, txHash);

  for (let i = 0; i < pixels.length; i += PLACE.maxPixels) {
    const batch = pixels.slice(i, i + PLACE.maxPixels);
    const paid = await spendInSession(session, client, deployment, binding, {
      to: BOARD,
      amount: PLACE.price * BigInt(batch.length),
      topUp: true,
      memo: encodePlacement(batch, PLACE),
    });
    await committed(client, paid);
    // The page's check: one memo, signed by the payer, the board paid enough.
    const tx = (await client.getTransaction(paid))!.transaction;
    const inputs = await Promise.all(tx.inputs.map(async (inp) => (await client.getCell(inp.previousOutput))!.cellOutput));
    const check = checkPlacement(tx, inputs, boardLock, PLACE);
    if (!check.ok) throw new Error(`placement not accepted: ${check.reason}`);
    console.log(`  ✓ ${batch.length} pixels, ${ccc.fixedPointToString(check.paid)} CKB, no wallet: ${explorer(paid)}`);
  }

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
