/**
 * The browser side, without a framework: what an app does around a wallet
 * connector. `wallet` is any CCC signer (JoyID, MetaMask, UniSat… through
 * @ckb-ccc/connector); everything else is this library.
 *
 * The rules that matter in a browser:
 * - save the session *before* the funding transaction is sent (beforeSend),
 *   or a failed save leaves funds under a key that exists nowhere;
 * - one stored session per slot: a second tab gets SessionStoreConflict
 *   instead of overwriting a key that may hold funds;
 * - forget a session only after close has returned its key cell;
 * - a new createSession for each opening: openSession refuses a session that
 *   was opened before (SessionPolicyError "session-already-open").
 */
import type { ccc } from "@ckb-ccc/core";
import {
  checkRequest,
  closeSession,
  createSession,
  indexedDbStore,
  isActive,
  openSession,
  SendOutcomeUnknownError,
  SessionStoreConflict,
  spendInSession,
  TESTNET_DEPLOYMENT as deployment,
  type Session,
} from "ckb-session-kit";

const CKB = 100_000_000n;
const store = indexedDbStore(indexedDB, "my-app"); // one session per key: one per app page

/**
 * On page load: the session this browser already holds, expired or not. An
 * expired one can no longer pay (`usable` is false), but it may still hold
 * funds, and only `end` (closeSession) with this key returns its key cell.
 */
export async function restore(): Promise<{ session: Session; usable: boolean } | undefined> {
  const session = await store.load();
  return session?.onchain ? { session, usable: isActive(session) } : undefined;
}

/** One wallet popup: the owner funds a session that may only pay `shop`. */
export async function start(wallet: ccc.Signer, shop: string): Promise<Session> {
  const draft = createSession({
    expiresAt: new Date(Date.now() + 30 * 60_000),
    scope: { maxPerTx: 5n * CKB, recipients: [shop] },
  });
  try {
    const { binding } = await openSession(wallet, draft, deployment, {
      budget: 200n * CKB,
      beforeSend: (b) => store.save({ ...draft, onchain: b }),
    });
    return { ...draft, onchain: binding };
  } catch (e) {
    if (e instanceof SessionStoreConflict) throw new Error("a session is already open in this browser (another tab?); reload");
    // The funding may still commit: keep the stored key. closeSession reports
    // nothingFound once the node does not know the funding, and then it can go.
    if (e instanceof SendOutcomeUnknownError) throw e;
    // Refused before the send, or the node did not take it: nothing was funded
    // (openSession returns normally when the node did take it).
    await store.clear(draft);
    throw e;
  }
}

/** No popup: the session key pays, inside the scope. */
export async function pay(session: Session, client: ccc.Client, shop: string, amount: bigint): Promise<ccc.Hex> {
  const check = checkRequest(session, { to: shop, amount }); // fails fast, before any network call
  if (!check.ok) throw new Error(check.reason);
  return spendInSession(session, client, deployment, session.onchain!, { to: shop, amount });
}

/** One wallet popup: everything back to the owner, then forget the key. */
export async function end(wallet: ccc.Signer, session: Session): Promise<void> {
  const { keyError } = await closeSession(wallet, session, deployment, session.onchain!);
  if (keyError) throw new Error(`balance swept, key cell kept for a retry: ${keyError}`);
  await store.clear(session);
}
