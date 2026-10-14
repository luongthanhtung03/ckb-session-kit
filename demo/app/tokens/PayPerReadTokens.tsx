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
import { ckb, describeFailure, explorerAddr, explorerTx, Footer, Log, Nav, short, type LogEntry } from "../shared";
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
/** Article id → its payment, the session key that paid (only it can claim), and the released text. */
type Entry = { tx: string; key?: string; body?: string[] };
type Unlocked = Record<string, Entry>;

function loadUnlocked(): Unlocked {
  try {
    const raw = JSON.parse(localStorage.getItem(UNLOCKED_KEY) ?? "{}");
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "object" && v !== null)) as Unlocked;
  } catch {
    return {};
  }
}

/** Read-modify-write, so a second tab's records are kept. */
function recordUnlocked(u: Unlocked, id: string, entry: Entry): Unlocked {
  const next = { ...u, ...loadUnlocked(), [id]: entry };
  try {
    localStorage.setItem(UNLOCKED_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the unlock still holds for this visit
  }
  return next;
}

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

  const push = (e: Omit<LogEntry, "at">) => setLog((l) => [{ at: new Date(), ...e }, ...l]);

  useEffect(() => {
    setUnlocked(loadUnlocked());
    store
      .load()
      .then((s) => {
        setSession(s);
        if (s) push({ level: "info", text: "restored token session from IndexedDB" });
      })
      .finally(() => setLoading(false));
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
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
    signer.getRecommendedAddressObj().then((a) => {
      setOwnerAddress(a.toString());
      setOwnerLock(a.script);
    });
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

  // Each step spends the cells the previous one created, so it waits for the last to confirm.
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

  // Paid but not yet released: once committed, prove to the server that this key paid.
  const claiming = useRef(new Set<string>());
  useEffect(() => {
    if (!session) return;
    for (const [id, { tx, key, body }] of Object.entries(unlocked)) {
      if (body || tx === pending || claiming.current.has(id)) continue;
      if (key && key !== session.publicKey) continue;
      claiming.current.add(id);
      (async () => {
        try {
          const proof = await signAccess(session, tx as ccc.Hex, paymentMemo(memoLabel(id)));
          const res = await fetch("/api/article-token", { method: "POST", body: JSON.stringify({ id, proof }) });
          const data = await res.json();
          if (!res.ok) {
            push({ level: "err", text: `server refused “${id}”: ${data.error}` });
            return;
          }
          setUnlocked((u) => recordUnlocked(u, id, { tx, key, body: data.body }));
          push({ level: "ok", text: `server checked the token payment on-chain and released “${id}”` });
        } catch (e) {
          push(describeFailure(e));
        } finally {
          claiming.current.delete(id);
        }
      })();
    }
  }, [session, unlocked, pending]);

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
      let saved = false;
      try {
        // Saved before the funds are sent: a key that exists nowhere would lose them.
        const { txHash, binding } = await openSession(signer, draft, deployment, {
          budget: BUDGET,
          token: { type: token, amount: toPut, maxPerTx: MAX_UNITS_PER_TX },
          beforeSend: async (b) => {
            await store.save({ ...draft, onchain: b });
            saved = true;
          },
        });
        setSession({ ...draft, onchain: binding });
        setPending(txHash);
        push({ level: "ok", text: `token session opened with ${toPut} units · it can only pay the creator`, hash: txHash });
      } catch (e) {
        if (saved) await store.clear(draft);
        throw e;
      }
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
        token: PRICE_UNITS,
        topUp: true,
        memo: paymentMemo(memoLabel(id)),
      });
      setPending(hash);
      setUnlocked((u) => recordUnlocked(u, id, { tx: hash, key: session.publicKey }));
      push({ level: "ok", text: `paid ${PRICE_UNITS} tokens for “${title}” · session key only, no wallet popup`, hash });
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
      if (Object.values(unlocked).some((e) => !e.body && e.key === session.publicKey)) {
        push({ level: "err", text: "an article you paid for is not released yet; close once it is" });
        return;
      }
      push({ level: "info", text: "waiting for your wallet to sweep the tokens and CKB, then returning the key cell…" });
      const { keyTx, sweepTx, keyError } = await closeSession(signer, session, deployment, session.onchain);
      if (sweepTx) push({ level: "ok", text: "unspent tokens and CKB swept back to you", hash: sweepTx });
      if (keyTx) push({ level: "ok", text: "key cell returned to you", hash: keyTx });
      if (keyError) {
        push({ level: "err", text: `key cell not returned: ${keyError}` });
        return;
      }
      await store.clear(session);
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
          enforces the limits: only this creator, at most {MAX_UNITS_PER_TX.toString()} tokens per payment, and
          not one shannon of the session&apos;s CKB.
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
                  a 100 CKB key cell for fees. Tokens and CKB all come back when you close. Needs ~400 testnet
                  CKB: <a href="https://faucet.nervos.org/">faucet</a>.
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
