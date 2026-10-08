import { ccc } from "@ckb-ccc/core";

/**
 * Client side of the on-chain session lock (contracts/session-lock).
 *
 * Args layout, 80 or 112 bytes:
 * owner_lock_hash 32 | session_lock_hash 32 | max_per_tx u64 LE | min_interval u64 LE | [recipient_lock_hash 32]
 */
export interface SessionLockParams {
  /** Lock hash whose presence in a transaction's inputs grants owner mode. */
  ownerLockHash: ccc.HexLike;
  /** Lock hash of the session key's own lock (its key cell); grants session mode. */
  sessionLockHash: ccc.HexLike;
  /** Most shannons one session-mode transaction may move out, fees included. */
  maxPerTx: bigint;
  /** Blocks each session-locked input must have aged (relative since); 0 = no rate limit. */
  minInterval?: bigint;
  /** If set, the only lock session-mode spends may pay (besides change, key cell, owner). */
  recipientLockHash?: ccc.HexLike;
}

/** Where the session lock code lives on a network. */
export interface SessionLockDeployment {
  codeHash: ccc.HexLike;
  hashType: ccc.HashTypeLike;
  cellDep: { outPoint: { txHash: ccc.HexLike; index: ccc.NumLike }; depType: ccc.DepTypeLike };
}

/** Error codes returned by the session lock, for reading node rejections. */
export const SESSION_LOCK_ERRORS: Record<number, string> = {
  10: "bad args",
  11: "not authorised: neither owner nor session key present",
  12: "outflow exceeds max_per_tx",
  13: "recipient not allowed",
  14: "rate limited: input too young",
  15: "capacity overflow",
};

const U64_MAX = (1n << 64n) - 1n;

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > U64_MAX) throw new RangeError(`not a u64: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

function hash32(h: ccc.HexLike, name: string): Uint8Array {
  const b = ccc.bytesFrom(h);
  if (b.length !== 32) throw new RangeError(`${name} must be 32 bytes`);
  return b;
}

export function sessionLockArgs(p: SessionLockParams): ccc.Hex {
  return ccc.hexFrom(
    ccc.bytesConcat(
      hash32(p.ownerLockHash, "ownerLockHash"),
      hash32(p.sessionLockHash, "sessionLockHash"),
      u64le(p.maxPerTx),
      u64le(p.minInterval ?? 0n),
      ...(p.recipientLockHash === undefined ? [] : [hash32(p.recipientLockHash, "recipientLockHash")]),
    ),
  );
}

export function sessionLockScript(d: SessionLockDeployment, p: SessionLockParams): ccc.Script {
  return ccc.Script.from({ codeHash: d.codeHash, hashType: d.hashType, args: sessionLockArgs(p) });
}

export function sessionLockCellDep(d: SessionLockDeployment): ccc.CellDep {
  return ccc.CellDep.from(d.cellDep);
}

/** A relative `since` of `blocks` block numbers (RFC 0017), as the rate limit requires. */
export function relativeBlocksSince(blocks: bigint): bigint {
  if (blocks < 0n || blocks >= 1n << 56n) throw new RangeError(`blocks out of range: ${blocks}`);
  return (1n << 63n) | blocks;
}

/** Pulls a session-lock error code out of a node's rejection message, if there is one. */
export function sessionLockErrorFrom(message: string): { code: number; meaning: string } | undefined {
  const m = message.match(/error code (-?\d+)/i) ?? message.match(/ValidationFailure\D+(-?\d+)/);
  if (!m) return undefined;
  const code = Number(m[1]);
  return { code, meaning: SESSION_LOCK_ERRORS[code] ?? "unknown" };
}
