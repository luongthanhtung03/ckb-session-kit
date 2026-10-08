"use client";

import { ccc } from "@ckb-ccc/connector-react";
import { ScopeError, SessionBalanceError, sessionLockErrorFrom } from "ckb-session-kit";

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

/** The two pages of the demo. */
export function Nav({ here }: { here: "wallet" | "read" }) {
  return (
    <nav className="tabs">
      {here === "wallet" ? <span className="on">./session</span> : <a href="/">./session</a>}
      {here === "read" ? <span className="on">./pay-per-read</span> : <a href="/read">./pay-per-read</a>}
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
