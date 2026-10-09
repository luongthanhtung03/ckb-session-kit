/**
 * Server only: imported by app/api/article/route.ts, never by a page, so the text
 * is not in any client bundle.
 */
export const BODIES: Record<string, string[]> = {
  "occupied-capacity": [
      "A cell must hold at least as many CKB as the bytes it occupies: its capacity field, its lock script, its type script and its data. A plain cell under the standard secp256k1 lock is 61 bytes, so it needs 61 CKB just to exist.",
      "That means a payment of 1 CKB cannot create a new cell for the recipient. The fix is to pay into a cell that already exists. The anyone-can-pay lock allows exactly that: anyone may consume the cell as long as they recreate it with at least as much capacity, and no signature from the owner is needed to add to it.",
      "Every unlock on this page is such a top-up: the creator's anyone-can-pay cell is consumed and recreated 1 CKB larger.",
    ],
  "since": [
      "CKB scripts see the transaction and the cells it touches, but not the current time or block. The `since` field on an input lets a script demand that the input be at least so old, because the node refuses to include the transaction earlier. It is a lower bound only.",
      "So an expiry, a promise that something stops working after a moment, cannot be enforced by a script. A transaction that was valid before the expiry stays valid after it.",
      "That is why this session's expiry is enforced by the browser, while the per-transaction limit and the recipient are enforced on-chain: those depend only on the transaction itself.",
    ],
  "delegation": [
      "Every input's lock script runs during verification. If a transaction spends a cell under the owner's standard lock, that lock has already checked the owner's signature over the whole transaction.",
      "The session lock relies on this. It asks one question: does the transaction also spend a cell under the owner's lock, or under the session key's lock? The first unlocks everything; the second unlocks spending inside the limits. sUDT's owner mode uses the same pattern.",
      "Carrying no signature code keeps the script at 4.3 KB and about 13,000 cycles, under 1% of what the secp256k1 lock that does the real checking costs.",
    ],
};
