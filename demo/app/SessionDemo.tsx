"use client";

import { ccc, useCcc, useSigner } from "@ckb-ccc/connector-react";
import {
  closeSession,
  createSession,
  findSessionCells,
  indexedDbStore,
  isActive,
  openSession,
  ScopeError,
  SessionBalanceError,
  sessionLockErrorFrom,
  spendInSession,
  type Session,
  type SessionCells,
  type SessionLockDeployment,
} from "ckb-session-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import deploymentJson from "../../deployment/testnet.json";
import { Prompt, Terminal } from "./Terminal";

const deployment = deploymentJson as SessionLockDeployment;
const store = indexedDbStore();
const explorerTx = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
const explorerAddr = (a: string) => `https://testnet.explorer.nervos.org/address/${a}`;
const ckb = (shannons: bigint) => ccc.fixedPointToString(shannons) + " CKB";
const short = (h: string, n = 8) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);

type LogEntry = { at: Date; level: "ok" | "err" | "info"; text: string; hash?: string };

/** Turns anything thrown during a send into one honest log line. */
function describeFailure(e: unknown): { level: "err"; text: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof ScopeError) return { level: "err", text: `${msg} · refused in the browser, nothing signed` };
  if (e instanceof SessionBalanceError) return { level: "err", text: msg };
  const onChain = sessionLockErrorFrom(msg);
  if (onChain) return { level: "err", text: `rejected by the network: session lock error ${onChain.code} (${onChain.meaning})` };
  if (/Immature/i.test(msg)) return { level: "err", text: "cooldown: the session cell is younger than the rate limit allows; try again in a few blocks" };
  return { level: "err", text: `failed: ${msg.slice(0, 200)}` };
}

