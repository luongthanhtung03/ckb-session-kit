/**
 * Server only: the gating behind app/api/segment/route.ts, kept apart from the
 * route so it can be tested with a mocked client and no network.
 */
import { ccc } from "@ckb-ccc/core";
import { paymentMemo, verifyAccess, type AccessProof } from "ckb-session-kit";
import { compose } from "./compose";
import { CREATOR, isMinute, memoLabel, PRICE_PER_MINUTE } from "./config";
import type { Segment } from "./tracks";

export type Release = { status: 200; body: { segment: Segment } } | { status: 400 | 402 | 404; body: { error: string } };

/**
 * Minute `minute` of `track`, released only when `proof` shows that its key
 * paid the creator at least PRICE_PER_MINUTE in a committed transaction whose
 * one memo is exactly `listen:<track>:<minute>`. A payment for one minute or
 * track never releases another, and only the key that paid can claim it.
 */
export async function release(client: ccc.Client, request: unknown): Promise<Release> {
  const fail = (status: 400 | 402 | 404, error: string): Release => ({ status, body: { error } });
  if (typeof request !== "object" || request === null) return fail(400, "bad request");
  const { track, minute, proof } = request as { track?: unknown; minute?: unknown; proof?: unknown };
  if (!isMinute(minute)) return fail(404, "no such minute");
  const segment = typeof track === "string" ? compose(track, minute) : undefined;
  if (!segment) return fail(404, "no such track");

  const { script } = await ccc.Address.fromString(CREATOR, client);
  try {
    const memo = paymentMemo(memoLabel(segment.track, minute));
    const check = await verifyAccess(client, proof as AccessProof, { to: script, minAmount: PRICE_PER_MINUTE, memo });
    if (!check.ok) return fail(402, check.reason);
  } catch {
    return fail(400, "malformed proof");
  }
  return { status: 200, body: { segment } };
}
