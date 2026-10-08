import type { ccc } from "@ckb-ccc/core";
import type { Session } from "./session.js";

/**
 * Where a session lives between page loads. The key never leaves the device:
 * the browser store writes to IndexedDB, which is per-origin and local.
 */
export interface SessionStore {
  load(): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  clear(): Promise<void>;
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
      },
    }),
  };
}

export function memoryStore(): SessionStore {
  let value: string | undefined;
  return {
    load: async () => (value === undefined ? undefined : deserializeSession(value)),
    save: async (s) => {
      value = serializeSession(s);
    },
    clear: async () => {
      value = undefined;
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

export function indexedDbStore(idb: IDBFactory = globalThis.indexedDB): SessionStore {
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const db = await open(idb);
    try {
      return await request(fn(db.transaction(STORE, mode).objectStore(STORE)));
    } finally {
      db.close();
    }
  };
  return {
    load: async () => {
      const raw = await run<string | undefined>("readonly", (s) => s.get(KEY));
      return raw === undefined ? undefined : deserializeSession(raw);
    },
    save: async (session) => {
      await run("readwrite", (s) => s.put(serializeSession(session), KEY));
    },
    clear: async () => {
      await run("readwrite", (s) => s.delete(KEY));
    },
  };
}
