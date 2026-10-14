/**
 * Saves the xUDT script binary deployed on testnet to test/fixtures/xudt_rce, so
 * the lock tests can run the real token script (ckb-production-scripts, MIT).
 * The hash is checked against the code hash CCC knows for xUDT.
 *
 * Usage: npx tsx scripts/fetch-xudt.ts
 */
import { ccc } from "@ckb-ccc/core";
import { writeFileSync } from "node:fs";

const client = new ccc.ClientPublicTestnet();
const info = await client.getKnownScript(ccc.KnownScript.XUdt);
for (const dep of info.cellDeps) {
  const cell = await client.getCell(dep.cellDep.outPoint);
  if (!cell) continue;
  const data = cell.outputData;
  const dataHash = ccc.hashCkb(data);
  const typeHash = cell.cellOutput.type?.hash();
  const matches = info.hashType === "type" ? typeHash === info.codeHash : dataHash === info.codeHash;
  console.log(`${dep.cellDep.outPoint.txHash}:${dep.cellDep.outPoint.index} data ${dataHash} type ${typeHash} matches ${matches}`);
  if (!matches) continue;
  writeFileSync("test/fixtures/xudt_rce", ccc.bytesFrom(data));
  console.log(`saved ${ccc.bytesFrom(data).length} bytes, data hash ${dataHash}`);
  process.exit(0);
}
throw new Error("no xUDT code cell found");
