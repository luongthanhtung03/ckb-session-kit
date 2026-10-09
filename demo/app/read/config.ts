/** Shared by the page and the server route. */

/** The creator's anyone-can-pay address on testnet. Readers top up its cells. */
export const CREATOR =
  "ckt1qq6pngwqn6e9vlm92th84rk0l4jp2h8lurchjmnwv8kq3rt5psf4vqfrks0ww06uv9pgqzwuajnq694mjncvctg0t589g";
export const PRICE = 100_000_000n; // 1 CKB
/** What a payment for an article records in its signed memo. */
export const memoLabel = (id: string) => `read:${id}`;
