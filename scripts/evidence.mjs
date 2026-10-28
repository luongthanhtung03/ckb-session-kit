// Re-checks the security evidence in docs/evidence/*.log against public testnet.
// Read-only: get_transaction, get_header and get_live_cell, nothing is sent.
//
// For each log it prints every step, the code of each rejection the network gave,
// and for each transaction hash: committed or not, the block, and which
// session-lock deployment the transaction ran (a cell dep, input or output under
// that code hash). Exits 1 if a hash is not committed, or if a log not named
// legacy-* has a transaction that does not run the current deployment.
//
// Usage: npm run evidence            (CKB_RPC=... to use another testnet node)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RPC = process.env.CKB_RPC ?? "https://testnet.ckb.dev/rpc";
const DIR = "docs/evidence";
const current = JSON.parse(readFileSync("deployment/testnet.json", "utf8"));
// From src/lock.ts (TESTNET_LEGACY_DEPLOYMENTS).
const DEPLOYMENTS = [
  { name: "current", codeHash: current.codeHash, depTx: current.cellDep.outPoint.txHash },
  {
    name: "legacy 13 Oct",
    codeHash: "0x1cb7724269e2e86359b5b47cad6b1860ccd6da254c25c651056c8431d11590cd",
    depTx: "0x37cfe04f64fd4dbec3803a972a51b7080f9ca1a3042535e97b7a756d0e03b071",
  },
  {
    name: "legacy 8 Oct",
    codeHash: "0x1ae8b8f71ed1846e2823ecccd8c3f80527be2895689f5dae54a53bd42526bc20",
    depTx: "0xab2e69b8b97c15bddeb80954edd6d33befcd2fe9e4243377a46f14a3e1c343d2",
  },
];

let id = 0;
async function rpc(method, params) {
  let res;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ++id, jsonrpc: "2.0", method, params }),
      });
      break;
    } catch (e) {
      if (attempt === 3) throw e; // public nodes drop a connection now and then
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
const txs = new Map();
const getTx = async (h) => {
  if (!txs.has(h)) txs.set(h, await rpc("get_transaction", [h]));
  return txs.get(h);
};

/** Which deployments a transaction runs: by cell dep, input lock or output lock. */
async function deploymentsOf(tx) {
  const found = new Set();
  const byCode = (code) => DEPLOYMENTS.find((d) => d.codeHash === code)?.name;
  for (const d of tx.cell_deps) {
    const n = DEPLOYMENTS.find((x) => x.depTx === d.out_point.tx_hash)?.name;
    if (n) found.add(n);
  }
  for (const o of tx.outputs) if (byCode(o.lock.code_hash)) found.add(byCode(o.lock.code_hash));
  for (const i of tx.inputs) {
    const prev = (await getTx(i.previous_output.tx_hash))?.transaction;
    const o = prev?.outputs[Number(i.previous_output.index)];
    if (o && byCode(o.lock.code_hash)) found.add(byCode(o.lock.code_hash));
  }
  return [...found];
}

let failed = false;

const dep = await rpc("get_live_cell", [{ tx_hash: current.cellDep.outPoint.txHash, index: current.cellDep.outPoint.index }, true]);
const depOk = dep.status === "live" && dep.cell.data.hash === current.codeHash;
if (!depOk) failed = true;
console.log(`deployment: ${current.codeHash} (${current.hashType}), cell ${current.cellDep.outPoint.txHash}:0`);
console.log(`  on chain: ${dep.status}, data hash ${dep.cell?.data?.hash ?? "-"} ${depOk ? "(matches)" : "MISMATCH"}\n`);

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".log")).sort()) {
  const legacy = file.startsWith("legacy-");
  console.log(`== ${file}${legacy ? " (legacy deployment)" : ""}`);
  for (const line of readFileSync(join(DIR, file), "utf8").split(/\r?\n/)) {
    const code = line.match(/(?:code|error) (\d+)[ ,(]/);
    if (/rejected|refused/.test(line) && code) console.log(`  REJECTED  code ${code[1]}  ${line.trim()}`);
    for (const h of new Set(line.match(/0x[0-9a-f]{64}/g) ?? [])) {
      if (!line.includes("/transaction/")) continue; // a type hash, not a transaction
      const r = await getTx(h);
      if (!r?.transaction || r.tx_status.status !== "committed") {
        failed = true;
        console.log(`  MISSING   ${h} (${r?.tx_status?.status ?? "unknown"})`);
        continue;
      }
      const header = await rpc("get_header", [r.tx_status.block_hash]);
      const ran = await deploymentsOf(r.transaction);
      const wrong = !legacy && ran.length > 0 && !(ran.length === 1 && ran[0] === "current");
      if (wrong) failed = true;
      const when = new Date(Number(header.timestamp)).toISOString().slice(0, 16).replace("T", " ");
      console.log(
        `  committed ${h}  block ${Number(header.number)}  ${when} UTC  ${ran.join(", ") || "no session lock"}${wrong ? "  UNEXPECTED" : ""}`,
      );
    }
  }
  console.log();
}

console.log(failed ? "FAILED: see MISSING / UNEXPECTED / MISMATCH above" : "OK: every transaction is committed, on the deployment its log claims");
process.exit(failed ? 1 : 0);
