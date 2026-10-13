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
  /** Transactions already looked at, placements or not. */
  seen: Set<string>;
  /** The next poll starts here: the last block seen may get more transactions. */
  fromBlock: bigint;
}

export const emptyScan = (): BoardScan => ({ placements: [], seen: new Set(), fromBlock: 0n });

type TxRecord = { txHash: ccc.Hex; blockNumber: bigint; txIndex: bigint; cells: { isInput: boolean }[] };

/** `scan` plus what is new on-chain. A failure leaves `scan` as it was, to retry. */
export async function scanBoard(client: ccc.Client, boardLock: ccc.Script, board: PlaceBoard, scan: BoardScan): Promise<BoardScan> {
  const next: BoardScan = { placements: [...scan.placements], seen: new Set(scan.seen), fromBlock: scan.fromBlock };
  const fresh: TxRecord[] = [];
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
    if (next.seen.has(rec.txHash)) continue;
    next.seen.add(rec.txHash);
    if (rec.blockNumber > next.fromBlock) next.fromBlock = rec.blockNumber;
    // A top-up spends one of the board's cells; a transaction that only creates them (setup) places nothing.
    if (rec.cells.some((c) => c.isInput)) fresh.push(rec);
  }
  for (let i = 0; i < fresh.length; i += PARALLEL) {
    const found = await Promise.all(fresh.slice(i, i + PARALLEL).map((r) => readPlacement(client, r, boardLock, board)));
    for (const p of found) if (p) next.placements.push(p);
  }
  return next;
}

async function readPlacement(client: ccc.Client, rec: TxRecord, boardLock: ccc.Script, board: PlaceBoard): Promise<Placement | undefined> {
  const res = await client.getTransaction(rec.txHash);
  if (!res || res.status !== "committed") return undefined;
  const tx = res.transaction;
  // Cheap checks first, before resolving any input over RPC.
  if (tx.inputs.length > MAX_INPUTS || !placementMemo(tx, board)) return undefined;
  const cells = await Promise.all(tx.inputs.map((input) => client.getCell(input.previousOutput)));
  if (cells.some((c) => !c)) return undefined;
  const check = checkPlacement(tx, cells.map((c) => c!.cellOutput), boardLock, board);
  if (!check.ok) return undefined;
  return { txHash: rec.txHash, blockNumber: rec.blockNumber, txIndex: Number(rec.txIndex), pixels: check.pixels };
}
