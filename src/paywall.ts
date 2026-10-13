import { ccc } from "@ckb-ccc/core";
import type { Session } from "./session.js";
import { sessionSigner } from "./transfer.js";

/**
 * Paid access, checked against the chain with no database.
 *
 * The payer pays with `spendInSession(…, { memo })`. The memo goes into the
 * witness of the session key's own input, which that key's signature covers, so
 * the payment commits to what it pays for: it cannot be reused for something else.
 *
 * To claim the access, the payer signs a request with the same session key
 * (`signAccess`). A server checks both with `verifyAccess`: the payment is
 * committed, the recipient gained enough, the memo matches, and the request is
 * signed by the key that paid. Anyone can see the payment on-chain; only the
 * payer can use it.
 *
 * One payment, one claim: a payment transaction may carry exactly one memo.
 * Otherwise one transaction could pay the creator once and carry memos from
 * several keys, each claiming the full amount for a different article or reader.
 */

/** A session payment has a handful of inputs; more is not one, and costs RPC calls to check. */
const MAX_PAYMENT_INPUTS = 16;

/** The memo for a payment: a short UTF-8 label, e.g. `read:article-1`. */
export function paymentMemo(label: string): ccc.Hex {
  return ccc.hexFrom(ccc.bytesFrom(label, "utf8"));
}

function accessMessage(txHash: ccc.HexLike, memo: ccc.HexLike): string {
  return `ckb-session-kit access ${ccc.hexFrom(txHash)} ${ccc.hexFrom(memo)}`;
}

export interface AccessProof {
  txHash: ccc.Hex;
  memo: ccc.Hex;
  /** The session key's public key. */
  publicKey: ccc.Hex;
  signature: ccc.Hex;
}

/** The payer's side: prove that the key which paid `txHash` is asking. */
export async function signAccess(session: Session, txHash: ccc.HexLike, memo: ccc.HexLike): Promise<AccessProof> {
  const signer = sessionSigner(session, new ccc.ClientPublicTestnet());
  const { signature } = await signer.signMessage(accessMessage(txHash, memo));
  return { txHash: ccc.hexFrom(txHash), memo: ccc.hexFrom(memo), publicKey: signer.publicKey, signature: ccc.hexFrom(signature) };
}

export type AccessCheck = { ok: true; paid: bigint } | { ok: false; reason: string };

/**
 * The server's side. `to` is the recipient that must have been paid, as a lock
 * script; `minAmount` in shannons.
 */
export async function verifyAccess(
  client: ccc.Client,
  proof: AccessProof,
  expect: { to: ccc.ScriptLike; minAmount: bigint; memo: ccc.HexLike },
): Promise<AccessCheck> {
  if (ccc.hexFrom(proof.memo) !== ccc.hexFrom(expect.memo)) return { ok: false, reason: "memo does not match" };

  // Always the CKB secp256k1 scheme: a sign type chosen by the caller is not trusted.
  let signed = false;
  try {
    signed = ccc.verifyMessageCkbSecp256k1(accessMessage(proof.txHash, proof.memo), proof.signature, proof.publicKey);
  } catch {
    signed = false;
  }
  if (!signed) return { ok: false, reason: "request not signed by the given key" };

  const res = await client.getTransaction(proof.txHash);
  if (!res) return { ok: false, reason: "payment not found" };
  if (res.status !== "committed") return { ok: false, reason: `payment is ${res.status}, not committed` };
  const tx = res.transaction;

  // Cheap checks first, before resolving any input over RPC.
  if (tx.inputs.length > MAX_PAYMENT_INPUTS) return { ok: false, reason: "not a session payment: too many inputs" };
  let memos = 0;
  for (let i = 0; i < tx.witnesses.length; i++) {
    let inputType: ccc.Hex | undefined;
    try {
      inputType = tx.getWitnessArgsAt(i)?.inputType;
    } catch {
      continue; // not WitnessArgs: carries no memo
    }
    if (inputType !== undefined) memos++;
  }
  if (memos !== 1) return { ok: false, reason: "a payment must carry exactly one memo" };

  // The payer's lock: the standard secp256k1 lock of the key that signed the request.
  const payerLock = (await new ccc.SignerCkbPublicKey(client, proof.publicKey).getAddressObjSecp256k1()).script;
  const to = ccc.Script.from(expect.to);

  let payerInput = -1;
  let toIn = 0n;
  for (let i = 0; i < tx.inputs.length; i++) {
    const cell = await client.getCell(tx.inputs[i].previousOutput);
    if (!cell) return { ok: false, reason: "an input of the payment cannot be resolved" };
    if (payerInput < 0 && cell.cellOutput.lock.eq(payerLock)) payerInput = i;
    if (cell.cellOutput.lock.eq(to)) toIn += cell.cellOutput.capacity;
  }
  if (payerInput < 0) return { ok: false, reason: "the signing key did not pay this transaction" };

  // The witness the payer's lock verified (the first of its group) must carry the memo.
  const witness = tx.getWitnessArgsAt(payerInput);
  if (!witness?.inputType || ccc.hexFrom(witness.inputType) !== ccc.hexFrom(expect.memo)) {
    return { ok: false, reason: "the payment does not carry this memo" };
  }

  const toOut = tx.outputs.reduce((sum, o) => (o.lock.eq(to) ? sum + o.capacity : sum), 0n);
  const paid = toOut - toIn;
  if (paid < expect.minAmount) return { ok: false, reason: `paid ${ccc.fixedPointToString(paid)} CKB, below the price` };
  return { ok: true, paid };
}
