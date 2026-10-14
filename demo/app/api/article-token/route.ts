import { ccc } from "@ckb-ccc/core";
import { paymentMemo, verifyAccess, type AccessProof } from "ckb-session-kit";
import { BODIES } from "../../read/bodies";
import { CREATOR, memoLabel, PRICE_UNITS } from "../../tokens/config";
import { demoToken } from "../../tokens/token";

const client = new ccc.ClientPublicTestnet();

/**
 * Releases an article's text only to the key that paid for it in the demo
 * token. Nothing is stored: the chain is the record of who paid for what.
 */
export async function POST(request: Request) {
  let id: string, proof: AccessProof;
  try {
    ({ id, proof } = await request.json());
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const body = typeof id === "string" && Object.hasOwn(BODIES, id) ? BODIES[id] : undefined;
  if (!body) return Response.json({ error: "no such article" }, { status: 404 });

  const { script } = await ccc.Address.fromString(CREATOR, client);
  try {
    const check = await verifyAccess(client, proof, {
      to: script,
      minAmount: PRICE_UNITS,
      memo: paymentMemo(memoLabel(id)),
      token: await demoToken(client),
    });
    if (!check.ok) return Response.json({ error: check.reason }, { status: 402 });
  } catch {
    return Response.json({ error: "malformed proof" }, { status: 400 });
  }
  return Response.json({ body });
}
