"use client";

import { ccc, useCcc, useSigner } from "@ckb-ccc/connector-react";
import {
  closeSession,
  createSession,
  findSessionCells,
  indexedDbStore,
  isActive,
  openSession,
  paymentMemo,
  signAccess,
  spendInSession,
  type Session,
  type SessionCells,
  type SessionLockDeployment,
} from "ckb-session-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import deploymentJson from "../../../deployment/testnet.json";
import { ckb, describeFailure, explorerAddr, explorerTx, Footer, Log, Nav, short, type LogEntry } from "../shared";
import { Prompt, Terminal } from "../Terminal";
import { ARTICLES } from "./articles";
import { CREATOR, memoLabel, PRICE } from "./config";

const deployment = deploymentJson as SessionLockDeployment;
// Its own slot, so it never touches the session on the wallet page.
const store = indexedDbStore(undefined, "pay-per-read");

const CKB = 100_000_000n;
const MAX_PER_TX = 5n * CKB;
const BUDGET = 200n * CKB;
/** A session cell with a recipient occupies this much; it is not spendable. */
const CELL_RESERVE = 153n * CKB;

const UNLOCKED_KEY = "ckb-session-kit:pay-per-read:unlocked";
/** Article id → its payment, and the text once the server has released it. */
type Unlocked = Record<string, { tx: string; body?: string[] }>;

function loadUnlocked(): Unlocked {
  try {
    const raw = JSON.parse(localStorage.getItem(UNLOCKED_KEY) ?? "{}");
    // Entries saved before server checks are bare tx hashes of payments with no
    // memo; the server can never release those, so they are dropped.
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "object" && v !== null)) as Unlocked;
  } catch {
    return {};
  }
}

function saveUnlocked(u: Unlocked) {
  try {
    localStorage.setItem(UNLOCKED_KEY, JSON.stringify(u));
  } catch {
    // storage blocked: the unlock still holds for this visit
  }
}

