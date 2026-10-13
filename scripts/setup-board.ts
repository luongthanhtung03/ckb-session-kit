/**
 * Sets up the CKB Place board: a board key, kept in .env.board (gitignored),
 * and N anyone-can-pay cells under it (default 8), paid by the funder.
 *
 * Every pixel payment consumes one of the board's cells and recreates it, so
 * players painting at the same moment compete for them; with several, they
 * rarely pick the same one (spendInSession picks at random).
 *
 * The key is written before anything is funded, and never overwritten: run the
 * script again to add cells to the same board. The board key can withdraw what
 * players paid; nothing else needs it.
 *
 * Usage: FUNDER_KEY=0x... npm run setup:board [-- N]
 * Without FUNDER_KEY it only creates (or reads) the key and prints the address.
 */
import { ccc } from "@ckb-ccc/core";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CKB = 100_000_000n;
const KEY_FILE = ".env.board";

/** The board key from .env.board, created on first run. */
function boardKey(): string {
  if (existsSync(KEY_FILE)) {
    const key = /^BOARD_KEY=(0x[0-9a-fA-F]{64})\s*$/m.exec(readFileSync(KEY_FILE, "utf8"))?.[1];
    if (!key) throw new Error(`${KEY_FILE} has no BOARD_KEY=0x… line; fix or remove it`);
    return key;
  }
  const key = ccc.hexFrom(randomBytes(32));
  // "wx": never replace a key that may already hold the board's funds.
  writeFileSync(KEY_FILE, `# CKB Place board key (testnet). Never commit.\nBOARD_KEY=${key}\n`, { flag: "wx", mode: 0o600 });
  console.log(`created ${KEY_FILE}`);
  return key;
}

async function main(): Promise<void> {
  const want = Number(process.argv[2] ?? 8);
  if (!Number.isInteger(want) || want < 1 || want > 32) throw new Error("N must be 1–32");
  const client = new ccc.ClientPublicTestnet();
  const board = new ccc.SignerCkbPrivateKey(client, boardKey());
  const args = (await board.getRecommendedAddressObj()).script.args;
  const acp = await ccc.Address.fromKnownScript(client, ccc.KnownScript.AnyoneCanPay, args);

  let have = 0;
  let balance = 0n;
  for await (const cell of client.findCellsByLock(acp.script, null, true)) {
    have++;
    balance += cell.cellOutput.capacity;
  }
  console.log(`board ${acp.toString()}`);
  console.log(`  ${have} anyone-can-pay cell(s), ${ccc.fixedPointToString(balance)} CKB`);
  console.log(`  set BOARD in demo/app/place/config.ts to this address`);

  const { FUNDER_KEY } = process.env;
  if (!FUNDER_KEY) {
    console.log(`set FUNDER_KEY to a testnet private key to fund ${Math.max(0, want - have)} more cell(s)`);
    return;
  }
  const funder = new ccc.SignerCkbPrivateKey(client, FUNDER_KEY);
  console.log(`funder balance ${ccc.fixedPointToString(await funder.getBalance())} CKB`);
  if (have >= want) return;

  const tx = ccc.Transaction.from({
    outputs: Array.from({ length: want - have }, () => ({ lock: acp.script, capacity: 61n * CKB })),
  });
  await tx.completeInputsByCapacity(funder);
  await tx.completeFeeBy(funder);
  const hash = await funder.sendTransaction(tx);
  console.log(`added ${want - have} cell(s): https://testnet.explorer.nervos.org/transaction/${hash}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