export default function SessionDemo() {
  const { open, disconnect, client } = useCcc();
  const signer = useSigner();
  const [ownerAddress, setOwnerAddress] = useState<string>();
  const [ownerLockHash, setOwnerLockHash] = useState<string>();
  const [session, setSession] = useState<Session>();
  const [cells, setCells] = useState<SessionCells>();
  const [pending, setPending] = useState<string>();
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());
  const restored = useRef(false);

  const push = (e: Omit<LogEntry, "at">) => setLog((l) => [{ at: new Date(), ...e }, ...l]);

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

  useEffect(() => {
    if (!signer) {
      setOwnerAddress(undefined);
      setOwnerLockHash(undefined);
      return;
    }
    signer.getRecommendedAddressObj().then((a) => {
      setOwnerAddress(a.toString());
      setOwnerLockHash(a.script.hash());
    });
  }, [signer]);

  const refresh = useCallback(async () => {
    if (!session?.onchain) return setCells(undefined);
    setCells(await findSessionCells(session, client, deployment, session.onchain));
  }, [client, session]);

  // Poll: balances change as transactions confirm.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Clear the "waiting" line once the last transaction is committed.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      if ((await client.getTransaction(pending))?.status === "committed") {
        setPending(undefined);
        push({ level: "info", text: `confirmed ${short(pending)}` });
        refresh();
      }
    }, 5000);
    return () => clearInterval(t);
  }, [client, pending, refresh]);

  const isOwner = Boolean(
    session?.onchain && ownerLockHash && ccc.Script.from(session.onchain.ownerLock).hash() === ownerLockHash,
  );

  return (
    <main className="wrap">
      <Terminal client={client} title="ckb-session-kit — demo">
        <h1>
          <span className="dim">[</span> ckb-session-kit <span className="dim">v0.2 ]</span>{" "}
          <span className="dim">:: self-custody sessions :: testnet</span>
        </h1>
        <p className="lede">
          Your wallet signs <strong>once</strong> to open a session. After that, a key held in this
          browser pays on its own, with no popups, and the network enforces the limits you set. Your
          wallet signs once more to close it.
        </p>
        <p className="note">
          # limits enforced on-chain by the{" "}
          <a href={explorerTx(String(deployment.cellDep.outPoint.txHash))}>session lock</a> (Rust,
          testnet). Expiry is enforced in the browser: CKB scripts cannot prove that time has{" "}
          <em>not</em> passed. ·{" "}
          <a href="https://github.com/luongthanhtung03/ckb-session-kit">source</a>
        </p>

        <section className="block">
          <h2>owner</h2>
          <Prompt path="~">wallet {signer ? "status" : "connect"}</Prompt>
          {signer ? (
            <dl>
              <dt>wallet</dt>
              <dd>
                {ownerAddress ? <a href={explorerAddr(ownerAddress)}>{short(ownerAddress, 12)}</a> : "…"}{" "}
                <button className="link" onClick={disconnect}>
                  disconnect
                </button>
              </dd>
            </dl>
          ) : (
            <>
              <p className="hint"># JoyID (passkey, nothing to install), MetaMask, UniSat, OKX… on testnet.</p>
              <button onClick={open}>connect wallet ⏎</button>
            </>
          )}
        </section>

        {loading ? (
          <div className="block">
            <span className="cursor" />
          </div>
        ) : !session ? (
          <OpenForm
            signer={signer}
            onOpen={async (draft, opts) => {
              if (!signer) return;
              try {
                push({ level: "info", text: "waiting for your wallet to sign the funding transaction…" });
                const { txHash, binding } = await openSession(signer, draft, deployment, opts);
                const s = { ...draft, onchain: binding };
                await store.save(s);
                setSession(s);
                setPending(txHash);
                push({ level: "ok", text: "session opened · key saved in this browser only", hash: txHash });
              } catch (e) {
                push(describeFailure(e));
              }
            }}
          />
        ) : !session.onchain ? (
          <section className="block">
            <h2>legacy session</h2>
            <p className="hint"># this session is from v0.1 (browser-only, no on-chain lock). End it to open an on-chain one.</p>
            <button
              className="danger"
              onClick={async () => {
                await store.clear();
                setSession(undefined);
                push({ level: "info", text: "v0.1 session discarded" });
              }}
            >
              discard
            </button>
          </section>
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
                    <span className="bad">○ expired · the owner should close it</span>
                  )}
                </dd>
                <dt>balance</dt>
                <dd>
                  <span className="ok">{cells ? ckb(cells.balance) : "…"}</span>
                  <span className="dim"> in {cells?.sessionCells.length ?? "…"} session cell(s)</span>{" "}
                  <button className="link" onClick={refresh}>
                    refresh
                  </button>
                </dd>
                <dt>fees</dt>
                <dd>{cells ? ckb(cells.feeBalance) : "…"} <span className="dim">in the key cell</span></dd>
                <dt>max/tx</dt>
                <dd className="warn">{ckb(session.policy.scope.maxPerTx)} <span className="dim">· on-chain</span></dd>
                <dt>interval</dt>
                <dd>
                  {session.onchain.minInterval > 0n ? `${session.onchain.minInterval} blocks between spends` : "none"}{" "}
                  <span className="dim">· on-chain</span>
                </dd>
                <dt>allow</dt>
                <dd>
                  {session.policy.scope.recipients?.join(", ") ?? "* (any recipient)"}
                  {session.onchain.recipientLockHash && <span className="dim"> · on-chain</span>}
                </dd>
                <dt>lock</dt>
                <dd className="dim">{cells ? short(cells.lock.hash(), 10) : "…"}</dd>
              </dl>
              {pending && (
                <p className="hint">
                  waiting for <a href={explorerTx(pending)}>{short(pending)}</a> to confirm… <span className="cursor" />
                </p>
              )}
            </section>

            <SendForm
              session={session}
              onSend={async (to, amount) => {
                try {
                  const hash = await spendInSession(session, client, deployment, session.onchain!, { to, amount });
                  setPending(hash);
                  push({ level: "ok", text: `paid ${ckb(amount)} · signed by the session key, no wallet popup`, hash });
                } catch (e) {
                  push(describeFailure(e));
                }
                refresh();
              }}
            />

            <section className="block">
              <h2>close</h2>
              <Prompt path="~/session">session close --return-to owner</Prompt>
              <p className="hint">
                # returns the key cell and every session cell to the owner. One wallet signature
                {isOwner ? "." : " — connect the owner's wallet first."}
              </p>
              <button
                className="danger"
                disabled={!isOwner}
                onClick={async () => {
                  if (!signer) return;
                  try {
                    push({ level: "info", text: "returning the key cell, then waiting for your wallet…" });
                    const { keyTx, sweepTx } = await closeSession(signer, session, deployment, session.onchain!);
                    if (keyTx) push({ level: "ok", text: "key cell returned to the owner", hash: keyTx });
                    if (sweepTx) push({ level: "ok", text: "session swept back to the owner", hash: sweepTx });
                    await store.clear();
                    setSession(undefined);
                    setCells(undefined);
                    setPending(undefined);
                  } catch (e) {
                    push(describeFailure(e));
                  }
                }}
              >
                close session
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

type OpenOpts = { budget: bigint; minInterval: bigint; recipient?: string };

function OpenForm({
  signer,
  onOpen,
}: {
  signer: ccc.Signer | undefined;
  onOpen: (draft: Session, opts: OpenOpts) => Promise<void>;
}) {
  const [minutes, setMinutes] = useState("60");
  const [max, setMax] = useState("100");
  const [budget, setBudget] = useState("400");
  const [interval, setInterval_] = useState("0");
  const [recipient, setRecipient] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="block"
      onSubmit={async (ev) => {
        ev.preventDefault();
        setError(undefined);
        setBusy(true);
        try {
          const to = recipient.trim();
          const draft = createSession({
            expiresAt: new Date(Date.now() + Number(minutes) * 60_000),
            scope: { maxPerTx: ccc.fixedPointFrom(max), ...(to && { recipients: [to] }) },
          });
          await onOpen(draft, {
            budget: ccc.fixedPointFrom(budget),
            minInterval: BigInt(interval || "0"),
            ...(to && { recipient: to }),
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>open session</h2>
      <Prompt path="~">
        session open --budget {budget || "?"}CKB --max {max || "?"}CKB --expires {minutes || "?"}m
        {interval && interval !== "0" && ` --interval ${interval}`}
        {recipient.trim() && ` --allow ${short(recipient.trim())}`}
      </Prompt>
      <label>
        --budget (CKB the session may spend in total; min 121)
        <div className="field">
          <input type="number" min="121" step="any" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </div>
      </label>
      <label>
        --max (CKB per transaction, enforced on-chain)
        <div className="field">
          <input type="number" min="61" step="any" value={max} onChange={(e) => setMax(e.target.value)} />
        </div>
      </label>
      <label>
        --expires (minutes, enforced in the browser)
        <div className="field">
          <input type="number" min="1" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </div>
      </label>
      <label>
        --interval (blocks between spends, enforced on-chain; 0 = none)
        <div className="field">
          <input type="number" min="0" value={interval} onChange={(e) => setInterval_(e.target.value)} />
        </div>
      </label>
      <label>
        --allow (only this recipient, enforced on-chain; optional)
        <div className="field">
          <input placeholder="ckt1…" value={recipient} onChange={(e) => setRecipient(e.target.value)} spellCheck={false} />
        </div>
      </label>
      <p className="hint"># the wallet also funds a 100 CKB key cell that pays the session&apos;s fees; it comes back on close.</p>
      {error && <p className="bad">error: {error}</p>}
      <button type="submit" disabled={!signer || busy}>
        {!signer ? "connect a wallet first" : busy ? "waiting for wallet…" : "open session (1 signature) ⏎"}
      </button>
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
      <h2>pay</h2>
      <Prompt path="~/session">
        session pay --to {to.trim() ? short(to.trim()) : "?"} --amount {amount || "?"}CKB
      </Prompt>
      <p className="hint"># no wallet popup. try more than max/tx to watch it get refused. min payment: 61 CKB.</p>
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
