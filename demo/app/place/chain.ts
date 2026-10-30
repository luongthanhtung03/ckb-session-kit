import { ccc } from "@ckb-ccc/core";
import { checkPlacement, placementMemo, type PlaceBoard, type Placement } from "ckb-session-kit";

/**
 * Reads the board from the chain: every transaction on the board's lock, kept
 * if it is a paid placement (`checkPlacement`). No server, no database. The
 * library does the checking; this file does the fetching.
 */

/** A placement has a handful of inputs; more is not one, and costs RPC calls to resolve. */
const MAX_INPUTS = 16;
/** Transactions resolved at once. */
const PARALLEL = 8;
const NO_END = 0xffff_ffff_ffff_ffffn;

/** What has been read so far, kept between polls so each poll fetches only what is new. */
export interface BoardScan {
  placements: Placement[];
  /** Transactions already answered for: placements, or definitely not one. */
  seen: Set<string>;
  /**
   * Listed by the indexer, but get_transaction gave no answer yet (the other RPC
   * host may be a block behind): asked again on every poll until it answers.
   */
  missed: TxRecord[];
  /** The next poll starts here: the last block seen may get more transactions. */
  fromBlock: bigint;
}

export const emptyScan = (): BoardScan => ({ placements: [], seen: new Set(), missed: [], fromBlock: 0n });

export type TxRecord = { txHash: ccc.Hex; blockNumber: bigint; txIndex: bigint; cells: { isInput: boolean }[] };

/**
 * `scan` plus what is new on-chain. A failure leaves `scan` as it was, to retry.
 * A transaction is added to `seen` only once it is answered for; one the node
 * gave no answer about is kept in `missed` and asked about again next poll (audit, 31 Oct).
 */
export async function scanBoard(client: ccc.Client, boardLock: ccc.Script, board: PlaceBoard, scan: BoardScan): Promise<BoardScan> {
  const next: BoardScan = { placements: [...scan.placements], seen: new Set(scan.seen), missed: [], fromBlock: scan.fromBlock };
  const fresh: TxRecord[] = [...(scan.missed ?? [])];
  const queued = new Set(fresh.map((r) => r.txHash));
  for await (const rec of client.findTransactions(
    {
      script: boardLock,
      scriptType: "lock",
      scriptSearchMode: "exact",
      filter: { blockRange: [scan.fromBlock, NO_END] },
      groupByTransaction: true,
    },
    "asc",
    100,
  )) {
    if (rec.blockNumber > next.fromBlock) next.fromBlock = rec.blockNumber;
    if (next.seen.has(rec.txHash) || queued.has(rec.txHash)) continue;
    // A top-up spends one of the board's cells; a transaction that only creates them (setup) places nothing.
    if (!rec.cells.some((c) => c.isInput)) {
      next.seen.add(rec.txHash);
      continue;
    }
    queued.add(rec.txHash);
    fresh.push(rec);
  }
  for (let i = 0; i < fresh.length; i += PARALLEL) {
    const batch = fresh.slice(i, i + PARALLEL);
    const found = await Promise.all(batch.map((r) => readPlacement(client, r, boardLock, board)));
    found.forEach((p, j) => {
      if (p === MISSED) return void next.missed.push(batch[j]);
      next.seen.add(batch[j].txHash);
      if (p) next.placements.push(p);
    });
  }
  return next;
}

/** No answer about the transaction yet: ask again on the next poll. */
const MISSED = Symbol("missed");

/** The placement, undefined when the transaction is definitely not one, or MISSED. */
async function readPlacement(
  client: ccc.Client,
  rec: TxRecord,
  boardLock: ccc.Script,
  board: PlaceBoard,
): Promise<Placement | undefined | typeof MISSED> {
  const res = await client.getTransaction(rec.txHash);
  // The indexer listed it, so it is committed: no answer, or another, is the node asked lagging.
  if (!res || res.status !== "committed") return MISSED;
  const tx = res.transaction;
  // Cheap checks first, before resolving any input over RPC.
  if (tx.inputs.length > MAX_INPUTS || !placementMemo(tx, board)) return undefined;
  const cells = await Promise.all(tx.inputs.map((input) => client.getCell(input.previousOutput)));
  if (cells.some((c) => !c)) return MISSED;
  const check = checkPlacement(tx, cells.map((c) => c!.cellOutput), boardLock, board);
  if (!check.ok) return undefined;
  return { txHash: rec.txHash, blockNumber: rec.blockNumber, txIndex: Number(rec.txIndex), pixels: check.pixels };
}
