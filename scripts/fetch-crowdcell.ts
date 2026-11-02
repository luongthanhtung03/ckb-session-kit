/**
 * Saves CrowdCell's five script binaries, as deployed on testnet, to
 * test/fixtures/crowdcell/, so the lock tests can run a real pledge transaction
 * through every script it touches (campaign lock, campaign type, pledge lock,
 * pledge type, receipt type). CrowdCell: github.com/alesfer001/CrowdCell.
 *
 * Only the cells are read, over RPC: nothing of CrowdCell's is built or run
 * outside the CKB-VM tests. Each cell's data hash is checked against the code
 * hash CrowdCell publishes for it. The repository has no licence file, so the
 * binaries are not committed (test/fixtures/crowdcell/ is gitignored): the
 * tests that need them skip until this script has run.
 *
 * Where the out points come from (3 Nov 2026). CrowdCell's repository (at
 * 2fd13f6) carries two sets of code hashes, and the live app uses neither in
 * full:
 * - `deployment/deployed-contracts-testnet.json` (17 Sep, also in its README):
 *   all five cells are live and match their code hashes, but CrowdCell's
 *   frontend no longer builds with three of them (campaign, campaign lock, receipt);
 * - the frontend defaults (constants.ts:40-51) are env-driven, with code hashes
 *   of an older build and no testnet out points (the tx hashes fall back to zero);
 * - what the live frontend sends: the cell deps of pledge 0xd4602458... (block
 *   22,942,266, 3 Nov), the set below. Pledge and pledge lock are the same code
 *   as in the JSON, redeployed; campaign, campaign lock and receipt are newer
 *   (the receipt's args grew to 64 bytes: pledge code hash | pledge-lock code hash).
 *
 * Usage: npx tsx scripts/fetch-crowdcell.ts
 */
import { ccc } from "@ckb-ccc/core";
import { mkdirSync, writeFileSync } from "node:fs";

/** CrowdCell's scripts as its live testnet frontend uses them (3 Nov 2026). All data2, index 0, dep type code. */
export const CROWDCELL_TESTNET = {
  campaign: { codeHash: "0xd50ca43249515bb0ebe8534f4d7f74520e4fb7c1163d488c288672ffd7e7a8f5", txHash: "0x8ffc8f88be667072ca06e89127444be41029baabae30306d8247c11dd6f1c799" },
  campaignLock: { codeHash: "0xd975780a890b817303a5414167ce235c041a9e63bb5e85f764acc71209fd02a3", txHash: "0x1ea89700f68f672f950cd43bb764bf7148039d7c8151dad04922437d33d21504" },
  pledge: { codeHash: "0xe45d09f08d0e842340afb004cfb6b6b6414ad387f9cd2f3e0b9abcd6ae8eb024", txHash: "0x49961d44d1712cdeade84d86fe2ca2466b8a1d77462a61dcfc9c27944277af3d" },
  pledgeLock: { codeHash: "0xc28d8042a1cf39d02db0cbc769a26faad80b39563c2d2de40536ddb66ae3a525", txHash: "0x53d7d6447fb21b4da1e211a48a4fb2d5ceafd510ec88c966666b08085708bf1e" },
  receipt: { codeHash: "0x523716e6c46501480391965a9305d2be33045ce3be19300f62546ff3aa8bf8b5", txHash: "0xe40519d726f365e0d24baf31f5e4402d021efca4a62449f5d4215a800e60436d" },
} as const;

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/fetch-crowdcell.ts");
if (isMain) {
  const client = new ccc.ClientPublicTestnet({ url: process.env.CKB_RPC_URL || "https://testnet.ckbapp.dev/" });
  mkdirSync("test/fixtures/crowdcell", { recursive: true });
  let bad = 0;
  for (const [name, { codeHash, txHash }] of Object.entries(CROWDCELL_TESTNET)) {
    const cell = await client.getCellLive({ txHash, index: 0 }, true, false);
    if (!cell) {
      console.log(`${name}: ${txHash}:0 is not live`);
      bad++;
      continue;
    }
    const dataHash = ccc.hashCkb(cell.outputData);
    const matches = dataHash === codeHash;
    console.log(`${name}: ${txHash}:0 data hash ${dataHash} matches ${matches}`);
    if (!matches) {
      bad++;
      continue;
    }
    writeFileSync(`test/fixtures/crowdcell/${name}`, ccc.bytesFrom(cell.outputData));
    console.log(`  saved ${ccc.bytesFrom(cell.outputData).length} bytes`);
  }
  if (bad) throw new Error(`${bad} CrowdCell script(s) not saved`);
}
