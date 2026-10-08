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
import { useCallback, useEffect, useMemo, useState } from "react";

const store = indexedDbStore();
const explorerTx = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
const explorerAddr = (a: string) => `https://testnet.explorer.nervos.org/address/${a}`;
const ckb = (shannons: bigint) => ccc.fixedPointToString(shannons) + " CKB";

type LogEntry = { at: Date; ok: boolean; text: string; hash?: string };

export default function SessionDemo() {
  const client = useMemo(() => new ccc.ClientPublicTestnet(), []);
  const [session, setSession] = useState<Session>();
  const [address, setAddress] = useState<string>();
  const [balance, setBalance] = useState<bigint>();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());

  const push = (e: Omit<LogEntry, "at">) => setLog((l) => [{ at: new Date(), ...e }, ...l]);

  useEffect(() => {
    store
      .load()
      .then(setSession)
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

  if (loading) return <main className="wrap">Loading…</main>;

  return (
    <main className="wrap">
      <header>
        <h1>CKB Session Kit</h1>
        <p className="lede">
          A session key created and held in this browser, allowed to sign only within a scope
          you set — so an app can act repeatedly without a wallet dialog each time.
          Live on CKB <strong>testnet</strong>.
        </p>
        <p className="note">
          v0.1: the scope is enforced here in the browser. The on-chain session lock that makes
          it binding is the next milestone.{" "}
          <a href="https://github.com/luongthanhtung03/ckb-session-kit">Source on GitHub</a>
        </p>
      </header>

      {!session ? (
        <CreateForm
          onCreate={async (s) => {
            await store.save(s);
            setSession(s);
            push({ ok: true, text: "Session created; key saved in this browser (IndexedDB)" });
          }}
        />
      ) : (
        <>
          <section className="card">
            <h2>Session</h2>
            <dl>
              <dt>Status</dt>
              <dd>
                {isActive(session, now) ? (
                  <span className="ok">active — expires in {remaining(session, now)}</span>
                ) : (
                  <span className="bad">expired</span>
                )}
              </dd>
              <dt>Address</dt>
              <dd className="mono">
                {address ? <a href={explorerAddr(address)}>{address}</a> : "…"}
              </dd>
              <dt>Balance</dt>
              <dd>
                {balance === undefined ? "…" : ckb(balance)}{" "}
                <button className="link" onClick={refreshBalance}>
                  refresh
                </button>
              </dd>
              <dt>Max per transaction</dt>
              <dd>{ckb(session.policy.scope.maxPerTx)}</dd>
              <dt>Allowed recipient</dt>
              <dd className="mono">{session.policy.scope.recipients?.join(", ") ?? "any"}</dd>
            </dl>
            <p className="hint">
              Fund the session address with testnet CKB from the{" "}
              <a href="https://faucet.nervos.org/" target="_blank" rel="noreferrer">
                faucet
              </a>
              , then refresh. Each faucet claim takes a minute or two to arrive.
            </p>
          </section>

          <SendForm
            session={session}
            onSend={async (to, amount) => {
              try {
                const hash = await sendInScope(session, client, { to, amount });
                push({ ok: true, text: `Sent ${ckb(amount)} — no wallet dialog`, hash });
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                push({ ok: false, text: e instanceof ScopeError ? msg : `Failed: ${msg}` });
              }
              refreshBalance();
            }}
          />

          <button
            className="danger"
            onClick={async () => {
              if (!window.confirm("End the session? Any CKB left at the session address stays there.")) return;
              await store.clear();
              setSession(undefined);
              setBalance(undefined);
              push({ ok: true, text: "Session ended; key deleted from this browser" });
            }}
          >
            End session
          </button>
        </>
      )}

      {log.length > 0 && (
        <section className="card">
          <h2>Activity</h2>
          <ul className="log">
            {log.map((e, i) => (
              <li key={i} className={e.ok ? "ok" : "bad"}>
                <time>{e.at.toLocaleTimeString()}</time> {e.text}
                {e.hash && (
                  <>
                    {" "}
                    — <a href={explorerTx(e.hash)}>view on explorer</a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function remaining(s: Session, now: Date): string {
  const ms = s.policy.expiresAt.getTime() - now.getTime();
  const m = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${m}m ${sec.toString().padStart(2, "0")}s`;
}

function CreateForm({ onCreate }: { onCreate: (s: Session) => Promise<void> }) {
  const [minutes, setMinutes] = useState("60");
  const [max, setMax] = useState("100");
  const [recipient, setRecipient] = useState("");
  const [error, setError] = useState<string>();

  return (
    <form
      className="card"
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
      <h2>Create a session</h2>
      <label>
        Expires after (minutes)
        <input type="number" min="1" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      </label>
      <label>
        Max per transaction (CKB)
        <input type="number" min="61" step="any" value={max} onChange={(e) => setMax(e.target.value)} />
      </label>
      <label>
        Only allow this recipient (optional)
        <input
          className="mono"
          placeholder="ckt1…"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
        />
      </label>
      {error && <p className="bad">{error}</p>}
      <button type="submit">Create session</button>
    </form>
  );
}

function SendForm({ session, onSend }: { session: Session; onSend: (to: string, amount: bigint) => Promise<void> }) {
  const [to, setTo] = useState(session.policy.scope.recipients?.[0] ?? "");
  const [amount, setAmount] = useState("61");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="card"
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
      <h2>Send with the session key</h2>
      <p className="hint">
        No wallet pops up. Try an amount above the limit to see the session refuse it. A CKB
        output needs at least 61 CKB.
      </p>
      <label>
        To
        <input className="mono" placeholder="ckt1…" value={to} onChange={(e) => setTo(e.target.value)} required />
      </label>
      <label>
        Amount (CKB)
        <input type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
