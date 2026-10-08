/**
 * Pay-per-read on testnet: a reader unlocks articles for 1 CKB each with no
 * wallet prompt, and the session can only ever pay the creator.
 *
 *   setup  — the creator has an anyone-can-pay (ACP) cell; readers top it up
 *   open   — the reader's wallet funds a session scoped to that ACP address (one signature)
 *   read×3 — the session key alone adds 1 CKB to the creator's cell, three times
 *   refuse — paying anyone else, or more than the per-tx limit, is refused
 *   close  — the key cell and what is left go back to the reader
 *
 * A new cell needs at least 61 CKB, so 1 CKB payments are only possible as top-ups
 * of a cell the creator already has. The ACP lock allows that without the
 * creator's signature, and the session lock's recipient rule allows nothing else.
 *
 * Usage: FUNDER_KEY=0x... CREATOR_KEY=0x... npm run smoke:pay-per-read
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
const PRICE = 1n * CKB;
const explorer = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
const deployment = JSON.parse(readFileSync("deployment/testnet.json", "utf8")) as SessionLockDeployment;

async function committed(client: ccc.Client, hash: ccc.Hex): Promise<void> {
  for (let i = 0; i < 180; i++) {
    if ((await client.getTransaction(hash))?.status === "committed") return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`not committed after 15 minutes: ${explorer(hash)}`);
}

async function balanceOf(client: ccc.Client, lock: ccc.Script): Promise<bigint> {
  let total = 0n;
  for await (const cell of client.findCellsByLock(lock, null, true)) total += cell.cellOutput.capacity;
  return total;
}

async function main(): Promise<void> {
  const funderKey = process.env.FUNDER_KEY;
  const creatorKey = process.env.CREATOR_KEY;
  if (!funderKey || !creatorKey) throw new Error("set FUNDER_KEY and CREATOR_KEY to testnet private keys");
  const client = new ccc.ClientPublicTestnet();
  const reader = new ccc.SignerCkbPrivateKey(client, funderKey);
  const creator = new ccc.SignerCkbPrivateKey(client, creatorKey);

  // The creator's ACP address: same key hash as their normal address, ACP lock.
  const creatorArgs = (await creator.getRecommendedAddressObj()).script.args;
  const acp = await ccc.Address.fromKnownScript(client, ccc.KnownScript.AnyoneCanPay, creatorArgs);
  const acpAddress = acp.toString();
  console.log(`creator's anyone-can-pay address: ${acpAddress}`);

  if ((await balanceOf(client, acp.script)) === 0n) {
    console.log("setup: create the creator's ACP cell (61 CKB, paid by the funder)");
    const tx = ccc.Transaction.from({ outputs: [{ lock: acp.script, capacity: 61n * CKB }] });
    await tx.completeInputsByCapacity(reader);
    await tx.completeFeeBy(reader);
    const hash = await reader.sendTransaction(tx);
    console.log(`  ${explorer(hash)}`);
    await committed(client, hash);
  }
  const before = await balanceOf(client, acp.script);

  const session = createSession({
    expiresAt: new Date(Date.now() + 3_600_000),
    scope: { maxPerTx: 5n * CKB, recipients: [acpAddress] },
  });
  // A session cell with a recipient needs 153 CKB to exist; 200 leaves 47 to spend.
  console.log("open: the reader's wallet funds a 200 CKB session that can only pay the creator (one signature)");
  const { txHash: openTx, binding } = await openSession(reader, session, deployment, {
    budget: 200n * CKB,
    recipient: acpAddress,
  });
  session.onchain = binding;
  console.log(`  ${explorer(openTx)}`);
  await committed(client, openTx);

  for (const article of ["#1", "#2", "#3"]) {
    const tx = await spendInSession(session, client, deployment, binding, { to: acpAddress, amount: PRICE, topUp: true });
    console.log(`read article ${article}: 1 CKB to the creator, session key only`);
    console.log(`  ✓ ${explorer(tx)}`);
    await committed(client, tx);
  }

  const after = await balanceOf(client, acp.script);
  console.log(`  creator's ACP balance ${ccc.fixedPointToString(before)} → ${ccc.fixedPointToString(after)} CKB`);
  if (after - before !== 3n * PRICE) throw new Error(`expected the creator to gain 3 CKB, gained ${after - before}`);

  const stranger = await reader.getRecommendedAddress();
  for (const [what, request] of [
    ["pay the reader's own address", { to: stranger, amount: PRICE }],
    ["pay the creator 6 CKB (limit 5)", { to: acpAddress, amount: 6n * CKB, topUp: true }],
  ] as const) {
    try {
      await spendInSession(session, client, deployment, binding, request);
      throw new Error(`${what}: not refused`);
    } catch (e) {
      if (!(e instanceof ScopeError)) throw e;
      console.log(`${what}\n  ✓ refused: ${e.message}`);
    }
  }

  console.log("close: key cell back to the reader, reader sweeps the session");
  const { keyTx, sweepTx } = await closeSession(reader, session, deployment, binding);
  console.log(`  key cell: ${explorer(keyTx!)}`);
  console.log(`  sweep   : ${explorer(sweepTx!)}`);
  await committed(client, sweepTx!);
  if ((await findSessionCells(session, client, deployment, binding)).balance !== 0n) {
    throw new Error("session cells remain after close");
  }
  console.log("done — three 1 CKB reads, no wallet prompt after the first, payable only to the creator.");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
