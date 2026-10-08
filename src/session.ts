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
  /** Never leaves the browser. Persistence comes in a later milestone. */
  privateKey: ccc.Hex;
  publicKey: ccc.Hex;
  policy: SessionPolicy;
}

export interface CreateOptions {
  now?: Date;
  /** Injectable for tests; defaults to the platform CSPRNG. */
  randomBytes?: (n: number) => Uint8Array;
}

export class SessionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionPolicyError";
  }
}

const SECP256K1_N = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);

export function createSession(policy: SessionPolicy, options: CreateOptions = {}): Session {
  const now = options.now ?? new Date();
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
    return { ok: false, reason: `amount exceeds maxPerTx (${scope.maxPerTx})` };
  }
  if (scope.recipients && !scope.recipients.includes(request.to)) {
    return { ok: false, reason: "recipient not in scope" };
  }
  return { ok: true };
}
