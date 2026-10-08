"use client";

import { ccc, useCcc, useSigner } from "@ckb-ccc/connector-react";
import {
  closeSession,
  createSession,
  findSessionCells,
  indexedDbStore,
  isActive,
  openSession,
  spendInSession,
  type Session,
  type SessionCells,
  type SessionLockDeployment,
} from "ckb-session-kit";
import { useCallback, useEffect, useState } from "react";
import deploymentJson from "../../../deployment/testnet.json";
import { ckb, describeFailure, explorerAddr, explorerTx, Footer, Log, Nav, short, type LogEntry } from "../shared";
import { Prompt, Terminal } from "../Terminal";
import { ARTICLES } from "./articles";

const deployment = deploymentJson as SessionLockDeployment;
// Its own slot, so it never touches the session on the wallet page.
const store = indexedDbStore(undefined, "pay-per-read");

/** The creator's anyone-can-pay address on testnet. Readers top up its cells. */
const CREATOR =
  "ckt1qq6pngwqn6e9vlm92th84rk0l4jp2h8lurchjmnwv8kq3rt5psf4vqfrks0ww06uv9pgqzwuajnq694mjncvctg0t589g";
const CKB = 100_000_000n;
const PRICE = 1n * CKB;
const MAX_PER_TX = 5n * CKB;
const BUDGET = 200n * CKB;
/** A session cell with a recipient occupies this much; it is not spendable. */
const CELL_RESERVE = 153n * CKB;

const UNLOCKED_KEY = "ckb-session-kit:pay-per-read:unlocked";
type Unlocked = Record<string, string>; // article id → payment tx hash

function loadUnlocked(): Unlocked {
  try {
    return JSON.parse(localStorage.getItem(UNLOCKED_KEY) ?? "{}");
  } catch {
    return {};
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
      });
      const next = { ...unlocked, [id]: hash };
      setUnlocked(next);
      try {
        localStorage.setItem(UNLOCKED_KEY, JSON.stringify(next));
      } catch {
        // storage blocked: the unlock still holds for this visit
      }
      setPending(hash);
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
          <a href={explorerAddr(CREATOR)}>anyone-can-pay cell</a>: a new cell would need 61 CKB. This demo
          ships the article text in the page; a real site would serve it after checking the payment.
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
                {paid ? (
                  <>
                    {a.body.map((para, i) => (
                      <p key={i}>{para}</p>
                    ))}
                    <p className="hint">
                      # paid 1 CKB · tx <a href={explorerTx(paid)}>{short(paid)}</a>
                    </p>
                  </>
                ) : (
                  <>
                    <p className="locked" aria-hidden>
                      {a.body[0]}
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
