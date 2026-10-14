"use client";

import { ccc } from "@ckb-ccc/connector-react";
import {
  ScopeError,
  SessionBalanceError,
  sessionLockErrorFrom,
  type OnChainBinding,
  type Session,
  type SessionStore,
} from "ckb-session-kit";

export const explorerTx = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
export const explorerAddr = (a: string) => `https://testnet.explorer.nervos.org/address/${a}`;
export const ckb = (shannons: bigint) => ccc.fixedPointToString(shannons) + " CKB";
export const short = (h: string, n = 8) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);

export type LogEntry = { at: Date; level: "ok" | "err" | "info"; text: string; hash?: string };

/** Turns anything thrown during a send into one honest log line. */
export function describeFailure(e: unknown): { level: "err"; text: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof ScopeError) return { level: "err", text: `${msg} · refused in the browser, nothing signed` };
  if (e instanceof SessionBalanceError) return { level: "err", text: msg };
  const onChain = sessionLockErrorFrom(msg);
  if (onChain) return { level: "err", text: `rejected by the network: session lock error ${onChain.code} (${onChain.meaning})` };
  if (/Immature/i.test(msg)) return { level: "err", text: "cooldown: the session cell is younger than the rate limit allows; try again in a few blocks" };
  return { level: "err", text: `failed: ${msg.slice(0, 200)}` };
}

/**
 * After a send failed: true only when the node is known never to have taken
 * `hash` (it has no record of it, or rejected it). An RPC error proves nothing,
 * so it gives false: whatever was recorded for the transaction is kept.
 */
export async function neverSent(client: ccc.Client, hash: string): Promise<boolean> {
  try {
    const res = await client.getTransaction(hash);
    return !res || res.status === "rejected" || res.status === "unknown";
  } catch {
    return false;
  }
}

/** How long a payment the node does not know may stay unknown before it counts as dropped. */
export const DROP_AFTER_MS = 10 * 60_000;

/**
 * Where a payment stands. "dropped": the node rejected it, or has not known it
 * for DROP_AFTER_MS since `since` (evicted, or replaced by a conflicting spend);
 * it will never commit. "waiting": on its way, or the node cannot be reached.
 * ("sent" is the CCC client's own record of a transaction it sent that the node
 * no longer reports, so it counts as unknown.)
 */
