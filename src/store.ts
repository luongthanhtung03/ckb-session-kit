import type { ccc } from "@ckb-ccc/core";
import type { Session } from "./session.js";

/**
 * Where a session lives between page loads. The key never leaves the device:
 * the browser store writes to IndexedDB, which is per-origin and local.
 */
export interface SessionStore {
  load(): Promise<Session | undefined>;
  /**
   * Stores `session`. Refuses (SessionStoreConflict) to replace a *different*
   * session: its key may hold funds, and another tab may have just saved it. Also
   * refuses to replace the same session's on-chain binding with none.
   */
  save(session: Session): Promise<void>;
  /** Forgets `session`, only if it is still the stored one; another tab may have replaced it. */
  clear(session: Session): Promise<void>;
}

export class SessionStoreConflict extends Error {
  constructor() {
    super("another session is already stored here (opened in another tab?); reload the page");
    this.name = "SessionStoreConflict";
  }
}

const UNREADABLE = "the stored session is unreadable; it may still hold a funded key, so it is never overwritten";

/** The stored value's public key, without parsing the rest. */
function storedKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let key: unknown;
  try {
    key = (JSON.parse(raw) as StoredSession).publicKey;
  } catch {
    throw new Error(UNREADABLE);
  }
  if (typeof key !== "string") throw new Error(UNREADABLE);
  return key;
}

/**
 * Throws SessionStoreConflict unless `session` may replace the stored value: a
 * different key may hold funds, and a save of the same key without the on-chain
 * binding (a stale tab that never saw the funding) would lose what finds them
 * (review, 28 Oct).
 */
function assertReplaceable(raw: string | undefined, session: Session): void {
  const held = storedKey(raw);
  if (held === undefined) return;
  if (held !== session.publicKey) throw new SessionStoreConflict();
  if (!session.onchain && (JSON.parse(raw!) as StoredSession).onchain) throw new SessionStoreConflict();
}

/** JSON-safe form: bigints as decimal strings, dates as ISO strings. */
interface StoredSession {
  v: 1;
  privateKey: string;
  publicKey: string;
  expiresAt: string;
  maxPerTx: string;
  recipients?: string[];
  onchain?: {
    ownerLock: { codeHash: string; hashType: string; args: string };
    minInterval: string;
    recipientLockHash?: string;
    token?: { type: { codeHash: string; hashType: string; args: string }; maxPerTx: string };
    openTx?: string;
  };
}

export function serializeSession(s: Session): string {
  const stored: StoredSession = {
    v: 1,
    privateKey: s.privateKey,
    publicKey: s.publicKey,
    expiresAt: s.policy.expiresAt.toISOString(),
    maxPerTx: s.policy.scope.maxPerTx.toString(),
    ...(s.policy.scope.recipients && { recipients: s.policy.scope.recipients }),
    ...(s.onchain && {
      onchain: {
        ownerLock: s.onchain.ownerLock,
        minInterval: s.onchain.minInterval.toString(),
        ...(s.onchain.recipientLockHash && { recipientLockHash: s.onchain.recipientLockHash }),
        ...(s.onchain.token && {
          token: { type: s.onchain.token.type, maxPerTx: s.onchain.token.maxPerTx.toString() },
        }),
        ...(s.onchain.openTx && { openTx: s.onchain.openTx }),
      },
    }),
  };
  return JSON.stringify(stored);
}

export function deserializeSession(json: string): Session {
  let d: StoredSession;
  try {
    d = JSON.parse(json) as StoredSession;
  } catch {
    throw new Error(UNREADABLE);
  }
  if (d.v !== 1) throw new Error(`unsupported stored session version: ${String(d.v)}`);
  return {
    privateKey: d.privateKey as ccc.Hex,
    publicKey: d.publicKey as ccc.Hex,
    policy: {
      expiresAt: new Date(d.expiresAt),
      scope: {
        maxPerTx: BigInt(d.maxPerTx),
        ...(d.recipients && { recipients: d.recipients }),
      },
    },
    ...(d.onchain && {
      onchain: {
        ownerLock: {
          codeHash: d.onchain.ownerLock.codeHash as ccc.Hex,
          hashType: d.onchain.ownerLock.hashType as ccc.HashType,
          args: d.onchain.ownerLock.args as ccc.Hex,
        },
        minInterval: BigInt(d.onchain.minInterval),
        ...(d.onchain.recipientLockHash && { recipientLockHash: d.onchain.recipientLockHash as ccc.Hex }),
        ...(d.onchain.token && {
          token: {
            type: {
              codeHash: d.onchain.token.type.codeHash as ccc.Hex,
              hashType: d.onchain.token.type.hashType as ccc.HashType,
              args: d.onchain.token.type.args as ccc.Hex,
            },
            maxPerTx: BigInt(d.onchain.token.maxPerTx),
          },
        }),
        ...(d.onchain.openTx && { openTx: d.onchain.openTx as ccc.Hex }),
      },
    }),
  };
}

export function memoryStore(): SessionStore {
  let value: string | undefined;
  return {
    load: async () => (value === undefined ? undefined : deserializeSession(value)),
    save: async (s) => {
      assertReplaceable(value, s);
      value = serializeSession(s);
    },
    clear: async (s) => {
      if (storedKey(value) === s.publicKey) value = undefined;
    },
  };
}

const DB = "ckb-session-kit";
const STORE = "sessions";
const KEY = "current";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function open(idb: IDBFactory): Promise<IDBDatabase> {
  const r = idb.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  return request(r);
}

/**
 * One session per `key`. Pages on the same origin that each run their own
 * session (a wallet page and a reader page, say) pass different keys.
 */
export function indexedDbStore(idb: IDBFactory = globalThis.indexedDB, key: string = KEY): SessionStore {
  // Read and write in one readwrite transaction, so two tabs cannot interleave.
  // It resolves only once the transaction has committed, durably: a save is what
  // makes it safe to send funds to the key.
  const update = async (decide: (raw: string | undefined) => "put" | "delete" | "keep", value?: string) => {
    const db = await open(idb);
    try {
      const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
      const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error("session store transaction aborted"));
        tx.onerror = () => reject(tx.error ?? new Error("session store transaction failed"));
      });
      done.catch(() => {}); // awaited below; a decide() error aborts it first
      const store = tx.objectStore(STORE);
      const raw = await request<string | undefined>(store.get(key));
      let action: "put" | "delete" | "keep";
      try {
        action = decide(raw);
      } catch (e) {
        tx.abort();
        throw e;
      }
      if (action === "put") await request(store.put(value, key));
      if (action === "delete") await request(store.delete(key));
      await done;
    } finally {
      db.close();
    }
  };
  return {
    load: async () => {
      const db = await open(idb);
      try {
        const raw = await request<string | undefined>(db.transaction(STORE, "readonly").objectStore(STORE).get(key));
        return raw === undefined ? undefined : deserializeSession(raw);
      } finally {
        db.close();
      }
    },
    save: async (session) => {
      const value = serializeSession(session);
      await update((raw) => {
        assertReplaceable(raw, session);
        return "put";
      }, value);
    },
    clear: async (session) => {
      await update((raw) => (storedKey(raw) === session.publicKey ? "delete" : "keep"));
    },
  };
}
