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
  tokenAmount,
  type Session,
  type SessionCells,
  type SessionLockDeployment,
} from "ckb-session-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import deploymentJson from "../../../deployment/testnet.json";
import { ARTICLES } from "../read/articles";
import {
  ckb,
  claimWithRetry,
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
} from "../shared";
import { Prompt, Terminal } from "../Terminal";
import { CREATOR, memoLabel, PRICE_UNITS } from "./config";
import { demoToken, issuerLock, mintDemoToken } from "./token";

const deployment = deploymentJson as SessionLockDeployment;
// Its own slot, so it never touches the sessions on the other pages.
const store = indexedDbStore(undefined, "pay-per-read-tokens");

const CKB = 100_000_000n;
/** Units put in a session, and the most one spend may move. */
const SESSION_UNITS = 20n;
const MAX_UNITS_PER_TX = 5n;
/** A token session cell with a recipient needs about 282 CKB of storage; none of it is spent. */
const BUDGET = 300n * CKB;

const UNLOCKED_KEY = "ckb-session-kit:pay-per-read-tokens:unlocked";
/** Article id → its payment, the session key that paid (only it can claim), when it was sent, and the released text. */
type Entry = { tx: string; key?: string; at?: number; body?: string[] };
type Unlocked = Record<string, Entry>;

function loadUnlocked(): Unlocked {
  try {
    const raw = JSON.parse(localStorage.getItem(UNLOCKED_KEY) ?? "{}");
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "object" && v !== null)) as Unlocked;
  } catch {
    return {};
  }
}

