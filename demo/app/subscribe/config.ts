/** Shared by the page and the server routes. */
import { CREATOR } from "../read/config";

/** The creator's charger key: its secp256k1 address. The server holds this key (CHARGER_KEY). */
export const CHARGER =
  "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqfrks0ww06uv9pgqzwuajnq694mjncvctgqcjrs7";
/** Charges top up the creator's anyone-can-pay cell (the same one pay-per-read pays). */
export const PAY_TO = CREATOR;

const CKB = 100_000_000n;
export const PRICE = 2n * CKB;
/** About 10 minutes of testnet blocks: short enough to watch a renewal happen. */
export const PERIOD_BLOCKS = 60n;
/** The cell's own 153 CKB plus five more periods. */
export const BUDGET = 163n * CKB;

/** Paid in the demo token instead (mint it on /tokens): 2 units a period, 10 units in the cell. */
export const TOKEN_PRICE = 2n;
export const TOKEN_UNITS = 10n;
