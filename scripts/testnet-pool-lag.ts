/**
 * How long a node's pool view lags a sent transaction, and whether that lag is
 * the node's own or two backends behind one URL (mentor review, tracker #47, 3 Nov).
 *
 * smoke:contention saw get_live_cell(include_tx_pool=true) still show a spent
 * input live for ~887 ms after send_transaction answered, on testnet.ckbapp.dev,
 * which answers local_node_info from two node_ids (a load balancer). This script
 * separates the two causes, for one RPC URL:
 *
 *   nodes   — local_node_info a few times before and after: which node_ids answer
 *   sends   — SENDS self-transfers of one funder cell, one at a time (fees only:
 *             every output goes back to the funder). Each send_transaction goes in
 *             one JSON-RPC batch with local_node_info, so the node that took it is known
 *   polls   — right after the send answers, every INTERVAL_MS: get_live_cell
 *             (include_tx_pool=true) on the spent input, batched with local_node_info
 *             (same HTTP request, same backend). Per send: ms until the input first
 *             shows not live, ms from which it stays not live, whether it came back
 *             live (two views), and which node answered each poll
 *   modes   — how the calls reach the URL: fetch (Node's fetch, as the other smokes
 *             and CCC), pinned (one kept-alive socket: does it pin a backend?),
 *             fresh (a new connection per call)
 *
 * Each send waits for the previous one to commit, so every spent input is a
 * committed cell, as a payout cell is in smoke:contention.
 *
 * Usage: npm run smoke:pool-lag [-- --url=https://testnet.ckb.dev/ --sends=10
 *        --modes=fetch,pinned --interval=50] [-- --dry-run]
 * LOG=1 also writes docs/evidence/<date>-smoke-pool-lag-<host>.log.
 */
import { ccc } from "@ckb-ccc/core";
import { cccA } from "@ckb-ccc/core/advanced";
import http from "node:http";
import https from "node:https";
import {
  CKB,
  errorText,
  explorer,
  isDryRun,
  msStats,
  plainCells,
  poolInfo,
  poolLagOptions,
  poolLagResult,
  rpcUrl,
  sleep,
  smokeKeys,
  startLog,
  type PoolLagMode,
  type PoolLagOptions,
  type PoolLagResult,
  type PoolLagSend,
  type PoolPoll,
} from "./testnet-lib.js";

const fmt = (n: bigint) => ccc.fixedPointToString(n);
const short = (id?: string) => (id ? id.slice(0, 10) : "?");
/** Polls in a row that must show the input not live before a send is done. */
const STABLE_POLLS = 10;
const MIN_CELL = 100n * CKB;

// --- transport ---------------------------------------------------------------

interface RpcCall {
  method: string;
  params: unknown[];
}
interface RpcReply {
  results: { result?: unknown; error?: { code: number; message: string; data?: unknown } }[];
  /** Local port of the socket that carried the request ("fetch" hides it). */
  conn: string;
}

interface Transport {
  mode: PoolLagMode;
  batch(calls: RpcCall[]): Promise<RpcReply>;
  connections: Set<string>;
  close(): void;
}