export async function paymentState(
  client: ccc.Client,
  hash: string,
  since: number,
): Promise<"committed" | "waiting" | "dropped"> {
  let status: string | undefined;
  try {
    status = (await client.getTransaction(hash))?.status;
  } catch {
    return "waiting"; // RPC hiccup: ask again
  }
  if (status === "committed") return "committed";
  if (status === "rejected") return "dropped";
  if (status === "pending" || status === "proposed") return "waiting";
  return Date.now() - since > DROP_AFTER_MS ? "dropped" : "waiting";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The server's answers that can still change: the payment is not committed (or not seen) yet. */
const NOT_YET = /payment is (pending|proposed)|payment not found/i;

/**
 * POSTs a claim for paid content. While the answer can still change (the server
 * could not reach the chain and said 503, the fetch failed, or the payment is
 * not committed yet) it retries with backoff: 3 s, doubling to a minute.
 * `keepGoing` runs before each retry; false stops it (the page moved on, or the
 * payment was dropped) and the result is undefined. `onWait` hears why it waits,
 * once per reason.
 */
export async function claimWithRetry<T>(
  url: string,
  body: string,
  keepGoing: () => Promise<boolean>,
  onWait: (why: string) => void,
): Promise<{ ok: true; data: T } | { ok: false; error: string } | undefined> {
  const told = new Set<string>();
  for (let delay = 3000; ; delay = Math.min(delay * 2, 60_000)) {
    let why: string;
    try {
      const res = await fetch(url, { method: "POST", body });
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (res.ok) return { ok: true, data: data as T };
      const error = String(data?.error ?? `HTTP ${res.status}`);
      if (res.status === 503 || data?.retry) why = `the server cannot reach the chain (${error})`;
      else if (res.status === 402 && NOT_YET.test(error)) why = `the server does not see the payment committed yet (${error})`;
      else return { ok: false, error };
    } catch {
      why = "the server cannot be reached";
    }
    if (!told.has(why)) {
      told.add(why);
      onWait(`${why}; retrying`);
    }
    await sleep(delay);
    if (!(await keepGoing())) return undefined;
  }
}

/** Said when an open failed but its funding transaction may still have reached the node. */
export const FUNDING_UNSURE =
  "the funding transaction may still have gone out, so the key is kept; close the session once it settles";

/**
 * Opens a session with its key saved before the funds are sent (`open` passes
 * `beforeSend` to openSession). If opening then fails, the key is forgotten only
 * when nothing was signed, or the node is known never to have taken the funding
 * transaction. Otherwise funds may still land under the key: the session comes
 * back with the error, and the page keeps it until close finds out.
 */
export async function openKept(
  client: ccc.Client,
  store: SessionStore,
  draft: Session,
  open: (beforeSend: (b: OnChainBinding) => Promise<void>) => Promise<{ txHash: ccc.Hex; binding: OnChainBinding }>,
): Promise<{ session: Session; txHash: string; error?: unknown }> {
  let saved = undefined as OnChainBinding | undefined; // set in a callback: not narrowed
  try {
    const { txHash, binding } = await open(async (b) => {
      await store.save({ ...draft, onchain: b });
      saved = b;
    });
    return { session: { ...draft, onchain: binding }, txHash };
  } catch (e) {
    if (!saved) throw e; // nothing was signed
    const openTx = saved.openTx;
    if (!openTx || (await neverSent(client, openTx))) {
      if (openTx) await store.clear(draft); // never funded
      throw e;
    }
    return { session: { ...draft, onchain: saved }, txHash: openTx, error: e };
  }
}

/** What a close did, as log lines, and whether the session's key can now be forgotten. */
export function describeClose(
  r: { keyTx?: string; sweepTx?: string; keyError?: string; nothingFound?: true },
  swept: string,
): { forget: boolean; lines: Omit<LogEntry, "at">[] } {
  const lines: Omit<LogEntry, "at">[] = [];
  if (r.sweepTx) lines.push({ level: "ok", text: swept, hash: r.sweepTx });
  if (r.keyTx) lines.push({ level: "ok", text: "key cell returned to you", hash: r.keyTx });
  if (r.keyError) {
    // Keep the key: the key cell is still under it.
    lines.push({
      level: "err",
      text: r.sweepTx
        ? `the balance is back with you, but the key cell (fees) could not be returned: ${r.keyError}. ` +
          "The key stays in this browser; close again to retry."
        : `the key cell (fees) could not be returned: ${r.keyError}. The key stays in this browser; close again to retry.`,
    });
    return { forget: false, lines };
  }
  if (r.nothingFound) {
    lines.push({ level: "info", text: "nothing is left under this session; its key is forgotten" });
    return { forget: true, lines };
  }
  if (!r.keyTx) {
    // Swept, but no key cell was found: it may still be on its way. Keep the key.
    lines.push({ level: "info", text: "the key cell was not found yet; the key stays in this browser, close again in a minute" });
    return { forget: false, lines };
  }
  return { forget: true, lines };
}

export function Log({ entries }: { entries: LogEntry[] }) {
  return (
    <section className="block">
      <h2>log</h2>
      <ul className="log">
        {entries.map((e, i) => (
          <li key={i}>
            <time>[{e.at.toLocaleTimeString("en-GB")}]</time>{" "}
            <span className={`lvl ${e.level === "ok" ? "ok" : e.level === "err" ? "bad" : "warn"}`}>
              {e.level === "ok" ? "OK" : e.level === "err" ? "DENY" : "INFO"}
            </span>{" "}
            {e.text}
            {e.hash && (
              <>
                {" "}
                · tx <a href={explorerTx(e.hash)}>{short(e.hash)}</a>
              </>
            )}
          </li>
        ))}
        <li>
          <span className="cursor" />
        </li>
      </ul>
    </section>
  );
}

/** The pages of the demo. */
export function Nav({ here }: { here: "wallet" | "read" | "tokens" | "place" | "listen" }) {
  return (
    <nav className="tabs">
      {here === "wallet" ? <span className="on">./session</span> : <a href="/">./session</a>}
      {here === "read" ? <span className="on">./pay-per-read</span> : <a href="/read">./pay-per-read</a>}
      {here === "tokens" ? <span className="on">./tokens</span> : <a href="/tokens">./tokens</a>}
      {here === "place" ? <span className="on">./place</span> : <a href="/place">./place</a>}
      {here === "listen" ? <span className="on">./pay-per-minute</span> : <a href="/listen">./pay-per-minute</a>}
    </nav>
  );
}

export function Footer() {
  return (
    <footer>
      <span>MIT · built during CKBuilder</span>
      <a href="https://github.com/luongthanhtung03/ckb-session-kit">github.com/luongthanhtung03/ckb-session-kit</a>
    </footer>
  );
}
