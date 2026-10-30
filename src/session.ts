import { ccc } from "@ckb-ccc/core";

/**
 * What a session key may do. This is the off-chain mirror of what the session
 * lock script will enforce on-chain (Week 4): the browser refuses out-of-scope
 * requests early, and the chain refuses them regardless.
 */
export interface SessionScope {
  /** Largest amount one transaction may move, in shannons. */
  maxPerTx: bigint;
  /** Recipient addresses allowed. Omitted means any recipient. */
  recipients?: string[];
}

export interface SessionPolicy {
  expiresAt: Date;
  scope: SessionScope;
}

export interface Session {
  /** Never leaves the browser. */
  privateKey: ccc.Hex;
  publicKey: ccc.Hex;
  policy: SessionPolicy;
  /** Set once the owner has funded the session under the on-chain session lock. */
  onchain?: {
    ownerLock: { codeHash: ccc.Hex; hashType: ccc.HashType; args: ccc.Hex };
    minInterval: bigint;
    recipientLockHash?: ccc.Hex;
    /** A token session: the xUDT type its cells hold, and the most units one spend may move. */
    token?: { type: { codeHash: ccc.Hex; hashType: ccc.HashType; args: ccc.Hex }; maxPerTx: bigint };
    /** The funding transaction, so a key is not forgotten while its funds are still on the way. */
    openTx?: ccc.Hex;
  };
}

export interface CreateOptions {
  now?: Date;
  /** Injectable for tests; defaults to the platform CSPRNG. */
  randomBytes?: (n: number) => Uint8Array;
}

/**
 * Why a policy error is not about the request itself: "payto-not-anyone-can-pay",
 * the payer's own setup (a charge can never top such a `payTo` up); or
 * "too-many-cells", more cells under a subscription's lock than a status or a
 * charge reads (`MAX_SUBSCRIPTION_CELLS`).
 */
export type SessionPolicyReason = "payto-not-anyone-can-pay" | "too-many-cells";

export class SessionPolicyError extends Error {
  readonly reason?: SessionPolicyReason;
  constructor(message: string, reason?: SessionPolicyReason) {
    super(message);
    this.name = "SessionPolicyError";
    if (reason) this.reason = reason;
  }
}

const SECP256K1_N = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);

export function createSession(policy: SessionPolicy, options: CreateOptions = {}): Session {
  const now = options.now ?? new Date();
  if (!Number.isFinite(policy.expiresAt.getTime())) {
    throw new SessionPolicyError("expiresAt is not a valid date");
  }
  if (policy.expiresAt.getTime() <= now.getTime()) {
    throw new SessionPolicyError("expiresAt must be in the future");
  }
  if (policy.scope.maxPerTx <= 0n) {
    throw new SessionPolicyError("scope.maxPerTx must be positive");
  }
  if (policy.scope.recipients?.length === 0) {
    throw new SessionPolicyError("scope.recipients must be omitted or non-empty");
  }

  const random = options.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  let privateKey: ccc.Hex;
  // Rejection-sample until the key is a valid secp256k1 scalar (1..n-1).
  for (;;) {
    const candidate = ccc.hexFrom(random(32));
    const k = BigInt(candidate);
    if (k > 0n && k < SECP256K1_N) {
      privateKey = candidate;
      break;
    }
  }

  // The signer only derives the public key here; no network call is made.
  const signer = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet(), privateKey);
  return { privateKey, publicKey: signer.publicKey, policy };
}

export function isActive(session: Session, now: Date = new Date()): boolean {
  return now.getTime() < session.policy.expiresAt.getTime();
}

export type ScopeCheck = { ok: true } | { ok: false; reason: string };

export function checkRequest(
  session: Session,
  request: { to: string; amount: bigint },
  now: Date = new Date(),
): ScopeCheck {
  if (!isActive(session, now)) return { ok: false, reason: "session expired" };
  const { scope } = session.policy;
  if (request.amount <= 0n) return { ok: false, reason: "amount must be positive" };
  if (request.amount > scope.maxPerTx) {
    return { ok: false, reason: `amount exceeds maxPerTx (${ccc.fixedPointToString(scope.maxPerTx)} CKB)` };
  }
  if (scope.recipients && !scope.recipients.includes(request.to)) {
    return { ok: false, reason: "recipient not in scope" };
  }
  return { ok: true };
}
