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
import { CREATOR, memoLabel, PAY_AHEAD, PRICE_PER_MINUTE, TRACK_MINUTES } from "./config";
import { Player, type PlayerStatus } from "./synth";
import { TRACKS, type Segment } from "./tracks";

const deployment = deploymentJson as SessionLockDeployment;
// Its own slot, so it never touches the wallet page's or the reading page's session.
const store = indexedDbStore(undefined, "listen");

const CKB = 100_000_000n;
const MAX_PER_TX = 1n * CKB;
/** A session cell with a recipient occupies this much; it is not spendable. */
const CELL_RESERVE = 153n * CKB;
/** One full track: the change after the last minute is exactly the reserve. */
const BUDGET = CELL_RESERVE + BigInt(TRACK_MINUTES) * PRICE_PER_MINUTE;

const PAID_KEY = "ckb-session-kit:listen:paid";
/**
 * `track:minute` → its payment, the session key that paid (only that key can
 * claim it), and the score once the server has released it. Released minutes
 * stay playable after the session is closed.
 */
type Entry = { tx: string; key: string; segment?: Segment };
type Paid = Record<string, Entry>;
const slot = (track: string, minute: number) => `${track}:${minute}`;
const titleOf = (track: string) => TRACKS.find((t) => t.id === track)?.title ?? track;

function loadPaid(): Paid {
  try {
    const raw = JSON.parse(localStorage.getItem(PAID_KEY) ?? "{}");
    return typeof raw === "object" && raw !== null ? (raw as Paid) : {};
  } catch {
    return {};
  }
}