function makeTransport(url: string, mode: PoolLagMode): Transport {
  const target = new URL(url);
  const lib = target.protocol === "http:" ? http : https;
  const agent = mode === "pinned" ? new lib.Agent({ keepAlive: true, maxSockets: 1 }) : undefined;
  const connections = new Set<string>();

  const parse = (text: string): RpcReply["results"] => {
    const body = JSON.parse(text) as RpcReply["results"] | { error?: unknown };
    if (!Array.isArray(body)) throw new Error(`batch refused: ${text.slice(0, 200)}`);
    return [...body].sort((a, b) => Number((a as { id: number }).id) - Number((b as { id: number }).id));
  };
  const payload = (calls: RpcCall[]) => JSON.stringify(calls.map((c, id) => ({ id, jsonrpc: "2.0", method: c.method, params: c.params })));

  const batch = async (calls: RpcCall[]): Promise<RpcReply> => {
    if (mode === "fetch") {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload(calls), signal: AbortSignal.timeout(20_000) });
      return { results: parse(await res.text()), conn: "fetch" };
    }
    const body = payload(calls);
    return new Promise<RpcReply>((resolve, reject) => {
      const req = lib.request(
        target,
        {
          method: "POST",
          agent: mode === "pinned" ? agent : false,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            connection: mode === "pinned" ? "keep-alive" : "close",
          },
        },
        (res) => {
          const conn = String(res.socket?.localPort ?? "?");
          connections.add(conn);
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (d: string) => (text += d));
          res.on("end", () => {
            try {
              resolve({ results: parse(text), conn });
            } catch (e) {
              reject(e);
            }
          });
          res.on("error", reject);
        },
      );
      req.setTimeout(20_000, () => req.destroy(new Error("timeout after 20 s")));
      req.on("error", reject);
      req.end(body);
    });
  };
  return { mode, batch, connections, close: () => agent?.destroy() };
}

/** Retries a call that failed on the network (not a node refusal) with backoff: 1, 2, 4, 8 s. */
async function retrying<T>(what: string, fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      const wait = 1000 * 2 ** (i - 1);
      console.log(`  ${what}: ${errorText(e)}; retry ${i}/${tries - 1} in ${wait / 1000} s`);
      await sleep(wait);
    }
  }
}

const NODE_INFO: RpcCall = { method: "local_node_info", params: [] };
const nodeOf = (r: RpcReply["results"][number] | undefined) => (r?.result as { node_id?: string } | undefined)?.node_id;

async function nodeIds(t: Transport, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    try {
      ids.push(short(nodeOf((await retrying("local_node_info", () => t.batch([NODE_INFO]))).results[0])));
    } catch (e) {
      ids.push(`error (${errorText(e)})`);
    }
  }
  return ids;
}

const liveCall = (op: ccc.OutPoint): RpcCall => ({
  method: "get_live_cell",
  params: [{ tx_hash: op.txHash, index: ccc.numToHex(op.index) }, false, true],
});

// --- one send ----------------------------------------------------------------

interface Chain {
  outPoint: ccc.OutPoint;
  cellOutput: ccc.CellOutput;
}

