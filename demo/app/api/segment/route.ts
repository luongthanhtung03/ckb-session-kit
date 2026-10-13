import { ccc } from "@ckb-ccc/core";
import { paymentMemo, verifyAccess, type AccessProof } from "ckb-session-kit";
import { compose } from "../../listen/compose";
import { CREATOR, isMinute, memoLabel, PRICE_PER_MINUTE } from "../../listen/config";

const client = new ccc.ClientPublicTestnet();

/**
 * Releases one minute of a track only to the key that paid for that minute.
 * Nothing is stored: the chain is the record of who paid for what, and the
 * score is composed on request.
 */
export async function POST(request: Request) {
  let track: unknown, minute: unknown, proof: AccessProof;
  try {
    ({ track, minute, proof } = await request.json());
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!isMinute(minute)) return Response.json({ error: "no such minute" }, { status: 404 });
  const segment = typeof track === "string" ? compose(track, minute) : undefined;
  if (!segment) return Response.json({ error: "no such track" }, { status: 404 });

  const { script } = await ccc.Address.fromString(CREATOR, client);
  try {
    const memo = paymentMemo(memoLabel(segment.track, minute));
    const check = await verifyAccess(client, proof, { to: script, minAmount: PRICE_PER_MINUTE, memo });
    if (!check.ok) return Response.json({ error: check.reason }, { status: 402 });
  } catch {
    return Response.json({ error: "malformed proof" }, { status: 400 });
  }
  return Response.json({ segment });
}
