/**
 * Deploys the session lock binary to CKB testnet as a plain data cell and
 * records where it lives in deployment/testnet.json.
 *
 * Referenced by data hash (hash_type "data2", CKB-VM v2, the same as the test
 * suite), so the code is immutable: nobody — including me — can change what a
 * deployed session lock does.
 *
 * Usage: FUNDER_KEY=0x... npm run deploy:testnet
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BINARY = "contracts/session-lock/target/riscv64imac-unknown-none-elf/release/session-lock";
const OUT = "deployment/testnet.json";

async function main(): Promise<void> {
  const key = process.env.FUNDER_KEY;
  if (!key) throw new Error("set FUNDER_KEY to a testnet private key");
  const binary = readFileSync(BINARY);
  const client = new ccc.ClientPublicTestnet();
  const signer = new ccc.SignerCkbPrivateKey(client, key);
  const { script: lock } = await signer.getRecommendedAddressObj();

  const tx = ccc.Transaction.from({ outputs: [{ lock }], outputsData: [binary] });
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer);
  const txHash = await signer.sendTransaction(tx);
  console.log(`deploy tx : https://testnet.explorer.nervos.org/transaction/${txHash}`);

  for (let i = 0; i < 120; i++) {
    if ((await client.getTransaction(txHash))?.status === "committed") break;
    await new Promise((r) => setTimeout(r, 5000));
  }

  const record = {
    network: "testnet",
    codeHash: ccc.hashCkb(binary),
    hashType: "data2",
    cellDep: { outPoint: { txHash, index: "0x0" }, depType: "code" },
    binaryBytes: binary.length,
    deployedAt: new Date().toISOString(),
  };
  mkdirSync("deployment", { recursive: true });
  writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
  console.log(`code hash : ${record.codeHash} (data2)`);
  console.log(`written   : ${OUT}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
