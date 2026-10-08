"use client";

import { ccc } from "@ckb-ccc/core";
import {
  createSession,
  indexedDbStore,
  isActive,
  ScopeError,
  sendInScope,
  sessionAddress,
  type Session,
} from "ckb-session-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Prompt, Terminal } from "./Terminal";

const store = indexedDbStore();
const explorerTx = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
const explorerAddr = (a: string) => `https://testnet.explorer.nervos.org/address/${a}`;
const ckb = (shannons: bigint) => ccc.fixedPointToString(shannons) + " CKB";
const short = (h: string, n = 8) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);

type LogEntry = { at: Date; level: "ok" | "err" | "info"; text: string; hash?: string };

export default function SessionDemo() {
  const client = useMemo(() => new ccc.ClientPublicTestnet(), []);
  const [session, setSession] = useState<Session>();
  const [address, setAddress] = useState<string>();
  const [balance, setBalance] = useState<bigint>();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());

  const push = (e: Omit<LogEntry, "at">) => setLog((l) => [{ at: new Date(), ...e }, ...l]);
  const restored = useRef(false);

  useEffect(() => {
    store
      .load()
      .then((s) => {
        setSession(s);
        if (s && !restored.current) {
          restored.current = true;
          push({ level: "info", text: "restored session from IndexedDB" });
        }
      })
      .finally(() => setLoading(false));
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!session) return;
    const signer = new ccc.SignerCkbPrivateKey(client, session.privateKey);
    setBalance(await signer.getBalance());
  }, [client, session]);

  useEffect(() => {
    if (!session) return setAddress(undefined);
    sessionAddress(session, client).then(setAddress);
    refreshBalance();
  }, [client, session, refreshBalance]);

  return (
    <main className="wrap">
      <Terminal client={client} title="ckb-session-kit — demo">
        <h1>
          <span className="dim">[</span> ckb-session-kit <span className="dim">v0.1 ]</span>{" "}
          <span className="dim">:: self-custody sessions :: testnet</span>
        </h1>
        <p className="lede">
          A session key generated and held in this browser. It may only sign within the scope you
          set, so an app can act repeatedly without a wallet popup each time.
        </p>
        <p className="note">
          # v0.1 — scope enforced client-side. Next milestone: an on-chain session lock that makes
          it binding. · <a href="https://github.com/luongthanhtung03/ckb-session-kit">source</a>
        </p>

        {loading ? (
          <div className="block">
            <span className="cursor" />
          </div>
        ) : !session ? (
          <CreateForm
            onCreate={async (s) => {
              await store.save(s);
              setSession(s);
              push({ level: "ok", text: "session created · key written to IndexedDB, never sent anywhere" });
            }}
          />
        ) : (
          <>
            <section className="block">
              <h2>session</h2>
              <Prompt path="~/session">session status</Prompt>
              <dl>
                <dt>state</dt>
                <dd>
                  {isActive(session, now) ? (
                    <span className="ok">● active · expires in {remaining(session, now)}</span>
                  ) : (
                    <span className="bad">○ expired</span>
                  )}
                </dd>
                <dt>pubkey</dt>
                <dd>{short(session.publicKey)}</dd>
                <dt>address</dt>
                <dd>{address ? <a href={explorerAddr(address)}>{address}</a> : "…"}</dd>
                <dt>balance</dt>
                <dd>
                  <span className="ok">{balance === undefined ? "…" : ckb(balance)}</span>{" "}
                  <button className="link" onClick={refreshBalance}>
                    refresh
                  </button>
                </dd>
                <dt>max/tx</dt>
                <dd className="warn">{ckb(session.policy.scope.maxPerTx)}</dd>
                <dt>allow</dt>
                <dd>{session.policy.scope.recipients?.join(", ") ?? "* (any recipient)"}</dd>
              </dl>
              <p className="hint">
                # fund the address from the{" "}
                <a href="https://faucet.nervos.org/" target="_blank" rel="noreferrer">
                  testnet faucet
                </a>
                , then refresh. Claims take a minute or two.
              </p>
            </section>

            <SendForm
              session={session}
              onSend={async (to, amount) => {
                try {
                  const hash = await sendInScope(session, client, { to, amount });
                  push({ level: "ok", text: `sent ${ckb(amount)} · signed by session key, no wallet popup`, hash });
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  push({ level: "err", text: e instanceof ScopeError ? msg : `send failed: ${msg}` });
                }
                refreshBalance();
              }}
            />

            <section className="block">
              <Prompt path="~/session">session end</Prompt>
              <button
                className="danger"
                onClick={async () => {
                  if (!window.confirm("End the session? Any CKB left at the session address stays there.")) return;
                  await store.clear();
                  setSession(undefined);
                  setBalance(undefined);
                  push({ level: "info", text: "session ended · key deleted from this browser" });
                }}
              >
                end session
              </button>
            </section>
          </>
        )}

        <section className="block">
          <h2>log</h2>
          <ul className="log">
            {log.map((e, i) => (
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
      </Terminal>
      <footer>
        <span>MIT · built during CKBuilder</span>
        <a href="https://github.com/luongthanhtung03/ckb-session-kit">github.com/luongthanhtung03/ckb-session-kit</a>
      </footer>
    </main>
  );
}

function remaining(s: Session, now: Date): string {
  const ms = Math.max(0, s.policy.expiresAt.getTime() - now.getTime());
  const m = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${m}m${sec.toString().padStart(2, "0")}s`;
}

function CreateForm({ onCreate }: { onCreate: (s: Session) => Promise<void> }) {
  const [minutes, setMinutes] = useState("60");
  const [max, setMax] = useState("100");
  const [recipient, setRecipient] = useState("");
  const [error, setError] = useState<string>();

  return (
    <form
      className="block"
      onSubmit={async (ev) => {
        ev.preventDefault();
        setError(undefined);
        try {
          const s = createSession({
            expiresAt: new Date(Date.now() + Number(minutes) * 60_000),
            scope: {
              maxPerTx: ccc.fixedPointFrom(max),
              ...(recipient.trim() && { recipients: [recipient.trim()] }),
            },
          });
          await onCreate(s);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}
    >
      <h2>create session</h2>
      <Prompt path="~">
        session create --expires {minutes || "?"}m --max {max || "?"}CKB
        {recipient.trim() && ` --allow ${short(recipient.trim())}`}
      </Prompt>
      <label>
        --expires (minutes)
        <div className="field">
          <input type="number" min="1" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </div>
      </label>
      <label>
        --max (CKB per transaction)
        <div className="field">
          <input type="number" min="61" step="any" value={max} onChange={(e) => setMax(e.target.value)} />
        </div>
      </label>
      <label>
        --allow (only this recipient, optional)
        <div className="field">
          <input placeholder="ckt1…" value={recipient} onChange={(e) => setRecipient(e.target.value)} spellCheck={false} />
        </div>
      </label>
      {error && <p className="bad">error: {error}</p>}
      <button type="submit">run ⏎</button>
    </form>
  );
}

function SendForm({ session, onSend }: { session: Session; onSend: (to: string, amount: bigint) => Promise<void> }) {
  const [to, setTo] = useState(session.policy.scope.recipients?.[0] ?? "");
  const [amount, setAmount] = useState("61");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="block"
      onSubmit={async (ev) => {
        ev.preventDefault();
        setBusy(true);
        try {
          await onSend(to.trim(), ccc.fixedPointFrom(amount));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>send</h2>
      <Prompt path="~/session">
        session send --to {to.trim() ? short(to.trim()) : "?"} --amount {amount || "?"}CKB
      </Prompt>
      <p className="hint"># no wallet popup. try more than the limit to watch the session refuse. min output: 61 CKB.</p>
      <label>
        --to
        <div className="field">
          <input placeholder="ckt1…" value={to} onChange={(e) => setTo(e.target.value)} required spellCheck={false} />
        </div>
      </label>
      <label>
        --amount (CKB)
        <div className="field">
          <input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "signing…" : "run ⏎"}
      </button>
    </form>
  );
}
