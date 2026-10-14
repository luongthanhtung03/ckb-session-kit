/**
 * Sets up the demo token on testnet, paid by the funder: N issuer cells
 * (default 4) that anyone may spend to mint, and three token cells for the
 * pay-per-read creator to be paid into (readers paying at once rarely pick the
 * same one). Then mints 50 units to the funder, as
 * a visitor would, to prove minting needs no key but the minter's own.
 *
 * Usage: FUNDER_KEY=0x... npm run setup:token [-- N]
 */
import { ccc } from "@ckb-ccc/core";
import { readFileSync } from "node:fs";
import { demoToken, issuerLock, mintDemoToken, units } from "../demo/app/tokens/token.js";

const CKB = 100_000_000n;
const explorer = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
const CREATOR = readFileSync("demo/app/read/config.ts", "utf8").match(/"(ckt1\w+)"/)?.[1] ?? "";

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
  const want = Number(process.argv[2] ?? 4);
  const client = new ccc.ClientPublicTestnet();
  const funder = new ccc.SignerCkbPrivateKey(client, key);
  const issuer = await issuerLock(client);
  const token = await demoToken(client);
  const { script: creatorLock } = await ccc.Address.fromString(CREATOR, client);
  console.log(`issuer ${ccc.Address.fromScript(issuer, client).toString()}`);
  console.log(`token type hash ${token.hash()} (args ${token.args})`);

  let have = 0;
  for await (const _ of client.findCellsByLock(issuer, null, true)) have++;
  let creatorHas = 0;
  for await (const _ of client.findCells({ script: creatorLock, scriptType: "lock", scriptSearchMode: "exact", filter: { script: token } })) {
    creatorHas++;
  }
  if (have < want || creatorHas < 3) {
    const tx = ccc.Transaction.from({ outputs: [], outputsData: [] });
    for (let i = have; i < want; i++) tx.addOutput({ lock: issuer, capacity: 61n * CKB }, "0x");
    for (let i = creatorHas; i < 3; i++) tx.addOutput({ lock: creatorLock, type: token }, units(0n));
    await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt);
    await tx.completeInputsByCapacity(funder);
    await tx.completeFeeBy(funder);
    const hash = await funder.sendTransaction(tx);
    console.log(`issuer cells ${have} -> ${want}${creatorHas < 3 ? `, creator token cells ${creatorHas} -> 3` : ""}: ${explorer(hash)}`);
    await committed(client, hash);
  }

  const minted = await mintDemoToken(funder, 50n);
  console.log(`minted 50 units with only the minter's key: ${explorer(minted)}`);
  await committed(client, minted);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
