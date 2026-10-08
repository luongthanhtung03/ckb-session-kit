import { ccc } from "@ckb-ccc/core";
import { checkRequest, type Session } from "./session.js";

export class ScopeError extends Error {
  constructor(reason: string) {
    super(`refused by session scope: ${reason}`);
    this.name = "ScopeError";
  }
}

export function sessionSigner(session: Session, client: ccc.Client): ccc.SignerCkbPrivateKey {
  return new ccc.SignerCkbPrivateKey(client, session.privateKey);
}

/** The address the session key controls. Fund it to give the session a budget. */
export async function sessionAddress(session: Session, client: ccc.Client): Promise<string> {
  return sessionSigner(session, client).getRecommendedAddress();
}

/**
 * Sends `amount` shannons to `to`, signed by the session key with no wallet
 * dialog. The scope is checked before anything is built or signed.
 *
 * Until the session lock lands, the scope is enforced here in the browser only;
 * the on-chain lock will make the same refusal binding.
 */
export async function sendInScope(
  session: Session,
  client: ccc.Client,
  request: { to: string; amount: bigint },
  now: Date = new Date(),
): Promise<ccc.Hex> {
  const check = checkRequest(session, request, now);
  if (!check.ok) throw new ScopeError(check.reason);

  const signer = sessionSigner(session, client);
  const { script: lock } = await ccc.Address.fromString(request.to, client);
  const tx = ccc.Transaction.from({ outputs: [{ lock, capacity: request.amount }] });
  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer);
  return signer.sendTransaction(tx);
}