function saveUnlockedTo(next: Unlocked): Unlocked {
  try {
    localStorage.setItem(UNLOCKED_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the unlock still holds for this visit
  }
  return next;
}

/** Read-modify-write, so a second tab's records are kept. */
const recordUnlocked = (u: Unlocked, id: string, entry: Entry) => saveUnlockedTo({ ...u, ...loadUnlocked(), [id]: entry });

/** Forgets a payment that never happened, if `id` is still recorded against it. */
function dropUnlocked(u: Unlocked, id: string, tx: string): Unlocked {
  const all = { ...u, ...loadUnlocked() };
  if (all[id]?.tx === tx) delete all[id];
  return saveUnlockedTo(all);
}

/** This key's payments the server has not released yet. */
const unclaimedBy = (u: Unlocked, key: string) => Object.values(u).filter((e) => !e.body && e.key === key);

/** Units of `token` in cells under `lock`. */
async function unitsHeld(client: ccc.Client, lock: ccc.Script, token: ccc.Script): Promise<bigint> {
  let total = 0n;
  for await (const c of client.findCells({
    script: lock,
    scriptType: "lock",
    scriptSearchMode: "exact",
    filter: { script: token },
    withData: true,
  })) {
    try {
      total += tokenAmount(c.outputData);
    } catch {
      // not a well-formed token cell: not counted
    }
  }
  return total;
}

export default function PayPerReadTokens() {
  const { open, disconnect, client } = useCcc();
  const signer = useSigner();
  const [token, setToken] = useState<ccc.Script>();
  const [issuerAddress, setIssuerAddress] = useState<string>();
  const [ownerAddress, setOwnerAddress] = useState<string>();
  const [ownerLock, setOwnerLock] = useState<ccc.Script>();
  const [ownerUnits, setOwnerUnits] = useState<bigint>();
  const [session, setSession] = useState<Session>();
  const [cells, setCells] = useState<SessionCells>();
  const [creatorUnits, setCreatorUnits] = useState<bigint>();
  const [unlocked, setUnlocked] = useState<Unlocked>({});
  const [pending, setPending] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());
  /** Close was refused because a paid article is unreleased: offer to forfeit it, in case it never will be. */
  const [blocked, setBlocked] = useState(false);

  // The latest records and session, for the async claim loops.
  const unlockedRef = useRef<Unlocked>({});
  const sessionRef = useRef<Session | undefined>(undefined);
  const stopped = useRef(false);
  const saveUnlocked = (next: Unlocked) => {
    unlockedRef.current = next;
    setUnlocked(next);
  };
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const push = (e: Omit<LogEntry, "at">) => setLog((l) => [{ at: new Date(), ...e }, ...l]);

  useEffect(() => {
    stopped.current = false;
    const stored = loadUnlocked();
    saveUnlocked(stored);
    store
      .load()
      .then((s) => {
        setSession(s);
        if (!s) return;
        push({ level: "info", text: "restored token session from IndexedDB" });
        // A payment sent before the reload: wait for it, then claim it.
        const unclaimed = unclaimedBy(stored, s.publicKey).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
        if (unclaimed.length) setPending(unclaimed[unclaimed.length - 1].tx);
      })
      .catch((e) => push(describeFailure(e)))
      .finally(() => setLoading(false));
    // Another tab's payments and releases.
    const onStorage = (e: StorageEvent) => {
      if (e.key === UNLOCKED_KEY) saveUnlocked(loadUnlocked());
    };
    window.addEventListener("storage", onStorage);
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => {
      stopped.current = true;
      clearInterval(t);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    demoToken(client).then(setToken);
    issuerLock(client).then((l) => setIssuerAddress(ccc.Address.fromScript(l, client).toString()));
  }, [client]);

  useEffect(() => {
    if (!signer) {
      setOwnerAddress(undefined);
      setOwnerLock(undefined);
      setOwnerUnits(undefined);
      return;
    }
    // A wallet switch while this resolves must not leave the old wallet's lock as
    // the owner's (audit, 31 Oct): until the new one answers, there is none.
    setOwnerAddress(undefined);
    setOwnerLock(undefined);
    setOwnerUnits(undefined);
    let stale = false;
    signer
      .getRecommendedAddressObj()
      .then((a) => {
        if (stale) return;
        setOwnerAddress(a.toString());
        setOwnerLock(a.script);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [signer]);

  const refresh = useCallback(async () => {
    if (!token) return;
    const { script } = await ccc.Address.fromString(CREATOR, client);
    setCreatorUnits(await unitsHeld(client, script, token));
    if (ownerLock) setOwnerUnits(await unitsHeld(client, ownerLock, token));
    setCells(session?.onchain ? await findSessionCells(session, client, deployment, session.onchain) : undefined);
  }, [client, session, token, ownerLock]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Each step spends the cells the previous one created, so it waits for the last
  // to confirm. A payment that will never commit is forgotten: nothing was paid.
  useEffect(() => {
    if (!pending) return;
    const since = Object.values(unlockedRef.current).find((e) => e.tx === pending)?.at ?? Date.now();
    let done = false;
    const t = setInterval(async () => {
      const state = await paymentState(client, pending, since);
      if (state === "waiting" || done) return;
      done = true;
      setPending((p) => (p === pending ? undefined : p));
      if (state === "committed") {
        push({ level: "info", text: `confirmed ${short(pending)}` });
      } else {
        const lost = Object.entries(unlockedRef.current).find(([, e]) => e.tx === pending && !e.body);
        if (lost) saveUnlocked(dropUnlocked(unlockedRef.current, lost[0], pending));
        push({
          level: "err",
          text: lost
            ? `the payment for “${lost[0]}” never committed (${short(pending)}); nothing was paid, read it again`
            : `${short(pending)} never committed; nothing was spent, try again`,
        });
      }
      refresh();
    }, 4000);
    return () => {
      done = true;
      clearInterval(t);
    };
  }, [client, pending, refresh]);

  // Paid but not yet released: once the payment is committed, prove to the
  // server that this browser's session key paid, and get the text. While the
  // server cannot tell yet (payment not committed, or the chain unreachable), retry.
  const claiming = useRef(new Set<string>());
  useEffect(() => {
    if (!session) return;
    for (const [id, entry] of Object.entries(unlocked)) {
      const { tx, key, body } = entry;
      if (body || tx === pending || claiming.current.has(id)) continue;
      if (key && key !== session.publicKey) continue; // paid by another session: only its key can claim
      claiming.current.add(id);
      const since = entry.at ?? Date.now();
      (async () => {
        try {
          const proof = await signAccess(session, tx as ccc.Hex, paymentMemo(memoLabel(id)));
          const r = await claimWithRetry<{ body: string[] }>(
            "/api/article-token",
            JSON.stringify({ id, proof }),
            async () => {
              if (stopped.current || sessionRef.current?.publicKey !== session.publicKey) return false;
              if (unlockedRef.current[id]?.tx !== tx) return false; // dropped or forfeited meanwhile
              if ((await paymentState(client, tx, since)) !== "dropped") return true;
              saveUnlocked(dropUnlocked(unlockedRef.current, id, tx));
              push({ level: "err", text: `the payment for “${id}” never committed; nothing was paid, read it again` });
              return false;
            },
            (why) => push({ level: "info", text: `“${id}”: ${why}` }),
          );
          if (!r) return;
          if (!r.ok) {
            push({ level: "err", text: `server refused “${id}”: ${r.error}` });
            return;
          }
          saveUnlocked(recordUnlocked(unlockedRef.current, id, { ...entry, body: r.data.body }));
          push({ level: "ok", text: `server checked the token payment on-chain and released “${id}”` });
        } catch (e) {
          push(describeFailure(e));
        } finally {
          claiming.current.delete(id);
        }
      })();
    }
  }, [session, unlocked, pending, client]);

  const active = session?.onchain && isActive(session, now);
  const isOwner = Boolean(
    session?.onchain && ownerLock && ccc.Script.from(session.onchain.ownerLock).eq(ownerLock),
  );
  const toPut = ownerUnits === undefined ? 0n : ownerUnits < SESSION_UNITS ? ownerUnits : SESSION_UNITS;

  async function mint() {
    if (!signer) return;
    setBusy(true);
    try {
      push({ level: "info", text: "waiting for your wallet to sign the mint…" });
      const hash = await mintDemoToken(signer, SESSION_UNITS);
      setPending(hash);
      push({ level: "ok", text: `minted ${SESSION_UNITS} demo tokens to your wallet`, hash });
    } catch (e) {
      push(describeFailure(e));
    } finally {
      setBusy(false);
    }
  }

  async function openReading() {
    if (!signer || !token || toPut < PRICE_UNITS) return;
    setBusy(true);
    try {
      const draft = createSession({
        expiresAt: new Date(Date.now() + 60 * 60_000),
        scope: { maxPerTx: 1n * CKB, recipients: [CREATOR] },
      });
      push({ level: "info", text: "waiting for your wallet to sign the funding transaction…" });
      // Saved before the funds are sent: a key that exists nowhere would lose them.
      const opened = await openKept(client, store, draft, (beforeSend) =>
        openSession(signer, draft, deployment, {
          budget: BUDGET,
          token: { type: token, amount: toPut, maxPerTx: MAX_UNITS_PER_TX },
          beforeSend,
        }),
      );
      setSession(opened.session);
      setPending(opened.txHash);
      if (opened.error) {
        push({ level: "err", text: `${describeFailure(opened.error).text} · ${FUNDING_UNSURE}`, hash: opened.txHash });
      } else {
        push({ level: "ok", text: `token session opened with ${toPut} units · it can only pay the creator`, hash: opened.txHash });
      }
    } catch (e) {
      push(describeFailure(e));
    } finally {
      setBusy(false);
    }
  }

  async function unlock(id: string, title: string) {
    if (!session?.onchain || pending) return;
    // Another tab may have paid already: re-read what is recorded before paying.
    const fresh = { ...unlockedRef.current, ...loadUnlocked() };
    const known = new Set(Object.values(unlockedRef.current).map((e) => e.tx));
    const elsewhere = unclaimedBy(fresh, session.publicKey).find((e) => !known.has(e.tx));
    if (fresh[id] && (fresh[id].body || fresh[id].key === session.publicKey)) {
      saveUnlocked(fresh);
      push({ level: "info", text: `“${title}” is already paid for, in another tab` });
      return;
    }
    if (elsewhere) {
      saveUnlocked(fresh);
      setPending(elsewhere.tx);
      push({ level: "info", text: "another tab just paid from this session; waiting for that payment first" });
      return;
    }
    setBusy(true);
    let sent = undefined as string | undefined; // set in a callback: not narrowed
    try {
      const hash = await spendInSession(session, client, deployment, session.onchain, {
        to: CREATOR,
        token: PRICE_UNITS,
        topUp: true,
        memo: paymentMemo(memoLabel(id)),
        // Recorded before it is sent, and pending first so the claim waits for it to commit.
        beforeSend: async (h) => {
          sent = h;
          saveUnlocked(recordUnlocked(unlockedRef.current, id, { tx: h, key: session.publicKey, at: Date.now() }));
          setPending(h);
        },
      });
      push({ level: "ok", text: `paid ${PRICE_UNITS} tokens for “${title}” · session key only, no wallet popup`, hash });
    } catch (e) {
      // Forget the record only if the node never took the payment.
      if (sent && (await neverSent(client, sent))) {
        const gone = sent;
        saveUnlocked(dropUnlocked(unlockedRef.current, id, gone));
        setPending((p) => (p === gone ? undefined : p));
      }
      push(describeFailure(e));
    } finally {
      setBusy(false);
    }
  }

  async function close(forfeit = false) {
    if (!signer || !session?.onchain || pending) return;
    setBusy(true);
    try {
      const unclaimed = unclaimedBy({ ...unlockedRef.current, ...loadUnlocked() }, session.publicKey).length > 0;
      if (unclaimed && !forfeit) {
        // Only this session's key can claim its payments; closing would forfeit them.
        setBlocked(true);
        push({ level: "err", text: "an article you paid for is not released yet; close once it is" });
        return;
      }
      push({ level: "info", text: "waiting for your wallet to sweep the tokens and CKB, then returning the key cell…" });
      const { forget, lines } = describeClose(
        await closeSession(signer, session, deployment, session.onchain),
        "unspent tokens and CKB swept back to you",
      );
      lines.forEach(push);
      if (!forget) return;
      await store.clear(session);
      setBlocked(false);
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
      <Nav here="tokens" />
      <Terminal client={client} title="ckb-session-kit — pay-per-read in tokens">
        <h1>
          <span className="dim">[</span> pay-per-read <span className="dim">]</span>{" "}
          <span className="dim">:: {PRICE_UNITS.toString()} tokens per article :: testnet</span>
        </h1>
        <p className="lede">
          The same reading room, paid in an <strong>xUDT token</strong> instead of CKB. Your wallet signs{" "}
          <strong>once</strong> to put {SESSION_UNITS.toString()} tokens in a session; each article then costs{" "}
          {PRICE_UNITS.toString()}, paid by a key in this browser with <strong>no popup</strong>. The network
          enforces the limits: only this creator, at most {MAX_UNITS_PER_TX.toString()} tokens and 1 CKB per
          payment (the token pages pay no CKB; the session needs a CKB limit above zero).
        </p>
        <p className="note">
          # the demo token is free: its issuer is an{" "}
          <a href={issuerAddress ? explorerAddr(issuerAddress) : undefined}>anyone-can-pay cell</a> nobody holds
          the key to, so anyone can mint it. It is worth nothing. Payments top up the creator&apos;s token cell;
          the server releases the text after checking on-chain that this key paid {PRICE_UNITS.toString()} units
          of this token for that article.
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
              <dt>tokens</dt>
              <dd>
                <span className="ok">{ownerUnits === undefined ? "…" : ownerUnits.toString()}</span>
                <span className="dim"> demo tokens in your wallet</span>
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
              <span className="ok">{creatorUnits === undefined ? "…" : creatorUnits.toString()}</span>
              <span className="dim"> tokens earned so far</span>
            </dd>
          </dl>
        </section>

        {loading ? (
          <div className="block">
            <span className="cursor" />
          </div>
        ) : !session?.onchain ? (
          <section className="block">
            <h2>open token session</h2>
            {signer && ownerUnits !== undefined && ownerUnits < PRICE_UNITS ? (
              <>
                <Prompt path="~">token mint --amount {SESSION_UNITS.toString()}</Prompt>
                <p className="hint">
                  # step 1: mint {SESSION_UNITS.toString()} free demo tokens. You pay only the new cell&apos;s
                  storage (~142 CKB, back when the tokens go into the session) and the fee.
                </p>
                <button disabled={busy || Boolean(pending)} onClick={mint}>
                  {busy ? "waiting for wallet…" : pending ? "waiting for the mint to confirm…" : "mint demo tokens ⏎"}
                </button>
              </>
            ) : (
              <>
                <Prompt path="~">
                  session open --token {toPut.toString()} --max {MAX_UNITS_PER_TX.toString()} --allow{" "}
                  {short(CREATOR)} --expires 60m
                </Prompt>
                <p className="hint">
                  # {toPut.toString()} tokens into the session, held in a cell that needs 300 CKB of storage, plus
                  a ~62–64 CKB key cell for fees (sized to your wallet&apos;s lock). Tokens and CKB all come back
                  when you close. Needs ~365 testnet CKB, counting the ~142 CKB your token cell already holds:{" "}
                  <a href="https://faucet.nervos.org/">faucet</a>.
                </p>
                <button disabled={!signer || busy || Boolean(pending) || toPut < PRICE_UNITS} onClick={openReading}>
                  {!signer
                    ? "connect a wallet first"
                    : busy
                      ? "waiting for wallet…"
                      : pending
                        ? "waiting for the last transaction…"
                        : "open session (1 signature) ⏎"}
                </button>
              </>
            )}
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
                  <span className="bad">○ expired · close it to get your tokens back</span>
                )}
              </dd>
              <dt>tokens</dt>
              <dd>
                <span className="ok">{cells ? cells.tokenBalance.toString() : "…"}</span>
                <span className="dim"> · {cells ? (cells.tokenBalance / PRICE_UNITS).toString() : "…"} reads left</span>
              </dd>
              <dt>held</dt>
              <dd>
                {cells ? ckb(cells.balance) : "…"} <span className="dim">storage, not spendable by the key</span>
              </dd>
              <dt>fees</dt>
              <dd>
                {cells ? ckb(cells.feeBalance) : "…"} <span className="dim">in the key cell</span>
              </dd>
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
            const entry = unlocked[a.id];
            const paid = entry && (entry.body || !entry.key || entry.key === session?.publicKey) ? entry : undefined;
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
                      # paid {PRICE_UNITS.toString()} tokens · tx <a href={explorerTx(paid.tx)}>{short(paid.tx)}</a> ·
                      released by the server after checking it on-chain
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
                            : `read for ${PRICE_UNITS} tokens ⏎`}
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
              # returns the unspent tokens, the CKB and the key cell to your wallet. One signature
              {isOwner ? "." : " — connect the wallet that opened it first."} Waits until every paid article is
              released.
            </p>
            <div className="row">
              <button className="danger" disabled={!isOwner || busy || Boolean(pending)} onClick={() => close()}>
                {pending ? "waiting for the last transaction…" : "close session"}
              </button>
              {blocked && (
                <button className="link" disabled={!isOwner || busy || Boolean(pending)} onClick={() => close(true)}>
                  close anyway, forfeit the unreleased article
                </button>
              )}
            </div>
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
