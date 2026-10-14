/** Shared by the page and the server route. */
export { CREATOR } from "../read/config";

/** An article costs 2 units of the demo token. */
export const PRICE_UNITS = 2n;
/** Its own memo, so a payment made on the CKB page never unlocks one here, or the reverse. */
export const memoLabel = (id: string) => `read-token:${id}`;