export default function PayPerRead() {
  const { open, disconnect, client } = useCcc();
  const signer = useSigner();
  const [ownerAddress, setOwnerAddress] = useState<string>();
  const [ownerLockHash, setOwnerLockHash] = useState<string>();
  const [session, setSession] = useState<Session>();
  const [cells, setCells] = useState<SessionCells>();
  const [creatorBalance, setCreatorBalance] = useState<bigint>();
  const [unlocked, setUnlocked] = useState<Unlocked>({});
  const [pending, setPending] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());

  const push = (e: Omit<LogEntry, "at">) => setLog((l) => [{ at: new Date(), ...e }, ...l]);

  useEffect(() => {
    setUnlocked(loadUnlocked());
    store
      .load()
      .then((s) => {
        setSession(s);
        if (s) push({ level: "info", text: "restored reading session from IndexedDB" });
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
    const { script } = await ccc.Address.fromString(CREATOR, client);
    let total = 0n;
    for await (const cell of client.findCellsByLock(script, null, true)) total += cell.cellOutput.capacity;
    setCreatorBalance(total);
    setCells(session?.onchain ? await findSessionCells(session, client, deployment, session.onchain) : undefined);
  }, [client, session]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Each read spends the cells the previous one created, so reads wait for the
  // last one to confirm.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      if ((await client.getTransaction(pending))?.status === "committed") {
        setPending(undefined);
        push({ level: "info", text: `confirmed ${short(pending)}` });
        refresh();
      }
    }, 4000);
    return () => clearInterval(t);
  }, [client, pending, refresh]);

  // Paid but not yet released: once the payment is committed, prove to the
  // server that this browser's session key paid, and get the text.
  const claiming = useRef(new Set<string>());
  useEffect(() => {
    if (!session) return;
    for (const [id, { tx, body }] of Object.entries(unlocked)) {
      if (body || tx === pending || claiming.current.has(id)) continue;
      claiming.current.add(id);
      (async () => {
        try {
          const proof = await signAccess(session, tx as ccc.Hex, paymentMemo(memoLabel(id)));
          const res = await fetch("/api/article", { method: "POST", body: JSON.stringify({ id, proof }) });
          const data = await res.json();
          if (!res.ok) {
            push({ level: "err", text: `server refused “${id}”: ${data.error}` });
            return;
          }
          setUnlocked((u) => {
            const next = { ...u, [id]: { tx, body: data.body } };
            saveUnlocked(next);
            return next;
          });
          push({ level: "ok", text: `server checked the payment on-chain and released “${id}”` });
        } catch (e) {
          push(describeFailure(e));
        } finally {
          claiming.current.delete(id);
        }
      })();
    }
  }, [session, unlocked, pending]);

  const active = session?.onchain && isActive(session, now);
  const spendable = cells ? (cells.balance > CELL_RESERVE ? cells.balance - CELL_RESERVE : 0n) : undefined;
  const isOwner = Boolean(
    session?.onchain && ownerLockHash && ccc.Script.from(session.onchain.ownerLock).hash() === ownerLockHash,
  );

  async function openReading() {
    if (!signer) return;
    setBusy(true);
    try {
      const draft = createSession({
        expiresAt: new Date(Date.now() + 60 * 60_000),
        scope: { maxPerTx: MAX_PER_TX, recipients: [CREATOR] },
      });
      push({ level: "info", text: "waiting for your wallet to sign the funding transaction…" });
      const { txHash, binding } = await openSession(signer, draft, deployment, { budget: BUDGET, recipient: CREATOR });
      const s = { ...draft, onchain: binding };
      await store.save(s);
      setSession(s);
      setPending(txHash);
      push({ level: "ok", text: "reading session opened · it can only pay the creator", hash: txHash });
    } catch (e) {
      push(describeFailure(e));
    } finally {
      setBusy(false);
    }
  }

  async function unlock(id: string, title: string) {
    if (!session?.onchain) return;
    setBusy(true);
    try {
      const hash = await spendInSession(session, client, deployment, session.onchain, {
        to: CREATOR,
        amount: PRICE,
        topUp: true,
        memo: paymentMemo(memoLabel(id)),
      });
      // Pending first, so the claim waits for the payment to commit.
      setPending(hash);
      setUnlocked((u) => {
        const next = { ...u, [id]: { tx: hash } };
        saveUnlocked(next);
        return next;
      });
      push({ level: "ok", text: `paid 1 CKB for “${title}” · session key only, no wallet popup`, hash });
    } catch (e) {
      push(describeFailure(e));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!signer || !session?.onchain) return;
    setBusy(true);
    try {
      push({ level: "info", text: "returning the key cell, then waiting for your wallet…" });
      const { keyTx, sweepTx } = await closeSession(signer, session, deployment, session.onchain);
      if (keyTx) push({ level: "ok", text: "key cell returned to you", hash: keyTx });
      if (sweepTx) push({ level: "ok", text: "unspent balance swept back to you", hash: sweepTx });
      await store.clear();
      setSession(undefined);
      setCells(undefined);
      setPending(undefined);
    } catch (e) {
      push(describeFailure(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wrap">
      <Nav here="read" />
      <Terminal client={client} title="ckb-session-kit — pay-per-read">
        <h1>
          <span className="dim">[</span> pay-per-read <span className="dim">]</span>{" "}
          <span className="dim">:: 1 CKB per article :: testnet</span>
        </h1>
        <p className="lede">
          Your wallet signs <strong>once</strong> to open a reading session. Each article then costs 1 CKB,
          paid by a key held in this browser with <strong>no popup</strong>. The session can only ever
          pay this creator, at most 5 CKB per transaction. The network enforces both limits.
        </p>
        <p className="note">
          # payments top up the creator&apos;s{" "}
          <a href={explorerAddr(CREATOR)}>anyone-can-pay cell</a>: a new cell would need 61 CKB. Each payment
          names its article in a memo the session key signs; the server releases the text only after
          checking, on-chain, that this key paid for that article.
        </p>

        <section className="block">
          <h2>reader</h2>
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
          <dl style={{ marginTop: 8 }}>
            <dt>creator</dt>
            <dd>
              <a href={explorerAddr(CREATOR)}>{short(CREATOR, 12)}</a>{" "}
              <span className="ok">{creatorBalance === undefined ? "…" : ckb(creatorBalance)}</span>
              <span className="dim"> earned so far (incl. 61 CKB cell)</span>
            </dd>
          </dl>
        </section>

        {loading ? (
          <div className="block">
            <span className="cursor" />
          </div>
        ) : !session?.onchain ? (
          <section className="block">
            <h2>open reading session</h2>
            <Prompt path="~">
              session open --budget 200CKB --max 5CKB --allow {short(CREATOR)} --expires 60m
            </Prompt>
            <p className="hint">
              # 200 CKB into the session (153 stay as the cell&apos;s own storage, 47 are spendable) plus a
              100 CKB key cell for fees. Everything unspent comes back when you close. Needs ~301 testnet
              CKB: <a href="https://faucet.nervos.org/">faucet</a>.
            </p>
            <button disabled={!signer || busy} onClick={openReading}>
              {!signer ? "connect a wallet first" : busy ? "waiting for wallet…" : "open session (1 signature) ⏎"}
            </button>
          </section>
        ) : (
          <section className="block">
            <h2>session</h2>
            <Prompt path="~/session">session status</Prompt>
            <dl>
              <dt>state</dt>
              <dd>
                {active ? (
                  <span className="ok">● active · {remaining(session, now)} left</span>
                ) : (
                  <span className="bad">○ expired · close it to get your CKB back</span>
                )}
              </dd>
              <dt>spendable</dt>
              <dd>
                <span className="ok">{spendable === undefined ? "…" : ckb(spendable)}</span>
                <span className="dim"> · {spendable === undefined ? "…" : (spendable / PRICE).toString()} reads left</span>
              </dd>
              <dt>fees</dt>
              <dd>{cells ? ckb(cells.feeBalance) : "…"} <span className="dim">in the key cell</span></dd>
            </dl>
            {pending && (
              <p className="hint">
                waiting for <a href={explorerTx(pending)}>{short(pending)}</a> to confirm before the next read…{" "}
                <span className="cursor" />
              </p>
            )}
          </section>
        )}

        <section className="block">
          <h2>articles</h2>
          {ARTICLES.map((a) => {
            const paid = unlocked[a.id];
            return (
              <article key={a.id} className={`article${paid ? " open" : ""}`}>
                <h3>{a.title}</h3>
                <p>{a.teaser}</p>
                {paid?.body ? (
                  <>
                    {paid.body.map((para, i) => (
                      <p key={i}>{para}</p>
                    ))}
                    <p className="hint">
                      # paid 1 CKB · tx <a href={explorerTx(paid.tx)}>{short(paid.tx)}</a> · released by the
                      server after checking it on-chain
                    </p>
                  </>
                ) : paid ? (
                  <p className="hint">
                    # paid · tx <a href={explorerTx(paid.tx)}>{short(paid.tx)}</a> · the server releases the text
                    once the payment is committed… <span className="cursor" />
                  </p>
                ) : (
                  <>
                    <p className="locked" aria-hidden>
                      {"█".repeat(48)} {"█".repeat(36)} {"█".repeat(52)}
                    </p>
                    <button disabled={!active || busy || Boolean(pending)} onClick={() => unlock(a.id, a.title)}>
                      {!session?.onchain
                        ? "open a session to read"
                        : pending
                          ? "waiting for the last payment…"
                          : busy
                            ? "signing…"
                            : "read for 1 CKB ⏎"}
                    </button>
                  </>
                )}
              </article>
            );
          })}
        </section>

        {session?.onchain && (
          <section className="block">
            <h2>close</h2>
            <Prompt path="~/session">session close --return-to reader</Prompt>
            <p className="hint">
              # returns the key cell and the unspent balance to your wallet. One signature
              {isOwner ? "." : " — connect the wallet that opened it first."}
            </p>
            <button className="danger" disabled={!isOwner || busy} onClick={close}>
              close session
            </button>
          </section>
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