async function sendOne(t: Transport, funder: ccc.SignerCkbPrivateKey, chain: Chain, o: PoolLagOptions): Promise<{ send: PoolLagSend; next: Chain; hash: ccc.Hex; sendMs: number }> {
  // The input must be live where we send (behind a balancer, both backends must have the block).
  for (let i = 0; i < 60; i++) {
    const r = await retrying("get_live_cell", () => t.batch([liveCall(chain.outPoint)]));
    if ((r.results[0]?.result as { status?: string } | undefined)?.status === "live") break;
    await sleep(500);
  }
  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: chain.outPoint, cellOutput: chain.cellOutput, outputData: "0x" }],
    outputs: [{ lock: chain.cellOutput.lock, capacity: 0n }],
    outputsData: ["0x"],
  });
  await tx.completeFeeChangeToOutput(funder, 0);
  const signed = await funder.signTransaction(tx);
  const hash = signed.hash();
  const json = cccA.JsonRpcTransformers.transactionFrom(signed);

  let reply: RpcReply | undefined;
  let sentAt = 0;
  let ackAt = 0;
  for (let attempt = 1; attempt <= 5 && !reply; attempt++) {
    sentAt = Date.now();
    let r: RpcReply;
    try {
      r = await t.batch([{ method: "send_transaction", params: [json, "passthrough"] }, NODE_INFO]);
    } catch (e) {
      console.log(`    send: ${errorText(e)}; retry ${attempt}/4`);
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    ackAt = Date.now();
    const err = r.results[0]?.error;
    // A retry after a lost answer can find its own transaction already in the pool.
    if (!err || /Duplicated/.test(err.message)) reply = r;
    else if (/Unknown\(OutPoint|Unknown/.test(err.message + String(err.data ?? ""))) {
      console.log(`    send refused (${err.message}); the answering node lacks the input yet, retry ${attempt}/4`);
      await sleep(1000);
    } else throw new Error(`send_transaction: ${JSON.stringify(err)}`);
  }
  if (!reply) throw new Error("send_transaction: no answer after 5 attempts");

  const send: PoolLagSend = { sendNode: nodeOf(reply.results[1]), polls: [] };
  let gone = 0;
  while (gone < STABLE_POLLS && Date.now() - ackAt < o.timeoutMs) {
    const ms = Date.now() - ackAt;
    let poll: PoolPoll;
    try {
      const r = await t.batch([liveCall(chain.outPoint), NODE_INFO]);
      poll = { ms, status: (r.results[0]?.result as { status?: string } | undefined)?.status ?? "error", node: nodeOf(r.results[1]) };
    } catch {
      poll = { ms, status: "error" };
    }
    send.polls.push(poll);
    if (poll.status === "error") {
      /* says nothing */
    } else if (poll.status === "live") gone = 0;
    else gone++;
    await sleep(o.intervalMs);
  }
  const capacity = signed.outputs[0].capacity;
  return {
    send,
    hash,
    sendMs: ackAt - sentAt,
    next: { outPoint: ccc.OutPoint.from({ txHash: hash, index: 0 }), cellOutput: ccc.CellOutput.from({ ...signed.outputs[0], capacity }) },
  };
}

async function waitCommitted(t: Transport, hash: ccc.Hex): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try {
      const r = await t.batch([{ method: "get_transaction", params: [hash] }]);
      if ((r.results[0]?.result as { tx_status?: { status?: string } } | undefined)?.tx_status?.status === "committed") return;
    } catch {
      /* retried below */
    }
    await sleep(2000);
  }
  throw new Error(`not committed after 10 minutes: ${explorer(hash)}`);
}

