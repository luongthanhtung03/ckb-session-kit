import { ccc } from "@ckb-ccc/core";
import { subscriptionStatus, type SessionLockDeployment } from "ckb-session-kit";
import deploymentJson from "../../../../deployment/testnet.json";
import { NOTES } from "../../subscribe/notes";
import { isAccount, isHash, termsFor } from "../../subscribe/terms";

const client = new ccc.ClientPublicTestnet();
const deployment = deploymentJson as SessionLockDeployment;

/**
 * Where a subscriber's subscription stands, and the members' notes while it is
 * paid up. Nothing is stored: every request carries the subscriber's lock hash,
 * the opening's hash and the account id the opening committed to, and the chain
 * says the rest. Bad shape 400; not a paid-up subscription 402; chain unreachable 503.
 */
export async function POST(request: Request) {
  let subscriber: unknown, openTx: unknown, account: unknown;
  try {
    ({ subscriber, openTx, account } = await request.json());
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!isHash(subscriber) || !isHash(openTx) || !isAccount(account)) {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  let r: Awaited<ReturnType<typeof subscriptionStatus>>;
  try {
    r = await subscriptionStatus(client, deployment, await termsFor(client, subscriber), { openTx, account });
  } catch {
    return Response.json({ error: "could not reach the chain", retry: true }, { status: 503 });
  }
  if (!r.ok) return Response.json({ error: r.reason }, { status: 402 });
  const s = r.status;
  return Response.json({
    status: {
      paidThroughBlock: s.paidThroughBlock?.toString(),
      tip: s.tip.toString(),
      active: s.active,
      balance: s.balance.toString(),
      chargesLeft: s.chargesLeft.toString(),
      nextChargeIn: s.nextChargeIn?.toString(),
    },
    notes: s.active ? NOTES : undefined,
  });
}
