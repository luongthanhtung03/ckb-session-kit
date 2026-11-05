import { ccc } from "@ckb-ccc/core";

/**
 * Confirmation depth for the checks that accept a payment as proof of access
 * (`verifyAccess`, `verifySubscription`, `subscriptionStatus`).
 *
 * Counting: a transaction in block `b` has `tip - b + 1` confirmations when the
 * tip is block `tip`. The block that includes it is the first confirmation, as
 * in the usual (Bitcoin) count; a payment in the tip block has 1.
 * `minConfirmations` 0 (the default) checks no depth at all: committed is
 * enough, exactly as before the option existed, and nothing more is fetched.
 * 1 is the same depth as 0 plus the main-chain check below.
 *
 * A payment with enough confirmations must also still be on the main chain: the
 * node's header at its block number must be the block the node said holds it
 * (read without CCC's cache). Otherwise it is not counted (`"reorged"`).
 */

/** The largest `minConfirmations` accepted: about a day of CKB blocks. Anything past it is taken for a mistake. */
export const MAX_MIN_CONFIRMATIONS = 10_000;

/** Why a payment that is otherwise valid does not count yet, or no longer counts. */
export type ConfirmationFault =
  | {
      ok: false;
      /** Committed, but not yet `minConfirmations` deep: ask again later. */
      code: "unconfirmed";
      reason: string;
      /** `tip - block + 1`, or 0 when the node gave no block (or a block past the tip read). */
      confirmations: bigint;
      minConfirmations: bigint;
    }
  | {
      ok: false;
      /** Its block is no longer on the main chain: not counted. */
      code: "reorged";
      reason: string;
    };

/** `minConfirmations` checked: a non-negative integer up to `MAX_MIN_CONFIRMATIONS`; undefined is 0. */
export function minConfirmationsFrom(value: unknown): bigint {
  if (value === undefined) return 0n;
  const ok =
    (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_MIN_CONFIRMATIONS) ||
    (typeof value === "bigint" && value >= 0n && value <= BigInt(MAX_MIN_CONFIRMATIONS));
  if (!ok) {
    throw new RangeError(`minConfirmations must be an integer from 0 to ${MAX_MIN_CONFIRMATIONS}, got ${String(value)}`);
  }
  return BigInt(value as number | bigint);
}

/** Confirmations of a transaction in block `block` with the tip at `tip`: `tip - block + 1`, never below 0. */
export const confirmationsAt = (tip: bigint, block: bigint): bigint => (tip >= block ? tip - block + 1n : 0n);

/**
 * Why the committed transaction `res` (from `getTransactionNoCache`) does not
 * count at `minConfirmations` with the tip at `tip`; undefined when it does.
 * `what` names it in the reason ("payment", "the opening", …).
 */
export async function confirmationFault(
  client: ccc.Client,
  tip: bigint,
  res: { blockNumber?: ccc.NumLike | null; blockHash?: ccc.HexLike | null },
  minConfirmations: bigint,
  what: string,
): Promise<ConfirmationFault | undefined> {
  if (minConfirmations === 0n) return undefined;
  const known = res.blockNumber !== undefined && res.blockNumber !== null && res.blockHash !== undefined && res.blockHash !== null;
  const block = known ? ccc.numFrom(res.blockNumber!) : undefined;
  const confirmations = block === undefined ? 0n : confirmationsAt(tip, block);
  if (confirmations < minConfirmations) {
    return {
      ok: false,
      code: "unconfirmed",
      reason: `${what} has ${confirmations} of ${minConfirmations} confirmations`,
      confirmations,
      minConfirmations,
    };
  }
  // The node's main chain now, not CCC's header cache.
  const header = await client.getHeaderByNumberNoCache(block!);
  if (!header || header.hash !== ccc.hexFrom(res.blockHash!)) {
    return { ok: false, code: "reorged", reason: `${what}'s block is no longer on the main chain` };
  }
  return undefined;
}
