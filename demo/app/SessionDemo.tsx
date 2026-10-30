"use client";

import { ccc, useCcc, useSigner } from "@ckb-ccc/connector-react";
import {
  closeSession,
  createSession,
  findOwnedSessionCells,
  findSessionCells,
  indexedDbStore,
  isActive,
  openSession,
  recoverSessions,
  spendInSession,
  TESTNET_LEGACY_DEPLOYMENTS,
  type Session,
  type SessionCells,
  type SessionLockDeployment,
} from "ckb-session-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import deploymentJson from "../../deployment/testnet.json";
import {
  ckb,
  describeClose,
  describeFailure,
  explorerAddr,
  explorerTx,
  Footer,
  FUNDING_UNSURE,
  Log,
  Nav,
  neverSent,
  openKept,
  paymentState,
  short,
  type LogEntry,
} from "./shared";
import { Prompt, Terminal } from "./Terminal";

const deployment = deploymentJson as SessionLockDeployment;
/** Recovery also sweeps sessions opened under earlier versions of the lock. */
const everyDeployment = [deployment, ...TESTNET_LEGACY_DEPLOYMENTS];
const store = indexedDbStore();

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
  const [closing, setClosing] = useState(false);
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
      .catch((e) => push(describeFailure(e)))
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
    // A wallet switch while this resolves must not leave the old wallet's lock as
    // the owner's (audit, 31 Oct): until the new one answers, there is none.
    setOwnerAddress(undefined);
    setOwnerLockHash(undefined);
    let stale = false;
    signer
      .getRecommendedAddressObj()
      .then((a) => {
        if (stale) return;
        setOwnerAddress(a.toString());
        setOwnerLockHash(a.script.hash());
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
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

  // Clear the "waiting" line once the last transaction is committed, or will never be.
  useEffect(() => {
    if (!pending) return;
    const since = Date.now();
    let done = false;
    const t = setInterval(async () => {
      const state = await paymentState(client, pending, since);
      if (state === "waiting" || done) return;
      done = true;
      setPending(undefined);
      push(
        state === "committed"
          ? { level: "info", text: `confirmed ${short(pending)}` }
          : { level: "err", text: `${short(pending)} never committed; nothing was spent` },
      );
      refresh();
    }, 5000);
    return () => {
      done = true;
      clearInterval(t);
    };
  }, [client, pending, refresh]);

  const isOwner = Boolean(
    session?.onchain && ownerLockHash && ccc.Script.from(session.onchain.ownerLock).hash() === ownerLockHash,
  );

  return (
    <main className="wrap">
      <Nav here="wallet" />
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
                // Saved before the funds are sent: a key that exists nowhere would lose them.
                const opened = await openKept(signer.client, store, draft, (beforeSend) =>
                  openSession(signer, draft, deployment, { ...opts, beforeSend }),
                );
                setSession(opened.session);
                setPending(opened.txHash);
                if (opened.error) {
                  push({ level: "err", text: `${describeFailure(opened.error).text} · ${FUNDING_UNSURE}`, hash: opened.txHash });
                } else {
                  push({ level: "ok", text: "session opened · key saved in this browser only", hash: opened.txHash });
                }
              } catch (e) {
                push(describeFailure(e));
              }
            }}
          />
        ) : null}

        {!loading && !session && signer && (
          <RecoverPanel
            signer={signer}
            onRecover={async () => {
              try {
                push({ level: "info", text: "looking for this wallet's sessions, then waiting for your wallet…" });
                const { txHashes, recovered, cells, failed } = await recoverSessions(signer, everyDeployment);
                txHashes.forEach((hash, i) =>
                  push({
                    level: "ok",
                    text: i ? "another session swept" : `recovered ${ckb(recovered)} from ${cells} session cell(s)`,
                    hash,
                  }),
                );
                if (failed) push({ level: "err", text: `${failed} session(s) could not be swept; try again` });
                if (!txHashes.length && !failed) push({ level: "info", text: "no sessions to recover" });
              } catch (e) {
                push(describeFailure(e));
              }
            }}
          />
        )}

        {loading || !session ? null : !session.onchain ? (
          <section className="block">
            <h2>legacy session</h2>
            <p className="hint"># this session is from v0.1 (browser-only, no on-chain lock). End it to open an on-chain one.</p>
            <button
              className="danger"
              onClick={async () => {
                await store.clear(session);
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
                let sent = undefined as string | undefined; // set in a callback: not narrowed
                try {
                  const hash = await spendInSession(session, client, deployment, session.onchain!, {
                    to,
                    amount,
                    // Pending before it is sent, so close waits for it.
                    beforeSend: async (h) => {
                      sent = h;
                      setPending(h);
                    },
                  });
                  push({ level: "ok", text: `paid ${ckb(amount)} · signed by the session key, no wallet popup`, hash });
                } catch (e) {
                  if (sent && (await neverSent(client, sent))) {
                    const gone = sent;
                    setPending((p) => (p === gone ? undefined : p));
                  }
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
                disabled={!isOwner || closing || Boolean(pending)}
                onClick={async () => {
                  if (!signer || closing || pending) return;
                  setClosing(true);
                  try {
                    push({ level: "info", text: "waiting for your wallet to sweep the session, then returning the key cell…" });
                    const { forget, lines } = describeClose(
                      await closeSession(signer, session, deployment, session.onchain!),
                      "session swept back to the owner",
                    );
                    lines.forEach(push);
                    if (!forget) return;
                    await store.clear(session);
                    setSession(undefined);
                    setCells(undefined);
                    setPending(undefined);
                  } catch (e) {
                    push(describeFailure(e));
                  } finally {
                    setClosing(false);
                  }
                }}
              >
                {closing ? "waiting for wallet…" : pending ? "waiting for the last transaction…" : "close session"}
              </button>
            </section>
          </>
        )}

        <Log entries={log} />
      </Terminal>
      <Footer />
    </main>
  );
}

function remaining(s: Session, now: Date): string {
  const ms = Math.max(0, s.policy.expiresAt.getTime() - now.getTime());
  const m = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${m}m${sec.toString().padStart(2, "0")}s`;
}

type OpenOpts = { budget: bigint; minInterval: bigint };

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
        --budget (CKB put in the session cell; min 121, or 153 with --allow, which stays locked as the cell itself)
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
          <input type="number" min="0" max="72057594037927935" value={interval} onChange={(e) => setInterval_(e.target.value)} />
        </div>
      </label>
      <label>
        --allow (only this recipient, enforced on-chain; optional)
        <div className="field">
          <input placeholder="ckt1…" value={recipient} onChange={(e) => setRecipient(e.target.value)} spellCheck={false} />
        </div>
      </label>
      <p className="hint"># the wallet also funds a ~62–64 CKB key cell (sized to its lock) that pays the session&apos;s fees; it comes back on close, but not on a recovery.</p>
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

/** Device-loss recovery: shown when this browser has no session but a wallet is connected. */
function RecoverPanel({ signer, onRecover }: { signer: ccc.Signer; onRecover: () => Promise<void> }) {
  const [found, setFound] = useState<{ cells: number; total: bigint }>();
  const [busy, setBusy] = useState(false);

  const scan = useCallback(async () => {
    const cells = await findOwnedSessionCells(signer, everyDeployment);
    setFound({ cells: cells.length, total: cells.reduce((s, c) => s + c.cellOutput.capacity, 0n) });
  }, [signer]);

  useEffect(() => {
    scan().catch(() => setFound(undefined));
  }, [scan]);

  if (!found?.cells) return null;
  return (
    <section className="block">
      <h2>recover</h2>
      <Prompt path="~">session recover --owner wallet</Prompt>
      <p className="hint">
        # this wallet has {found.cells} session cell(s) holding {ckb(found.total)}: every session it
        opened, on any device, including the reading page in this browser. The wallet alone sweeps them
        back, no session key needed: one signature (one per session if a cell was spent meanwhile). Key
        cells stay with their keys.
      </p>
      <button
        className="danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onRecover();
            await scan();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "waiting for wallet…" : `recover ${ckb(found.total)} ⏎`}
      </button>
    </section>
  );
}
