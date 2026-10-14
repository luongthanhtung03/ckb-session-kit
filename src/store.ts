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
   * session: its key may hold funds, and another tab may have just saved it.
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

/** The stored value's public key, without parsing the rest. */
const storedKey = (raw: string | undefined) => (raw === undefined ? undefined : (JSON.parse(raw) as StoredSession).publicKey);

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
      },
    }),
  };
  return JSON.stringify(stored);
}

export function deserializeSession(json: string): Session {
  const d = JSON.parse(json) as StoredSession;
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
      },
    }),
  };
}

export function memoryStore(): SessionStore {
  let value: string | undefined;
  return {
    load: async () => (value === undefined ? undefined : deserializeSession(value)),
    save: async (s) => {
      const held = storedKey(value);
      if (held !== undefined && held !== s.publicKey) throw new SessionStoreConflict();
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
  const update = async (decide: (raw: string | undefined) => "put" | "delete" | "keep", value?: string) => {
    const db = await open(idb);
    try {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE);
      const raw = await request<string | undefined>(store.get(key));
      const action = decide(raw);
      if (action === "put") await request(store.put(value, key));
      if (action === "delete") await request(store.delete(key));
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
        const held = storedKey(raw);
        if (held !== undefined && held !== session.publicKey) throw new SessionStoreConflict();
        return "put";
      }, value);
    },
    clear: async (session) => {
      await update((raw) => (storedKey(raw) === session.publicKey ? "delete" : "keep"));
    },
  };
}
