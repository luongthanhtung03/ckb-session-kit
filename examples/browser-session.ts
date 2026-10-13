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
 * - forget a session only after close has returned its key cell.
 */
import type { ccc } from "@ckb-ccc/core";
import {
  checkRequest,
  closeSession,
  createSession,
  indexedDbStore,
  isActive,
  openSession,
  SessionStoreConflict,
  spendInSession,
  TESTNET_DEPLOYMENT as deployment,
  type Session,
} from "ckb-session-kit";

const CKB = 100_000_000n;
const store = indexedDbStore(indexedDB, "my-app"); // one session per key: one per app page

/** On page load: the session this browser already holds, if it is still usable. */
export async function restore(): Promise<Session | undefined> {
  const session = await store.load();
  return session?.onchain && isActive(session) ? session : undefined;
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
    if (e instanceof SessionStoreConflict) throw new Error("a session is already open in another tab; reload");
    await store.clear(draft); // saved but never funded
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
