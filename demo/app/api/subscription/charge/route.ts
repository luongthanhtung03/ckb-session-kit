import { ccc } from "@ckb-ccc/core";
import { chargeSubscription, SessionBalanceError, SessionPolicyError, type SessionLockDeployment } from "ckb-session-kit";
import deploymentJson from "../../../../../deployment/testnet.json";
import { CHARGER, PAY_TO } from "../../../subscribe/config";
import { isAsset, isHash, termsFor } from "../../../subscribe/terms";

const client = new ccc.ClientPublicTestnet();
/**
 * Balance errors about the creator's own cells (the charger's fee cell, the
 * payout cell to top up): a server fault, not the subscription's state (review, 28 Oct).
 */
const CREATOR_FAULT = /^(the charger needs a plain cell|payTo has no)/;
const deployment = deploymentJson as SessionLockDeployment;

/**
 * The creator's side: charges one price from a subscription once its period is
 * over. A real creator runs this on a schedule; here the page asks for it when
 * a renewal is due. Anyone may ask: the lock lets the charger take only what it
 * is owed (one price per period, to the creator), so a request can never charge
 * more. The charger key comes from CHARGER_KEY, set in the deployment.
 */
export async function POST(request: Request) {
  const key = process.env.CHARGER_KEY;
  if (!key) return Response.json({ error: "charging is not set up on this deployment" }, { status: 503 });
  let subscriber: unknown, asset: unknown;
  try {
    ({ subscriber, asset = "ckb" } = await request.json());
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!isHash(subscriber) || !isAsset(asset)) return Response.json({ error: "bad request" }, { status: 400 });
  const subscriberLockHash = subscriber.toLowerCase() as ccc.Hex;
  try {
    const charger = new ccc.SignerCkbPrivateKey(client, key);
    if ((await charger.getRecommendedAddress()) !== CHARGER) {
      return Response.json({ error: "CHARGER_KEY is not the key of the charger address" }, { status: 503 });
    }
    const txHash = await chargeSubscription(charger, deployment, await termsFor(client, subscriberLockHash, asset), {
      payTo: PAY_TO,
      topUp: true,
    });
    return Response.json({ txHash });
  } catch (e) {
    // Not due yet, run dry, cancelled: the subscription's state, not a server fault.
    const creatorFault = e instanceof SessionBalanceError && CREATOR_FAULT.test(e.message);
    if (creatorFault) console.error(`charge: ${e.message}`);
    if (!creatorFault && (e instanceof SessionBalanceError || e instanceof SessionPolicyError)) {
      return Response.json({ error: e.message }, { status: 409 });
    }
    return Response.json({ error: "could not charge right now", retry: true }, { status: 503 });
  }
}
