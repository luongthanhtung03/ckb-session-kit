import { ccc } from "@ckb-ccc/core";
import { isSecp256k1Lock, memoWitnesses, signedWitnesses, soleMemo } from "./paywall.js";

/**
 * CKB Place: a shared pixel board kept on-chain, with no database.
 *
 * A player pays the board's anyone-can-pay address with
 * `spendInSession(…, { to: board, amount: price × pixels, topUp: true, memo })`,
 * where `memo` (from `encodePlacement`) lists the pixels. Anyone can rebuild the
 * board from the chain: take the transactions that touch the board's lock, keep
 * those that paid enough for their memo (`checkPlacement`), and apply them in
 * chain order (`applyPlacements`). Last write wins.
 *
 * This module is the pure part: no network. Finding and resolving the
 * transactions is the caller's.
 *
 * Memo format, version 1 (bytes):
 *
 *     "px1" (0x70 0x78 0x31) | x u8 | y u8 | colour u8 | x | y | colour | …
 *
 * One to `maxPixels` pixels; each must lie on the board and use a palette index
 * below `colours`. Anything else (wrong magic, a partial triple, a pixel off the
 * board, too many pixels) makes the whole memo invalid: memos come from anyone,
 * and a payment is never half-applied. A pixel may appear twice; each entry is
 * paid for and the later one wins.
 */

export interface PlaceBoard {
  /** Columns, 1–256 (x is one byte). */
  width: number;
  /** Rows, 1–256 (y is one byte). */
  height: number;
  /** Palette size, 1–256; a colour is an index below it. */
  colours: number;
  /** Shannons per pixel. */
  price: bigint;
  /** Most pixels one memo may carry; bounds the memo at 3 + 3 × maxPixels bytes. */
  maxPixels: number;
}

/** The demo's board: 32×32, 16 colours, 0.1 CKB a pixel, up to 32 pixels a payment. */
export const PLACE_BOARD: PlaceBoard = { width: 32, height: 32, colours: 16, price: 10_000_000n, maxPixels: 32 };

export interface Pixel {
  x: number;
  y: number;
  colour: number;
}

export class PlaceMemoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceMemoError";
  }
}

const MAGIC = [0x70, 0x78, 0x31]; // "px1"

const byteSized = (n: number) => Number.isInteger(n) && n >= 1 && n <= 256;

function checkBoard(board: PlaceBoard): void {
  if (!byteSized(board.width) || !byteSized(board.height) || !byteSized(board.colours)) {
    throw new PlaceMemoError("board width, height and colours must be 1–256");
  }
  if (!Number.isInteger(board.maxPixels) || board.maxPixels < 1) throw new PlaceMemoError("maxPixels must be at least 1");
  if (board.price <= 0n) throw new PlaceMemoError("price must be positive");
}

function onBoard(p: Pixel, board: PlaceBoard): boolean {
  const ok = (v: number, max: number) => Number.isInteger(v) && v >= 0 && v < max;
  return ok(p.x, board.width) && ok(p.y, board.height) && ok(p.colour, board.colours);
}

/** The memo for a placement. Throws `PlaceMemoError` for an empty, oversized or off-board list. */
export function encodePlacement(pixels: Pixel[], board: PlaceBoard = PLACE_BOARD): ccc.Hex {
  checkBoard(board);
  if (!pixels.length) throw new PlaceMemoError("no pixels to place");
  if (pixels.length > board.maxPixels) throw new PlaceMemoError(`at most ${board.maxPixels} pixels per placement`);
  const bytes = [...MAGIC];
  for (const p of pixels) {
    if (!onBoard(p, board)) throw new PlaceMemoError(`pixel (${p.x}, ${p.y}) colour ${p.colour} is not on the board`);
    bytes.push(p.x, p.y, p.colour);
  }
  return ccc.hexFrom(new Uint8Array(bytes));
}

/** The pixels in a memo, or `undefined` if it is not a valid version-1 memo for this board. Never throws. */
export function decodePlacement(memo: ccc.HexLike, board: PlaceBoard = PLACE_BOARD): Pixel[] | undefined {
  let bytes: Uint8Array;
  try {
    checkBoard(board);
    bytes = ccc.bytesFrom(memo);
  } catch {
    return undefined;
  }
  // Length first: an oversized memo is refused before it is read.
  const n = (bytes.length - MAGIC.length) / 3;
  if (!Number.isInteger(n) || n < 1 || n > board.maxPixels) return undefined;
  if (MAGIC.some((b, i) => bytes[i] !== b)) return undefined;
  const pixels: Pixel[] = [];
  for (let i = MAGIC.length; i < bytes.length; i += 3) {
    const p = { x: bytes[i], y: bytes[i + 1], colour: bytes[i + 2] };
    if (!onBoard(p, board)) return undefined;
    pixels.push(p);
  }
  return pixels;
}

/** What a placement costs, in shannons. */
export function placementPrice(pixels: number, board: PlaceBoard = PLACE_BOARD): bigint {
  return board.price * BigInt(pixels);
}

