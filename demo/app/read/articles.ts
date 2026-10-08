/**
 * The demo's articles. A real site would serve the locked text from its server
 * only after checking the payment on-chain; here it ships with the page, so the
 * "paywall" shows the payment flow, not content protection.
 */
export interface Article {
  id: string;
  title: string;
  teaser: string;
  body: string[];
}

export const ARTICLES: Article[] = [
  {
    id: "occupied-capacity",
    title: "Why a 1 CKB payment needs someone else's cell",
    teaser: "On CKB, every byte of state is paid for in CKB. That rule makes small payments harder than they look.",
    body: [
      "A cell must hold at least as many CKB as the bytes it occupies: its capacity field, its lock script, its type script and its data. A plain cell under the standard secp256k1 lock is 61 bytes, so it needs 61 CKB just to exist.",
      "That means a payment of 1 CKB cannot create a new cell for the recipient. The fix is to pay into a cell that already exists. The anyone-can-pay lock allows exactly that: anyone may consume the cell as long as they recreate it with at least as much capacity, and no signature from the owner is needed to add to it.",
      "Every unlock on this page is such a top-up: the creator's anyone-can-pay cell is consumed and recreated 1 CKB larger.",
    ],
  },
  {
    id: "since",
    title: "What a lock script cannot know",
    teaser: "A script can prove that time has passed. It can never prove that it has not.",
    body: [
      "CKB scripts see the transaction and the cells it touches, but not the current time or block. The `since` field on an input lets a script demand that the input be at least so old, because the node refuses to include the transaction earlier. It is a lower bound only.",
      "So an expiry, a promise that something stops working after a moment, cannot be enforced by a script. A transaction that was valid before the expiry stays valid after it.",
      "That is why this session's expiry is enforced by the browser, while the per-transaction limit and the recipient are enforced on-chain: those depend only on the transaction itself.",
    ],
  },
  {
    id: "delegation",
    title: "A lock with no cryptography in it",
    teaser: "The session lock never checks a signature. It lets other locks do that.",
    body: [
      "Every input's lock script runs during verification. If a transaction spends a cell under the owner's standard lock, that lock has already checked the owner's signature over the whole transaction.",
      "The session lock relies on this. It asks one question: does the transaction also spend a cell under the owner's lock, or under the session key's lock? The first unlocks everything; the second unlocks spending inside the limits. sUDT's owner mode uses the same pattern.",
      "Carrying no signature code keeps the script at 4.3 KB and about 13,000 cycles, under 1% of what the secp256k1 lock that does the real checking costs.",
    ],
  },
];
