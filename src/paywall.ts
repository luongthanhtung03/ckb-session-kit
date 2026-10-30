import { ccc } from "@ckb-ccc/core";
import type { Session } from "./session.js";
import { tokenAmount } from "./onchain.js";
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
 * One payment, one claim: a payment transaction may carry exactly one memo in
 * the witnesses a signature covers. Otherwise one transaction could pay the
 * creator once and carry memos from several keys, each claiming the full amount
 * for a different article or reader. A memo in a witness nobody signed (the
 * session cell's) does not count: whoever relays the payment could add one.
 */

/** A session payment has a handful of inputs; more is not one, and costs RPC calls to check. */
const MAX_PAYMENT_INPUTS = 16;

/** The memo for a payment: a short UTF-8 label, e.g. `read:article-1`. */
export function paymentMemo(label: string): ccc.Hex {
  return ccc.hexFrom(ccc.bytesFrom(label, "utf8"));
}

/**
 * The standard secp256k1-blake160 sighash_all lock, the session key's own lock: the
 * same code on mainnet and testnet. Its signature covers the first witness of its
 * lock group (and the rest of the group, and every witness past the inputs).
 */
const SECP256K1_BLAKE160 = {
  codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  hashType: "type",
} as const;

/** Whether `lock` runs the standard secp256k1-blake160 sighash_all code (`code`: that script on this network). */
export const isSecp256k1Lock = (lock: ccc.Script, code: { codeHash: ccc.Hex; hashType: ccc.HashType } = SECP256K1_BLAKE160) =>
  lock.codeHash === code.codeHash && lock.hashType === code.hashType;

/**
 * Which witnesses of `tx` a signature covers, given the locks of its inputs in
 * order: the first witness of each input lock group whose lock signs (`signs`),
 * and every witness past the inputs, which a sighash_all signature also covers.
 *
 * Any other witness can be changed by whoever relays the transaction without
 * changing its hash: a session cell's (the session lock reads no witness) or an
 * anyone-can-pay cell's taking a top-up (audit, 30 Oct). A memo there is nobody's.
 */
export function signedWitnesses(
  tx: ccc.Transaction,
  inputLocks: ccc.ScriptLike[],
  signs: (lock: ccc.Script) => boolean,
): (index: number) => boolean {
  const locks = inputLocks.map((l) => ccc.Script.from(l));
  return (i) =>
    i >= tx.inputs.length || (i < locks.length && signs(locks[i]) && !locks.slice(0, i).some((l) => l.eq(locks[i])));
}

/** Every witness carrying a memo (an `inputType`), with its index. */
export function memoWitnesses(tx: ccc.Transaction): { index: number; memo: ccc.Hex }[] {
  const found: { index: number; memo: ccc.Hex }[] = [];
  for (let i = 0; i < tx.witnesses.length; i++) {
    let inputType: ccc.Hex | undefined;
    try {
      inputType = tx.getWitnessArgsAt(i)?.inputType;
    } catch {
      continue; // not WitnessArgs: carries no memo
    }
    if (inputType !== undefined) found.push({ index: i, memo: inputType });
  }
  return found;
}

/**
 * The one witness carrying a memo and its index; undefined with none or several.
 * Only witnesses `counts` accepts are looked at (`signedWitnesses`: those a
 * signature covers); by default, all of them.
 */
export function soleMemo(
  tx: ccc.Transaction,
  counts: (index: number) => boolean = () => true,
): { index: number; memo: ccc.Hex } | undefined {
  const found = memoWitnesses(tx).filter((m) => counts(m.index));
  return found.length === 1 ? found[0] : undefined;
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
 * script; `minAmount` in shannons. With `token` (an xUDT type script), the
 * payment is counted in that token's units instead, and `minAmount` is in units.
 */
export async function verifyAccess(
  client: ccc.Client,
  proof: AccessProof,
  expect: { to: ccc.ScriptLike; minAmount: bigint; memo: ccc.HexLike; token?: ccc.ScriptLike },
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

  // Not getTransaction: when the node no longer knows a transaction (reorged out,
  // replaced by a conflicting spend), it answers from CCC's cache, where a payment
  // once seen committed stays committed (audit, 31 Oct).
  const res = await client.getTransactionNoCache(proof.txHash);
  if (!res) return { ok: false, reason: "payment not found" };
  if (res.status !== "committed") return { ok: false, reason: `payment is ${res.status}, not committed` };
  const tx = res.transaction;

  // Cheap checks first, before resolving any input over RPC.
  if (tx.inputs.length > MAX_PAYMENT_INPUTS) return { ok: false, reason: "not a session payment: too many inputs" };
  const memos = memoWitnesses(tx);
  if (!memos.length) return { ok: false, reason: "a payment must carry exactly one memo" };

  // The payer's lock: the standard secp256k1 lock of the key that signed the request.
  const payerLock = (await new ccc.SignerCkbPublicKey(client, proof.publicKey).getAddressObjSecp256k1()).script;

  // Before all of them, only the inputs whose witness carries a memo, until one is
  // the payer's (usually the first): anyone can sign a request for someone else's
  // public payment, and must not get to make the server resolve every input.
  const known = new Map<number, ccc.Cell | undefined>();
  let paidByKey = false;
  for (const { index } of memos) {
    if (index >= tx.inputs.length) continue;
    const cell = await client.getCell(tx.inputs[index].previousOutput);
    known.set(index, cell);
    if (cell?.cellOutput.lock.eq(payerLock)) {
      paidByKey = true;
      break;
    }
  }
  if (!paidByKey) return { ok: false, reason: "the signing key did not pay this transaction" };
  const to = ccc.Script.from(expect.to);
  const token = expect.token && ccc.Script.from(expect.token);
  // What a cell gives the recipient: its capacity, or with a token its units of that exact token
  // (a committed xUDT cell always holds the 16-byte amount).
  const value = (o: ccc.CellOutput, data: ccc.Hex): bigint =>
    !o.lock.eq(to) ? 0n : !token ? o.capacity : o.type?.eq(token) ? tokenAmount(data) : 0n;

  // The rest at once, reusing those already looked up.
  const inputs = await Promise.all(
    tx.inputs.map((input, i) => (known.has(i) ? known.get(i) : client.getCell(input.previousOutput))),
  );
  let payerInput = -1;
  let toIn = 0n;
  for (const [i, cell] of inputs.entries()) {
    if (!cell) return { ok: false, reason: "an input of the payment cannot be resolved" };
    if (payerInput < 0 && cell.cellOutput.lock.eq(payerLock)) payerInput = i;
    toIn += value(cell.cellOutput, cell.outputData);
  }
  if (payerInput < 0) return { ok: false, reason: "the signing key did not pay this transaction" };

  // One memo among the witnesses a signature covers. A memo in a witness nobody
  // signed (the session cell's, say) was not put there by the payer and cannot
  // void the payment; several signed ones could each claim it (audit, 30 Oct).
  const covered = signedWitnesses(
    tx,
    inputs.map((c) => c!.cellOutput.lock),
    (lock) => isSecp256k1Lock(lock, payerLock),
  );
  if (!soleMemo(tx, covered)) return { ok: false, reason: "a payment must carry exactly one memo" };

  // The witness the payer's lock verified (the first of its group) must carry the memo.
  const witness = tx.getWitnessArgsAt(payerInput);
  if (!witness?.inputType || ccc.hexFrom(witness.inputType) !== ccc.hexFrom(expect.memo)) {
    return { ok: false, reason: "the payment does not carry this memo" };
  }

  const toOut = tx.outputs.reduce((sum, o, i) => sum + value(o, tx.outputsData[i] ?? "0x"), 0n);
  const paid = toOut - toIn;
  if (paid < expect.minAmount) {
    const shown = token ? `${paid} units` : `${ccc.fixedPointToString(paid)} CKB`;
    return { ok: false, reason: `paid ${shown}, below the price` };
  }
  return { ok: true, paid };
}