/**
 * The placement memo of `tx` and where it sits (the witness index), or `undefined`.
 *
 * With `inputs` (the cells `tx` spends, resolved, in input order) this is exact:
 * exactly one memo among the witnesses a signature covers (`signedWitnesses`: the
 * first witness of a secp256k1 lock group, as the session key's key cell has, or
 * one past the inputs), at an input's index, and a valid placement. A memo in a
 * witness nobody signed (the session cell's, the board's) is ignored: whoever
 * relays the transaction could have put it there (audit, 30 Oct).
 *
 * Without `inputs` it is the cheap check, before resolving any input: `undefined`
 * means `tx` is certainly no placement; otherwise the first witness at an input's
 * index holding a valid placement, which `checkPlacement` then settles.
 */
export function placementMemo(
  tx: ccc.TransactionLike,
  board: PlaceBoard = PLACE_BOARD,
  inputs?: ccc.CellOutputLike[],
): { index: number; pixels: Pixel[] } | undefined {
  const t = ccc.Transaction.from(tx);
  if (!inputs) {
    for (const m of memoWitnesses(t)) {
      const pixels = m.index < t.inputs.length ? decodePlacement(m.memo, board) : undefined;
      if (pixels) return { index: m.index, pixels };
    }
    return undefined;
  }
  if (inputs.length !== t.inputs.length) return undefined;
  const locks = inputs.map((c) => ccc.CellOutput.from(c).lock);
  // Two signed memos: which one was paid for is ambiguous.
  const found = soleMemo(t, signedWitnesses(t, locks, (lock) => isSecp256k1Lock(lock)));
  if (!found || found.index >= t.inputs.length) return undefined;
  const pixels = decodePlacement(found.memo, board);
  return pixels && { index: found.index, pixels };
}

export type PlacementCheck = { ok: true; pixels: Pixel[]; paid: bigint } | { ok: false; reason: string };

/**
 * Whether `tx` is a valid placement on the board under `boardLock`. `inputs` are
 * the cells `tx` spends, resolved, in input order.
 *
 * - exactly one memo among the witnesses a signature covers, and a valid one,
 *   in the first witness of a secp256k1 lock group that is not the board's
 *   (`placementMemo` with `inputs`): the witness the payer's lock signs (the
 *   session key's key cell), so the payment commits to these pixels and no relay
 *   can swap them, nor add a memo of its own that counts;
 * - the board's lock gained at least `price × pixels` (outputs minus inputs).
 */
export function checkPlacement(
  tx: ccc.TransactionLike,
  inputs: ccc.CellOutputLike[],
  boardLock: ccc.ScriptLike,
  board: PlaceBoard = PLACE_BOARD,
): PlacementCheck {
  const t = ccc.Transaction.from(tx);
  if (inputs.length !== t.inputs.length) return { ok: false, reason: "inputs not resolved" };
  const memo = placementMemo(t, board, inputs);
  if (!memo) return { ok: false, reason: "no valid placement memo" };

  const lock = ccc.Script.from(boardLock);
  const cells = inputs.map((c) => ccc.CellOutput.from(c));
  if (cells[memo.index].lock.eq(lock)) return { ok: false, reason: "the memo is in the board's own witness" };

  const sum = (cs: ccc.CellOutput[]) => cs.reduce((s, c) => (c.lock.eq(lock) ? s + c.capacity : s), 0n);
  const paid = sum(t.outputs) - sum(cells);
  const price = placementPrice(memo.pixels.length, board);
  if (paid < price) {
    return { ok: false, reason: `paid ${ccc.fixedPointToString(paid)} CKB for ${memo.pixels.length} pixel(s), below ${ccc.fixedPointToString(price)}` };
  }
  return { ok: true, pixels: memo.pixels, paid };
}

/** A checked placement and where it sits in the chain. */
export interface Placement {
  txHash: ccc.Hex;
  blockNumber: bigint;
  /** Position of the transaction in its block. */
  txIndex: number;
  pixels: Pixel[];
}

/** One square of the board: its colour and the transaction that set it last. */
export interface PlacedPixel {
  colour: number;
  txHash: ccc.Hex;
  blockNumber: bigint;
}

/** Row-major, `width × height` long; `undefined` where nothing has been placed. */
export type BoardState = (PlacedPixel | undefined)[];

/**
 * The board after `placements`, applied in chain order (block number, then
 * position in the block) whatever order they are given in; within one
 * placement, in memo order. Last write wins. A transaction listed twice counts
 * once, and a pixel off the board is skipped.
 */
export function applyPlacements(placements: Placement[], board: PlaceBoard = PLACE_BOARD): BoardState {
  const state: BoardState = new Array(board.width * board.height).fill(undefined);
  const seen = new Set<string>();
  const ordered = [...placements].sort((a, b) =>
    a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.txIndex - b.txIndex,
  );
  for (const p of ordered) {
    if (seen.has(p.txHash)) continue;
    seen.add(p.txHash);
    for (const px of p.pixels) {
      if (!onBoard(px, board)) continue;
      state[px.y * board.width + px.x] = { colour: px.colour, txHash: p.txHash, blockNumber: p.blockNumber };
    }
  }
  return state;
}
