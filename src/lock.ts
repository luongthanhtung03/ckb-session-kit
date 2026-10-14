import { ccc } from "@ckb-ccc/core";

/**
 * Client side of the on-chain session lock (contracts/session-lock).
 *
 * Args layout, 80 or 112 bytes:
 * owner_lock_hash 32 | session_lock_hash 32 | max_per_tx u64 LE | min_interval u64 LE | [recipient_lock_hash 32]
 *
 * A token session (128 or 160 bytes) puts the token before the recipient:
 * ... | min_interval | token_type_hash 32 | max_per_tx_token u128 LE | [recipient_lock_hash 32]
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
  /** A token session: the one xUDT type its cells may hold, and the most units one spend may move. */
  token?: { typeHash: ccc.HexLike; maxPerTx: bigint };
}

/** Where the session lock code lives on a network. */
export interface SessionLockDeployment {
  codeHash: ccc.HexLike;
  hashType: ccc.HashTypeLike;
  cellDep: { outPoint: { txHash: ccc.HexLike; index: ccc.NumLike }; depType: ccc.DepTypeLike };
}

/**
 * The session lock deployed on CKB public testnet. Kept identical to
 * deployment/testnet.json by a test.
 */
export const TESTNET_DEPLOYMENT: SessionLockDeployment = {
  codeHash: "0xab419466529ea479590d4be7b23580ce2ddc640ba902735c9ad9a22dc64c08ce",
  hashType: "data2",
  cellDep: {
    outPoint: { txHash: "0xf3098bdb9a7bb1c500990be0f1159b7e66f507fef6b7a4f904046024284877f2", index: "0x0" },
    depType: "code",
  },
};

/**
 * Earlier testnet deployments, newest first. Their code is immutable, so sessions
 * opened under them keep their old rules; pass these to `recoverSessions` too so
 * those sessions can still be swept. 13 Oct 2026: before token sessions (errors
 * 19, 20) and untyped-only payments. 8 Oct 2026: before errors 16, 17 and 18.
 */
export const TESTNET_LEGACY_DEPLOYMENTS: SessionLockDeployment[] = [
  {
    codeHash: "0x1cb7724269e2e86359b5b47cad6b1860ccd6da254c25c651056c8431d11590cd",
    hashType: "data2",
    cellDep: {
      outPoint: { txHash: "0x37cfe04f64fd4dbec3803a972a51b7080f9ca1a3042535e97b7a756d0e03b071", index: "0x0" },
      depType: "code",
    },
  },
  {
    codeHash: "0x1ae8b8f71ed1846e2823ecccd8c3f80527be2895689f5dae54a53bd42526bc20",
    hashType: "data2",
    cellDep: {
      outPoint: { txHash: "0xab2e69b8b97c15bddeb80954edd6d33befcd2fe9e4243377a46f14a3e1c343d2", index: "0x0" },
      depType: "code",
    },
  },
];

/** Error codes returned by the session lock, for reading node rejections. */
export const SESSION_LOCK_ERRORS: Record<number, string> = {
  10: "bad args",
  11: "not authorised: neither owner nor session key present",
  12: "outflow exceeds max_per_tx",
  13: "recipient not allowed",
  14: "rate limited: input too young",
  15: "overflow (capacity or token amounts)",
  16: "too many change cells: a session spend may not split the session cell",
  17: "the key cell may not grow in a session spend",
  18: "session cells and their change may not carry a type script (in a token session: none but the token)",
  19: "malformed token data: under 16 bytes, or token change not exactly 16",
  20: "token outflow exceeds max_per_tx_token",
};

const U64_MAX = (1n << 64n) - 1n;

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v > U64_MAX) throw new RangeError(`not a u64: ${v}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

const U128_MAX = (1n << 128n) - 1n;

function u128le(v: bigint): Uint8Array {
  if (v < 0n || v > U128_MAX) throw new RangeError(`not a u128: ${v}`);
  return ccc.numLeToBytes(v, 16);
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
      ...(p.token === undefined ? [] : [hash32(p.token.typeHash, "token.typeHash"), u128le(p.token.maxPerTx)]),
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

/**
 * Pulls a session-lock error code out of a node's rejection message, if there is
 * one. The session lock only ever runs as an input's lock: a code from a type
 * script (xUDT on a token payment, say) is not one, and gives undefined. An
 * input lock can still be another lock in the same transaction (the recipient's
 * anyone-can-pay cell on a top-up); pass `sessionInputs`, the indexes of the
 * session cells, to rule that out too.
 */
export function sessionLockErrorFrom(
  message: string,
  sessionInputs?: number[],
): { code: number; meaning: string } | undefined {
  const m = message.match(/error code (-?\d+)/i) ?? message.match(/ValidationFailure\D+(-?\d+)/);
  if (!m) return undefined;
  const source = message.match(/source: (Inputs|Outputs)\[(\d+)\]\.(Lock|Type)/);
  if (source && (source[1] !== "Inputs" || source[3] !== "Lock")) return undefined;
  if (source && sessionInputs && !sessionInputs.includes(Number(source[2]))) return undefined;
  const code = Number(m[1]);
  return { code, meaning: SESSION_LOCK_ERRORS[code] ?? "unknown" };
}