function savePaid(next: Paid): Paid {
  try {
    localStorage.setItem(PAID_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the minute still plays for this visit
  }
  return next;
}

/** Read-modify-write, so a second tab's records are kept. */
const recordPaid = (p: Paid, id: string, entry: Entry) => savePaid({ ...p, ...loadPaid(), [id]: entry });

/** Forgets the minutes a rejected payment was for: they were never paid. */
const dropPaid = (p: Paid, tx: string) =>
  savePaid(Object.fromEntries(Object.entries({ ...p, ...loadPaid() }).filter(([, e]) => e.tx !== tx)));

export default function PayPerMinute() {
  const { open, disconnect, client } = useCcc();
  const signer = useSigner();
  const [ownerAddress, setOwnerAddress] = useState<string>();
  const [ownerLockHash, setOwnerLockHash] = useState<string>();
  const [session, setSession] = useState<Session>();
  const [cells, setCells] = useState<SessionCells>();
  const [creatorBalance, setCreatorBalance] = useState<bigint>();
  const [paid, setPaid] = useState<Paid>({});
  const [pending, setPending] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());
  const [trackId, setTrackId] = useState(TRACKS[0].id);
  const [status, setStatus] = useState<PlayerStatus>();
  const [levels, setLevels] = useState<number[]>([]);
  /** Why playback stopped on its own: a payment or a release failed. */
  const [halt, setHalt] = useState<string>();
  const [retry, setRetry] = useState(0);

  const player = useRef<Player | undefined>(undefined);
  const paidRef = useRef<Paid>({});
  const paying = useRef(false);

  const push = (e: Omit<LogEntry, "at">) => setLog((l) => [{ at: new Date(), ...e }, ...l]);

  /** Stops playback with a reason; nothing more is paid until the listener presses play. */
  const stop = useCallback((reason: string) => {
    player.current?.pause();
    setHalt(reason);
    push({ level: "err", text: reason });
  }, []);

  useEffect(() => {
    paidRef.current = paid;
  }, [paid]);

  useEffect(() => {
    const stored = loadPaid();
    setPaid(stored);
    store
      .load()
      .then((s) => {
        setSession(s);
        if (!s) return;
        push({ level: "info", text: "restored listening session from IndexedDB" });
        // A payment sent before the reload: wait for it, then claim it.
        const unclaimed = Object.values(stored).filter((e) => !e.segment && e.key === s.publicKey);
        if (unclaimed.length) setPending(unclaimed[unclaimed.length - 1].tx);
      })
      .finally(() => setLoading(false));
    const t = setInterval(() => setNow(new Date()), 1000);
    const p = setInterval(() => {
      if (!player.current) return;
      setStatus(player.current.status());
      setLevels(player.current.levels(24));
    }, 250);
    return () => {
      clearInterval(t);
      clearInterval(p);
      player.current?.dispose();
      player.current = undefined;
    };
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

  // Each payment spends the session cell the previous one created, so the next
  // minute is paid only once the last payment is committed.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      let state: string | undefined;
      try {
        state = (await client.getTransaction(pending))?.status;
      } catch {
        return; // RPC hiccup: ask again
      }
      if (state === "committed") {
        setPending(undefined);
        push({ level: "info", text: `confirmed ${short(pending)}` });
        refresh();
      } else if (state === "rejected") {
        setPending(undefined);
        setPaid((p) => dropPaid(p, pending));
        stop(`payment ${short(pending)} was rejected by the network; nothing was paid`);
        refresh();
      }
    }, 3000);
    return () => clearInterval(t);
  }, [client, pending, refresh, stop]);

  // Paid but not yet released: once the payment is committed, prove to the
  // server that this browser's session key paid for that minute, and get it.
  const claiming = useRef(new Set<string>());
  useEffect(() => {
    if (!session) return;
    for (const [id, { tx, key, segment }] of Object.entries(paid)) {
      if (segment || key !== session.publicKey || tx === pending || claiming.current.has(id)) continue;
      const [track, m] = id.split(":");
      const minute = Number(m);
      claiming.current.add(id);
      (async () => {
        try {
          const proof = await signAccess(session, tx as ccc.Hex, paymentMemo(memoLabel(track, minute)));
          const res = await fetch("/api/segment", { method: "POST", body: JSON.stringify({ track, minute, proof }) });
          const data = await res.json();
          if (!res.ok) {
            stop(`server refused minute ${minute + 1} of “${titleOf(track)}”: ${data.error}`);
            return;
          }
          setPaid((p) => recordPaid(p, id, { tx, key, segment: data.segment }));
          push({ level: "ok", text: `server checked the payment on-chain and released minute ${minute + 1} of “${titleOf(track)}”` });
        } catch (e) {
          stop(describeFailure(e).text);
        } finally {
          claiming.current.delete(id);
        }
      })();
    }
  }, [session, paid, pending, retry, stop]);

  // The meter: while the player wants a minute it does not have, pay for it;
  // PAY_AHEAD seconds before a minute ends, pay for the next one.
  useEffect(() => {
    if (!status || (status.state !== "playing" && status.state !== "waiting")) return;
    if (!session?.onchain || pending || paying.current || halt || !player.current) return;
    const track = player.current.track;
    const owned = (m: number) => {
      const e = paid[slot(track, m)];
      return Boolean(e && (e.segment || e.key === session.publicKey));
    };
    let minute: number | undefined;
    if (!owned(status.minute)) minute = status.minute;
    else if (
      status.state === "playing" &&
      status.offset >= 60 - PAY_AHEAD &&
      status.minute + 1 < TRACK_MINUTES &&
      !owned(status.minute + 1)
    ) {
      minute = status.minute + 1;
    }
    if (minute === undefined) return;
    if (!isActive(session)) {
      stop("session expired: close it to get the unspent CKB back");
      return;
    }
    const binding = session.onchain;
    const memo = paymentMemo(memoLabel(track, minute));
    paying.current = true;
    (async () => {
      try {
        const hash = await spendInSession(session, client, deployment, binding, {
          to: CREATOR,
          amount: PRICE_PER_MINUTE,
          topUp: true,
          memo,
        });
        // Pending first, so the claim waits for the payment to commit.
        setPending(hash);
        setPaid((p) => recordPaid(p, slot(track, minute), { tx: hash, key: session.publicKey }));
        push({
          level: "ok",
          text: `paid ${ckb(PRICE_PER_MINUTE)} for minute ${minute + 1} of “${titleOf(track)}” · session key only, no wallet popup`,
          hash,
        });
      } catch (e) {
        stop(`payment for minute ${minute + 1} failed, playback paused · ${describeFailure(e).text}`);
      } finally {
        paying.current = false;
      }
    })();
  }, [status, session, pending, paid, halt, client, stop]);

  const active = session?.onchain && isActive(session, now);
  const spendable = cells ? (cells.balance > CELL_RESERVE ? cells.balance - CELL_RESERVE : 0n) : undefined;
  const isOwner = Boolean(
    session?.onchain && ownerLockHash && ccc.Script.from(session.onchain.ownerLock).hash() === ownerLockHash,
  );
  const mine = session ? Object.values(paid).filter((e) => e.key === session.publicKey) : [];
  const playing = status?.state === "playing" || status?.state === "waiting";
  const current = player.current?.track ?? trackId;

  function play(track: string) {
    setHalt(undefined);
    setRetry((r) => r + 1);
    let p = player.current;
    if (!p || p.track !== track || p.status().state === "ended") {
      p?.dispose();
      p = new Player(track, (m) => paidRef.current[slot(track, m)]?.segment, TRACK_MINUTES);
      player.current = p;
    }
    setTrackId(track);
    p.play();
    setStatus(p.status());
  }

  function pause() {
    player.current?.pause();
    if (player.current) setStatus(player.current.status());
  }

  async function openListening() {
    if (!signer) return;
    setBusy(true);
    try {
      const draft = createSession({
        expiresAt: new Date(Date.now() + 60 * 60_000),
        scope: { maxPerTx: MAX_PER_TX, recipients: [CREATOR] },
      });
      push({ level: "info", text: "waiting for your wallet to sign the funding transaction…" });
      let saved = false;
      try {
        // Saved before the funds are sent: a key that exists nowhere would lose them.
        const { txHash, binding } = await openSession(signer, draft, deployment, {
          budget: BUDGET,
          beforeSend: async (b) => {
            await store.save({ ...draft, onchain: b });
            saved = true;
          },
        });
        setSession({ ...draft, onchain: binding });
        setPending(txHash);
        push({ level: "ok", text: "listening session opened · it can only pay the creator", hash: txHash });
      } catch (e) {
        if (saved) await store.clear(draft); // never funded
        throw e;
      }
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
      if (paying.current || pending || mine.some((e) => !e.segment)) {
        // Only this session's key can claim its payments; closing would forfeit them.
        push({ level: "err", text: "a minute you paid for is not released yet; close once it is" });
        return;
      }
      push({ level: "info", text: "waiting for your wallet to sweep the balance, then returning the key cell…" });
      const { keyTx, sweepTx, keyError } = await closeSession(signer, session, deployment, session.onchain);
      if (sweepTx) push({ level: "ok", text: "unspent balance swept back to you", hash: sweepTx });
      if (keyTx) push({ level: "ok", text: "key cell returned to you", hash: keyTx });
      if (keyError) {
        // Keep the key: the key cell is still under it. Close again to retry.
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

  const minute = status?.minute ?? 0;
  const offset = status?.offset ?? 0;
  const nextOwned = (() => {
    const e = paid[slot(current, minute + 1)];
    return Boolean(e && (e.segment || e.key === session?.publicKey));
  })();

  return (
    <main className="wrap">
      <Nav here="listen" />
      <Terminal client={client} title="ckb-session-kit — pay-per-minute">
        <h1>
          <span className="dim">[</span> pay-per-minute <span className="dim">]</span>{" "}
          <span className="dim">:: 0.5 CKB a minute while it plays :: testnet</span>
        </h1>
        <p className="lede">
          Your wallet signs <strong>once</strong> to open a listening session. While a track plays, a key held in
          this browser pays the creator 0.5 CKB for each minute, with <strong>no popup</strong>. Pause and the
          payments stop. The session can only ever pay this creator, at most 1 CKB per transaction.
        </p>
        <p className="note">
          # the music is generated in your browser from a score the server releases one minute at a time, and
          only to the key that paid for that minute, checked on-chain. The next minute is paid {PAY_AHEAD} s
          before the current one ends, so a block (~10 s) never interrupts it.
        </p>

        <section className="block">
          <h2>listener</h2>
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
              <span className="dim"> earned so far, reads and minutes (incl. 61 CKB cell)</span>
            </dd>
          </dl>
        </section>

        {loading ? (
          <div className="block">
            <span className="cursor" />
          </div>
        ) : !session?.onchain ? (
          <section className="block">
            <h2>open listening session</h2>
            <Prompt path="~">
              session open --budget {ccc.fixedPointToString(BUDGET)}CKB --max 1CKB --allow {short(CREATOR)} --expires
              60m
            </Prompt>
            <p className="hint">
              # {ccc.fixedPointToString(BUDGET)} CKB into the session (153 stay as the cell&apos;s own storage,{" "}
              {ccc.fixedPointToString(BUDGET - CELL_RESERVE)} pay for {TRACK_MINUTES} minutes) plus a 62 CKB key cell
              for fees. Everything unspent comes back when you close. Needs ~
              {ccc.fixedPointToString(BUDGET + 63n * CKB)} testnet CKB: <a href="https://faucet.nervos.org/">faucet</a>.
            </p>
            <button disabled={!signer || busy} onClick={openListening}>
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
                <span className="dim">
                  {" "}
                  · {spendable === undefined ? "…" : (spendable / PRICE_PER_MINUTE).toString()} minutes left
                </span>
              </dd>
              <dt>fees</dt>
              <dd>
                {cells ? ckb(cells.feeBalance) : "…"} <span className="dim">in the key cell</span>
              </dd>
            </dl>
          </section>
        )}

        <section className="block">
          <h2>player</h2>
          <Prompt path="~/listen">
            play --track {current} --price 0.5CKB/min --pay-ahead {PAY_AHEAD}s
          </Prompt>
          <dl>
            <dt>track</dt>
            <dd>
              {titleOf(current)} <span className="dim">· minute {minute + 1}/{TRACK_MINUTES} · {clock(offset)} / 1:00</span>
            </dd>
            <dt>status</dt>
            <dd>{describeStatus(status, halt, Boolean(session?.onchain), Boolean(pending))}</dd>
            <dt>chord</dt>
            <dd>{status?.chord ?? <span className="dim">—</span>}</dd>
          </dl>
          <p className="levels" aria-hidden>
            {levels.length ? levels.map(bar).join("") : "▁".repeat(24)}
          </p>
          <p className="bar" aria-label={`minute ${minute + 1} of ${TRACK_MINUTES}`}>
            {Array.from({ length: TRACK_MINUTES }, (_, m) => {
              const e = paid[slot(current, m)];
              const cls = m === minute ? "warn" : e?.segment ? "" : e && e.key === session?.publicKey ? "dim" : "empty";
              return (
                <span key={m} className={cls}>
                  {e?.segment ? "█" : e && e.key === session?.publicKey ? "▒" : "░"}
                </span>
              );
            })}
          </p>
          <p className="hint"># █ released · ▒ paid, waiting for the chain · ░ not paid · current minute in amber</p>
          <div className="row">
            {playing ? (
              <button onClick={pause}>pause</button>
            ) : (
              <button onClick={() => play(current)}>{status?.state === "ended" ? "play again" : "play"} ⏎</button>
            )}
          </div>
        </section>

        <section className="block">
          <h2>meter</h2>
          <div className="stat">
            <span className="stat-value">{ckb(BigInt(mine.length) * PRICE_PER_MINUTE)}</span>
            <span className="stat-label">paid this session · {mine.length} minutes</span>
          </div>
          <dl>
            <dt>next payment</dt>
            <dd>{nextPayment(status, nextOwned, Boolean(session?.onchain), Boolean(pending))}</dd>
            <dt>released</dt>
            <dd>
              {mine.filter((e) => e.segment).length} of {mine.length}{" "}
              <span className="dim">· the server checks each payment on-chain before releasing its minute</span>
            </dd>
          </dl>
        </section>

        <section className="block">
          <h2>tracks</h2>
          {TRACKS.map((t) => {
            const owned = Array.from({ length: TRACK_MINUTES }, (_, m) => paid[slot(t.id, m)]?.segment).filter(Boolean).length;
            return (
              <article key={t.id} className={`article${t.id === current ? " open" : ""}`}>
                <h3>{t.title}</h3>
                <p className="dim">
                  {t.mood} · {TRACK_MINUTES} min · {owned} released to you
                </p>
                {t.id !== current && (
                  <button className="link" onClick={() => play(t.id)}>
                    play this track
                  </button>
                )}
              </article>
            );
          })}
          <p className="hint"># minutes already released replay for free, even after the session is closed.</p>
        </section>

        {session?.onchain && (
          <section className="block">
            <h2>close</h2>
            <Prompt path="~/session">session close --return-to listener</Prompt>
            <p className="hint">
              # returns the key cell and the unspent balance to your wallet. One signature
              {isOwner ? "." : " — connect the wallet that opened it first."} Waits until every paid minute is
              released.
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

const LEVELS = "▁▂▃▄▅▆▇█";
const bar = (x: number) => LEVELS[Math.min(LEVELS.length - 1, Math.floor(x * LEVELS.length))];

function clock(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

function describeStatus(status: PlayerStatus | undefined, halt: string | undefined, open: boolean, pending: boolean) {
  if (halt) return <span className="bad">■ paused · {halt}</span>;
  switch (status?.state) {
    case "playing":
      return <span className="ok">● playing</span>;
    case "waiting":
      return open ? (
        <span className="warn">
          … waiting for minute {status.minute + 1}: {pending ? "waiting for the chain (~10 s a block)" : "paying, then the server checks it"}{" "}
          <span className="cursor" />
        </span>
      ) : (
        <span className="warn">… minute {status.minute + 1} is not paid · open a session to keep listening</span>
      );
    case "ended":
      return <span className="dim">■ end of track</span>;
    case "paused":
      return <span className="dim">■ paused · no payments</span>;
    default:
      return <span className="dim">■ stopped · press play</span>;
  }
}

function nextPayment(status: PlayerStatus | undefined, nextOwned: boolean, open: boolean, pending: boolean) {
  if (!open) return <span className="dim">none · no session</span>;
  if (!status || status.state === "paused" || status.state === "ended") return <span className="dim">none while paused</span>;
  if (status.state === "waiting") return <span className="warn">now · minute {status.minute + 1}</span>;
  if (status.minute + 1 >= TRACK_MINUTES) return <span className="dim">none · last minute of the track</span>;
  if (nextOwned) return <span className="ok">minute {status.minute + 2} paid{pending ? ", confirming" : ""}</span>;
  const wait = Math.max(0, Math.ceil(60 - PAY_AHEAD - status.offset));
  return (
    <span className="warn">
      {wait ? `in ${wait}s` : "now"} · {ckb(PRICE_PER_MINUTE)} for minute {status.minute + 2}
    </span>
  );
}

function remaining(s: Session, now: Date): string {
  const ms = Math.max(0, s.policy.expiresAt.getTime() - now.getTime());
  const m = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${m}m${sec.toString().padStart(2, "0")}s`;
}
