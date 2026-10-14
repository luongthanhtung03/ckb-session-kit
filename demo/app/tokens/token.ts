/**
 * The demo token: a test xUDT anyone can mint, so a visitor needs nothing but
 * testnet CKB to try a token session. Shared by the page and setup:token.
 *
 * xUDT lets whoever spends a cell under the issuer's lock mint. Here the issuer
 * is an anyone-can-pay lock whose key nobody holds: anyone may spend its cells
 * as long as each comes back with no less CKB, so anyone can mint. The token is
 * worth nothing by design.
 */
import { ccc } from "@ckb-ccc/core";

/** 20 bytes nobody holds a key for: blake2b of a label. */
const ISSUER_ARGS = ccc.hashCkb(ccc.bytesFrom("ckb-session-kit demo token", "utf8")).slice(0, 42) as ccc.Hex;

export async function issuerLock(client: ccc.Client): Promise<ccc.Script> {
  return (await ccc.Address.fromKnownScript(client, ccc.KnownScript.AnyoneCanPay, ISSUER_ARGS)).script;
}

export async function demoToken(client: ccc.Client): Promise<ccc.Script> {
  const xudt = await client.getKnownScript(ccc.KnownScript.XUdt);
  return ccc.Script.from({ codeHash: xudt.codeHash, hashType: xudt.hashType, args: (await issuerLock(client)).hash() });
}

export const units = (v: bigint): ccc.Hex => ccc.hexFrom(ccc.numLeToBytes(v, 16));

/** Mints `amount` units to `signer`, which pays the new cell and the fee. */
export async function mintDemoToken(signer: ccc.Signer, amount: bigint): Promise<ccc.Hex> {
  const { client } = signer;
  const issuer = await issuerLock(client);
  const issuerCells: ccc.Cell[] = [];
  for await (const c of client.findCellsByLock(issuer, null, true)) {
    if (!c.cellOutput.type && c.outputData === "0x") issuerCells.push(c);
  }
  // Minters at once compete for an issuer cell; a random pick spreads them out.
  const cell = issuerCells[Math.floor(Math.random() * issuerCells.length)];
  if (!cell) throw new Error("the demo token has no issuer cell on testnet (run setup:token)");
  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: cell.outPoint }],
    outputs: [cell.cellOutput, { lock: (await signer.getRecommendedAddressObj()).script, type: await demoToken(client) }],
    outputsData: ["0x", units(amount)],
  });
  await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.AnyoneCanPay, ccc.KnownScript.XUdt);
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer);
  return signer.sendTransaction(tx);
}
