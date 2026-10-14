/**
 * Server only: the access check behind the paid-content routes. A proof of the
 * wrong shape is the client's fault (400); a failure while asking the chain is
 * the server's, and passing (503, retry): the reader who paid must not be told
 * their proof is malformed because the RPC node timed out.
 */
import { ccc } from "@ckb-ccc/core";
import { verifyAccess, type AccessProof } from "ckb-session-kit";

/** A memo is a short label; anything longer is not one of ours. */
const MAX_MEMO_BYTES = 256;

const hexOf = (v: unknown, bytes: number) => typeof v === "string" && v.length === 2 + 2 * bytes && /^0x[0-9a-f]*$/i.test(v);

/** Shape only: a 32-byte tx hash, a memo, a 33-byte public key and a 65-byte signature, all hex. */
export function isAccessProof(p: unknown): p is AccessProof {
  if (typeof p !== "object" || p === null) return false;
  const { txHash, memo, publicKey, signature } = p as Record<string, unknown>;
  return (
    hexOf(txHash, 32) &&
    typeof memo === "string" &&
    memo.length <= 2 + 2 * MAX_MEMO_BYTES &&
    /^0x([0-9a-f]{2})*$/i.test(memo) &&
    hexOf(publicKey, 33) &&
    hexOf(signature, 65)
  );
}

export type Denied = { status: 400 | 402 | 503; body: { error: string; retry?: true } };

/**
 * undefined when `proof` shows a committed payment matching `expect`; otherwise
 * the answer to give. `expect` is built inside, so a failure resolving it (an
 * address, a known script) also counts as the chain being unreachable.
 */
export async function checkAccess(
  client: ccc.Client,
  proof: unknown,
  expect: () => Promise<Parameters<typeof verifyAccess>[2]>,
): Promise<Denied | undefined> {
  if (!isAccessProof(proof)) return { status: 400, body: { error: "malformed proof" } };
  try {
    const check = await verifyAccess(client, proof, await expect());
    return check.ok ? undefined : { status: 402, body: { error: check.reason } };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { status: 503, body: { error: `could not check the payment on-chain: ${why.slice(0, 160)}`, retry: true } };
  }
}
