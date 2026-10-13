/** Shared by the page and the server route. */

// The same creator as pay-per-read: its anyone-can-pay cells take both.
export { CREATOR } from "../read/config";

export const PRICE_PER_MINUTE = 50_000_000n; // 0.5 CKB
/** Every track is this long; a session's budget covers one full track. */
export const TRACK_MINUTES = 30;
/** Seconds before a minute ends at which the next one is paid for, so playback does not wait for a block. */
export const PAY_AHEAD = 30;

/** What a payment for one minute of a track records in its signed memo, e.g. `listen:tide:4`. */
export const memoLabel = (track: string, minute: number) => `listen:${track}:${minute}`;

export const isMinute = (m: unknown): m is number => Number.isInteger(m) && (m as number) >= 0 && (m as number) < TRACK_MINUTES;