function describe(i: number, r: PoolLagResult, send: PoolLagSend, sendMs: number): string {
  const rtt = send.polls.length > 1 ? Math.round((send.polls[send.polls.length - 1].ms - send.polls[0].ms) / (send.polls.length - 1)) : 0;
  const nodes = r.nodes.map(short).join(",");
  const answered = send.polls.filter((p) => p.status !== "error").length;
  if (!answered) return `  send ${String(i).padStart(2)}: took by ${short(send.sendNode)} in ${sendMs} ms; no poll answered (${send.polls.length} failed): not measured`;
  return (
    `  send ${String(i).padStart(2)}: took by ${short(send.sendNode)} in ${sendMs} ms; ` +
    `not live after ${r.firstGone ?? "never"} ms, stays so from ${r.settled ?? "never"} ms; ` +
    `${send.polls.length} polls (~${rtt} ms apart) answered by ${nodes || "?"}` +
    `${r.otherNodePolls ? `, ${r.otherNodePolls} by another node than the send's` : ", all by the send's node"}` +
    `; live polls: ${r.liveOnSendNode} on the send's node, ${r.liveOnOtherNode} on another` +
    `${r.flipped ? "; LIVE AGAIN after gone (two views)" : ""}`
  );
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const o = poolLagOptions(argv);
  const urlFlag = argv.find((a) => a.startsWith("--url="));
  const url = urlFlag ? urlFlag.slice("--url=".length) : rpcUrl();
  if (isDryRun(argv)) {
    console.log("dry run: nothing is sent, no key is read");
    console.log(`  ${url}: ${o.sends} self-transfers per mode, modes ${o.modes.join(", ")}, polls every ${o.intervalMs} ms for up to ${o.timeoutMs} ms`);
    console.log(`  cost: fees only (${o.sends * o.modes.length} transactions, every output back to the funder)`);
    return;
  }
  const { funderKey, created } = smokeKeys();
  if (created) throw new Error("no .env.smoke yet: run smoke:contention once and fund its funder");
  const host = new URL(url).hostname;
  const logFile = startLog(`smoke-pool-lag-${host}`);

  const client = new ccc.ClientPublicTestnet({ url });
  const funder = new ccc.SignerCkbPrivateKey(client, funderKey);
  const lock = (await funder.getRecommendedAddressObj()).script;
  const node = await retrying("tx_pool_info", () => poolInfo(url));
  console.log(`node: ${url} ${node.version ?? ""}; ${node.pending} transactions pending; min_fee_rate ${node.minFeeRate}`);
  console.log(`sends ${o.sends} per mode, modes ${o.modes.join(", ")}, polls every ${o.intervalMs} ms (+ round trip), done after ${STABLE_POLLS} polls in a row show it not live or ${o.timeoutMs} ms`);

  const cells = (await retrying("cells", () => plainCells(client, lock))).filter((c) => c.cellOutput.capacity >= MIN_CELL);
  if (!cells.length) throw new Error(`the funder has no plain cell of ${fmt(MIN_CELL)} CKB or more`);
  cells.sort((a, b) => (a.cellOutput.capacity < b.cellOutput.capacity ? -1 : 1));
  let chain: Chain = { outPoint: cells[0].outPoint, cellOutput: cells[0].cellOutput };
  const startCapacity = chain.cellOutput.capacity;
  console.log(`cell: ${chain.outPoint.txHash}:${chain.outPoint.index} (${fmt(startCapacity)} CKB), spent to itself each send`);

  const summary: string[] = [];
  for (const mode of o.modes) {
    const t = makeTransport(url, mode);
    console.log(`\nmode ${mode}`);
    console.log(`  node_id before: ${(await nodeIds(t, 6)).join(" ")}`);
    const results: PoolLagResult[] = [];
    for (let i = 1; i <= o.sends; i++) {
      let out: Awaited<ReturnType<typeof sendOne>>;
      try {
        out = await sendOne(t, funder, chain, o);
      } catch (e) {
        console.log(`  send ${i}: ${errorText(e)}; stopping this mode`);
        break;
      }
      const r = poolLagResult(out.send);
      results.push(r);
      console.log(describe(i, r, out.send, out.sendMs));
      console.log(`           ${explorer(out.hash)}`);
      if (process.env.POLLS === "1") console.log(`           polls: ${out.send.polls.map((p) => `${p.ms}:${p.status}@${short(p.node)}`).join(" ")}`);
      await waitCommitted(t, out.hash);
      chain = out.next;
    }
    console.log(`  node_id after: ${(await nodeIds(t, 6)).join(" ")}`);
    if (mode !== "fetch") console.log(`  sockets used: ${t.connections.size}`);
    t.close();
    const first = msStats(results.map((r) => r.firstGone));
    const settled = msStats(results.map((r) => r.settled));
    const line =
      `${mode}: ${results.length} sends, ${results.filter((r) => r.nodes.length).length} with a poll answered; not live after median ${first.median ?? "-"} ms, max ${first.max ?? "-"} ms; ` +
      `stays not live from median ${settled.median ?? "-"} ms, max ${settled.max ?? "-"} ms; ` +
      `sends polled from another node ${results.filter((r) => r.otherNodePolls).length}; came back live ${results.filter((r) => r.flipped).length}; ` +
      `live seen on the send's node ${results.reduce((s, r) => s + r.liveOnSendNode, 0)} polls, on another ${results.reduce((s, r) => s + r.liveOnOtherNode, 0)}` +
      (mode !== "fetch" ? `; sockets ${t.connections.size}` : "");
    summary.push(line);
  }
  console.log(`\nsummary (${url})`);
  for (const line of summary) console.log(`  ${line}`);
  console.log(`  fees: ${fmt(startCapacity - chain.cellOutput.capacity)} CKB, the cell stays the funder's`);
  if (logFile) console.log(`log: ${logFile}`);
}

main().catch((e) => {
  console.error(errorText(e));
  process.exit(1);
});
