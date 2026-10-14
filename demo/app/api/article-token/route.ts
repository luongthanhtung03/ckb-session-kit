import { ccc } from "@ckb-ccc/core";
import { paymentMemo } from "ckb-session-kit";
import { BODIES } from "../../read/bodies";
import { CREATOR, memoLabel, PRICE_UNITS } from "../../tokens/config";
import { demoToken } from "../../tokens/token";
import { checkAccess } from "../access";

const client = new ccc.ClientPublicTestnet();

/**
 * Releases an article's text only to the key that paid for it in the demo
 * token. Nothing is stored: the chain is the record of who paid for what. A
 * malformed proof is 400; the chain unreachable is 503 with `retry: true`.
 */
export async function POST(request: Request) {
  let id: unknown, proof: unknown;
  try {
    ({ id, proof } = await request.json());
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  const body = typeof id === "string" && Object.hasOwn(BODIES, id) ? BODIES[id] : undefined;
  if (typeof id !== "string" || !body) return Response.json({ error: "no such article" }, { status: 404 });

  const denied = await checkAccess(client, proof, async () => ({
    to: (await ccc.Address.fromString(CREATOR, client)).script,
    minAmount: PRICE_UNITS,
    memo: paymentMemo(memoLabel(id)),
    token: await demoToken(client),
  }));
  if (denied) return Response.json(denied.body, { status: denied.status });
  return Response.json({ body });
}
