/** CKB Place: the board the page paints on. */
import { PLACE_BOARD, type PlaceBoard } from "ckb-session-kit";

/** An anyone-can-pay address with all-zero args: nobody holds its key and it has no cells. */
const PLACEHOLDER = "ckt1qq6pngwqn6e9vlm92th84rk0l4jp2h8lurchjmnwv8kq3rt5psf4vqgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq46nl6k";

/**
 * The board's anyone-can-pay address on testnet. Players top up its cells.
 *
 * PLACEHOLDER until `npm run setup:board` has run: paste the address it prints
 * here. Until then the page shows the (empty) board but will not open a session.
 */
export const BOARD: string = PLACEHOLDER;
export const BOARD_READY = BOARD !== PLACEHOLDER;

/** 32×32, 16 colours, 0.1 CKB a pixel, up to 32 pixels in one payment. */
export const PLACE: PlaceBoard = PLACE_BOARD;

/** What each colour index on-chain looks like. The chain stores only the index. */
export const PALETTE = [
  "#ffffff", "#e4e4e4", "#888888", "#222222",
  "#ffa7d1", "#e50000", "#e59500", "#a06a42",
  "#e5d900", "#94e044", "#02be01", "#00d3dd",
  "#0083c7", "#0000ea", "#cf6ee4", "#820080",
];
