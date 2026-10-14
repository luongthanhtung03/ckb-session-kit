"use client";

import { ccc, useCcc, useSigner } from "@ckb-ccc/connector-react";
import {
  applyPlacements,
  closeSession,
  createSession,
  encodePlacement,
  findSessionCells,
  indexedDbStore,
  isActive,
  openSession,
  placementPrice,
  ScopeError,
  SessionBalanceError,
  SessionStoreConflict,
  spendInSession,
  type Pixel,
  type Session,
  type SessionCells,
  type SessionLockDeployment,
} from "ckb-session-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import deploymentJson from "../../../deployment/testnet.json";
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
} from "../shared";
import { Prompt, Terminal } from "../Terminal";
import { emptyScan, scanBoard, type BoardScan } from "./chain";
import { BOARD, BOARD_READY, PALETTE, PLACE } from "./config";

const deployment = deploymentJson as SessionLockDeployment;
// Its own slot, so it never touches the sessions of the other pages.
const store = indexedDbStore(undefined, "place");

const CKB = 100_000_000n;
const BUDGET = 200n * CKB;
/** The largest batch, and nothing more, is what one payment may move. */
const MAX_PER_TX = placementPrice(PLACE.maxPixels, PLACE);
/** A session cell with a recipient occupies this much; it is not spendable. */
const CELL_RESERVE = 153n * CKB;
const POLL_MS = 10_000;

type Tool = number | "inspect";
/** A payment sent and not yet committed: its pixels show as pending. */
type Sent = { hash: string; pixels: Pixel[] };

export default function Place() {
  const { open, disconnect, client } = useCcc();
  const signer = useSigner();
  const [ownerAddress, setOwnerAddress] = useState<string>();
  const [ownerLockHash, setOwnerLockHash] = useState<string>();
  const [session, setSession] = useState<Session>();
  const [cells, setCells] = useState<SessionCells>();
  const [scan, setScan] = useState<BoardScan>(emptyScan);
  const [synced, setSynced] = useState(false);
  const [drafts, setDrafts] = useState<Pixel[]>([]);
  const [sent, setSent] = useState<Sent>();
  const [tool, setTool] = useState<Tool>(5);
  const [hover, setHover] = useState<number>();
  const [pinned, setPinned] = useState<number>();
  const [pending, setPending] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());

  const push = (e: Omit<LogEntry, "at">) => setLog((l) => [{ at: new Date(), ...e }, ...l]);

  useEffect(() => {
    store
      .load()
      .then((s) => {
        setSession(s);
        if (s) push({ level: "info", text: "restored painting session from IndexedDB" });
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
    signer.getRecommendedAddressObj().then((a) => {
      setOwnerAddress(a.toString());
      setOwnerLockHash(a.script.hash());
    });
  }, [signer]);

  // The board, read from the chain. One read at a time; each picks up where the last stopped.
  const scanRef = useRef(scan);
  const syncing = useRef<Promise<void> | undefined>(undefined);
  const syncError = useRef(false);
  const sync = useCallback((): Promise<void> => {
    syncing.current ??= (async () => {
      try {
        const { script } = await ccc.Address.fromString(BOARD, client);
        const next = await scanBoard(client, script, PLACE, scanRef.current);
        scanRef.current = next;
        setScan(next);
        setSynced(true);
        syncError.current = false;
      } catch (e) {
        // Logged once per outage, not every poll.
        if (!syncError.current) push({ level: "err", text: `reading the board failed, retrying: ${String(e).slice(0, 160)}` });
        syncError.current = true;
      } finally {
        syncing.current = undefined;
      }
    })();
    return syncing.current;
  }, [client]);

  useEffect(() => {
    sync();
    const t = setInterval(sync, POLL_MS);
    return () => clearInterval(t);
  }, [sync]);

  const refreshCells = useCallback(async () => {
    setCells(session?.onchain ? await findSessionCells(session, client, deployment, session.onchain) : undefined);
  }, [client, session]);

  useEffect(() => {
    refreshCells();
    const t = setInterval(refreshCells, POLL_MS);
    return () => clearInterval(t);
  }, [refreshCells]);

  const sentRef = useRef(sent);
  useEffect(() => {
    sentRef.current = sent;
  }, [sent]);

  // Each payment spends the session cell the previous one created, so commits
  // wait for the last one to confirm. Its pixels stay pending until the board shows them.
  useEffect(() => {
    if (!pending) return;
    const since = Date.now();
    let done = false;
    const t = setInterval(async () => {
      const state = await paymentState(client, pending, since);
      if (state === "waiting" || done) return;
      done = true;
      if (state === "committed") {
        await sync();
        setPending(undefined);
        setSent((s) => (s?.hash === pending ? undefined : s));
        push({ level: "info", text: `confirmed ${short(pending)}` });
        refreshCells();
      } else {
        // Rejected, or gone from the node (usually another player spent the same board cell): paint it again.
        setPending(undefined);
        const lost = sentRef.current;
        if (lost?.hash === pending) {
          setSent(undefined);
          setDrafts((ds) => [...lost.pixels.filter((p) => !ds.some((d) => d.x === p.x && d.y === p.y)), ...ds].slice(0, PLACE.maxPixels));
        }
        push({ level: "err", text: `${short(pending)} never committed; its pixels are back in your batch, commit again` });
        refreshCells();
      }
    }, 4000);
    return () => {
      done = true;
      clearInterval(t);
    };
  }, [client, pending, sync, refreshCells]);

  const board = useMemo(() => applyPlacements(scan.placements, PLACE), [scan]);
  const draftAt = useMemo(() => byIndex(drafts), [drafts]);
  const sentAt = useMemo(() => byIndex(sent?.pixels ?? []), [sent]);
  const painted = board.filter(Boolean).length;
  const lastBlock = scan.placements.reduce((m, p) => (p.blockNumber > m ? p.blockNumber : m), 0n);

  const active = session?.onchain && isActive(session, now);
  const spendable = cells ? (cells.balance > CELL_RESERVE ? cells.balance - CELL_RESERVE : 0n) : undefined;
  const cost = placementPrice(drafts.length, PLACE);
  const isOwner = Boolean(
    session?.onchain && ownerLockHash && ccc.Script.from(session.onchain.ownerLock).hash() === ownerLockHash,
  );

  /** Paint (or with the inspect tool, pin) square `i`. `toggle`: a click on a draft of the same colour removes it. */
  function paint(i: number, toggle: boolean) {
    if (tool === "inspect") {
      setPinned(i);
      return;
    }
    const x = i % PLACE.width;
    const y = Math.floor(i / PLACE.width);
    setDrafts((ds) => {
      const at = ds.findIndex((d) => d.x === x && d.y === y);
      if (at >= 0) {
        if (ds[at].colour === tool) return toggle ? ds.filter((_, j) => j !== at) : ds;
        return ds.map((d, j) => (j === at ? { x, y, colour: tool } : d));
      }
      // Already that colour on-chain: painting it again would pay for nothing.
      if (board[i]?.colour === tool || ds.length >= PLACE.maxPixels) return ds;
      return [...ds, { x, y, colour: tool }];
    });
  }

  async function openPainting() {
    if (!signer) return;
    setBusy(true);
    try {
      const draft = createSession({
        expiresAt: new Date(Date.now() + 60 * 60_000),
        scope: { maxPerTx: MAX_PER_TX, recipients: [BOARD] },
      });
      push({ level: "info", text: "waiting for your wallet to sign the funding transaction…" });
      // Saved before the funds are sent: a key that exists nowhere would lose them.
      const opened = await openKept(client, store, draft, (beforeSend) =>
        openSession(signer, draft, deployment, { budget: BUDGET, beforeSend }),
      );
      setSession(opened.session);
      setPending(opened.txHash);
      if (opened.error) {
        push({ level: "err", text: `${describeFailure(opened.error).text} · ${FUNDING_UNSURE}`, hash: opened.txHash });
      } else {
        push({ level: "ok", text: "painting session opened · it can only pay the board", hash: opened.txHash });
      }
    } catch (e) {
      if (e instanceof SessionStoreConflict) {
        push({ level: "err", text: "another tab already holds a painting session; reload this page" });
      } else {
        push(describeFailure(e));
      }
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!session?.onchain || !drafts.length) return;
    setBusy(true);
    const pixels = drafts;
    let sentHash = undefined as string | undefined; // set in a callback: not narrowed
    try {
      const hash = await spendInSession(session, client, deployment, session.onchain, {
        to: BOARD,
        amount: placementPrice(pixels.length, PLACE),
        topUp: true,
        memo: encodePlacement(pixels, PLACE),
        // Pending before it is sent: a payment that goes out is always tracked.
        beforeSend: async (h) => {
          sentHash = h;
          setPending(h);
          setSent({ hash: h, pixels });
        },
      });
      setDrafts((ds) => ds.filter((d) => !pixels.includes(d)));
      push({
        level: "ok",
        text: `placed ${pixels.length} pixel(s) for ${ckb(placementPrice(pixels.length, PLACE))} · session key only, no wallet popup`,
        hash,
      });
    } catch (e) {
      if (sentHash) {
        const h = sentHash;
        if (await neverSent(client, h)) {
          // Never left: the pixels are still in the batch.
          setPending((p) => (p === h ? undefined : p));
          setSent((s) => (s?.hash === h ? undefined : s));
        } else {
          // The node may have it: track it as sent, and the poll settles it.
          setDrafts((ds) => ds.filter((d) => !pixels.includes(d)));
        }
      }
      push(describePlaceFailure(e));
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!signer || !session?.onchain || pending) return;
    setBusy(true);
    try {
      push({ level: "info", text: "waiting for your wallet to sweep the balance, then returning the key cell…" });
      const { forget, lines } = describeClose(
        await closeSession(signer, session, deployment, session.onchain),
        "unspent balance swept back to you",
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
      setBusy(false);
    }
  }

  const shown = pinned ?? hover;

  return (
    <main className="wrap">
      <Nav here="place" />
      <Terminal client={client} title="ckb-session-kit — place">
        <h1>
          <span className="dim">[</span> place <span className="dim">]</span>{" "}
          <span className="dim">
            :: {PLACE.width}×{PLACE.height} :: {ckb(PLACE.price)} a pixel :: testnet
          </span>
        </h1>
        <p className="lede">
          A shared pixel board on CKB. Your wallet signs <strong>once</strong> to open a session; each pixel
          then costs {ckb(PLACE.price)}, paid by a key held in this browser with <strong>no popup</strong>.
          Paint up to {PLACE.maxPixels} pixels and commit them in one payment. The session can only ever pay
          the board.
        </p>
        <p className="note">
          # each payment tops up one of the board&apos;s <a href={explorerAddr(BOARD)}>anyone-can-pay cells</a> and
          lists its pixels in a memo the session key signs. The board is rebuilt from those transactions,
          in chain order, by this page: no server, no database. Last write wins.
        </p>
        {!BOARD_READY && (
          <p className="note warn">
            # the board is not set up yet: this page points at a placeholder address. Run{" "}
            <code>npm run setup:board</code> and put the address it prints in <code>demo/app/place/config.ts</code>.
          </p>
        )}

        <section className="block">
          <h2>player</h2>
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
        ) : !session?.onchain ? (
          <section className="block">
            <h2>open painting session</h2>
            <Prompt path="~">
              session open --budget 200CKB --max {ccc.fixedPointToString(MAX_PER_TX)}CKB --allow {short(BOARD)} --expires 60m
            </Prompt>
            <p className="hint">
              # 200 CKB into the session (153 stay as the cell&apos;s own storage, 47 are spendable: 470 pixels)
              plus a ~62–64 CKB key cell for fees (sized to your wallet&apos;s lock). Everything unspent comes back
              when you close. Needs ~265 testnet CKB: <a href="https://faucet.nervos.org/">faucet</a>.
            </p>
            <button disabled={!signer || busy || !BOARD_READY} onClick={openPainting}>
              {!BOARD_READY
                ? "board not set up yet"
                : !signer
                  ? "connect a wallet first"
                  : busy
                    ? "waiting for wallet…"
                    : "open session (1 signature) ⏎"}
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
                  · {spendable === undefined ? "…" : (spendable / PLACE.price).toString()} pixels left
                </span>
              </dd>
              <dt>fees</dt>
              <dd>
                {cells ? ckb(cells.feeBalance) : "…"} <span className="dim">in the key cell</span>
              </dd>
            </dl>
            {pending && (
              <p className="hint">
                waiting for <a href={explorerTx(pending)}>{short(pending)}</a> to confirm before the next commit…{" "}
                <span className="cursor" />
              </p>
            )}
          </section>
        )}

        <section className="block">
          <h2>board</h2>
          <Prompt path="~/place">
            place status <span className="dim">--every {POLL_MS / 1000}s</span>
          </Prompt>
          <p className="hint">
            {synced ? (
              <>
                # {scan.placements.length} placement(s) · {painted}/{board.length} squares painted
                {lastBlock > 0n && <> · last at block #{lastBlock.toLocaleString("en-US")}</>}
              </>
            ) : (
              <>
                # reading the board from the chain… <span className="cursor" />
              </>
            )}
          </p>

          <div className="palette" role="radiogroup" aria-label="colour">
            {PALETTE.map((c, i) => (
              <button
                key={c}
                role="radio"
                aria-checked={tool === i}
                aria-label={`colour ${i}`}
                className={`swatch${tool === i ? " on" : ""}`}
                style={{ background: c }}
                onClick={() => setTool(i)}
              />
            ))}
            <button className={`tool${tool === "inspect" ? " on" : ""}`} onClick={() => setTool("inspect")}>
              inspect
            </button>
          </div>

          <div
            className="board"
            style={{ gridTemplateColumns: `repeat(${PLACE.width}, 1fr)`, aspectRatio: `${PLACE.width} / ${PLACE.height}` }}
            onMouseLeave={() => setHover(undefined)}
          >
            {board.map((px, i) => {
              const draft = draftAt.get(i);
              const queued = sentAt.get(i);
              const colour = draft ?? queued ?? px?.colour;
              const state = draft !== undefined ? " draft" : queued !== undefined ? " sent" : "";
              return (
                <div
                  key={i}
                  className={`px${state}${pinned === i ? " pinned" : ""}`}
                  style={colour === undefined ? undefined : { background: PALETTE[colour] }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    paint(i, true);
                  }}
                  onPointerEnter={(e) => {
                    setHover(i);
                    if (e.pointerType === "mouse" && e.buttons === 1) paint(i, false);
                  }}
                />
              );
            })}
          </div>

          <p className="hint inspector">
            {shown === undefined ? (
              "# hover a square to see who placed it; the inspect tool pins it"
            ) : (
              <Inspect i={shown} px={board[shown]} draft={draftAt.get(shown)} queued={sentAt.get(shown)} />
            )}
            {pinned !== undefined && (
              <>
                {" "}
                <button className="link" onClick={() => setPinned(undefined)}>
                  unpin
                </button>
              </>
            )}
          </p>

          <Prompt path="~/place">
            place commit <span className="dim">--pixels {drafts.length}/{PLACE.maxPixels}</span>
          </Prompt>
          <p className="hint">
            # {drafts.length ? `${drafts.length} pixel(s) painted here, not sent: ${ckb(cost)} in one payment` : "click the board to paint; nothing is sent until you commit"}
            {drafts.length >= PLACE.maxPixels && " · batch full, commit first"}
          </p>
          <div className="row">
            <button
              disabled={!active || busy || !drafts.length || Boolean(pending) || (spendable !== undefined && cost > spendable)}
              onClick={commit}
            >
              {!session?.onchain
                ? "open a session to commit"
                : pending
                  ? "waiting for the last payment…"
                  : busy
                    ? "signing…"
                    : `commit ${drafts.length} pixel(s) for ${ckb(cost)} ⏎`}
            </button>
            <button className="link" disabled={!drafts.length || busy} onClick={() => setDrafts([])}>
              discard
            </button>
          </div>
        </section>

        {session?.onchain && (
          <section className="block">
            <h2>close</h2>
            <Prompt path="~/session">session close --return-to player</Prompt>
            <p className="hint">
              # returns the key cell and the unspent balance to your wallet. One signature
              {isOwner ? "." : " — connect the wallet that opened it first."}
            </p>
            <button className="danger" disabled={!isOwner || busy || Boolean(pending)} onClick={close}>
              {pending ? "waiting for the last transaction…" : "close session"}
            </button>
          </section>
        )}

        <Log entries={log} />
      </Terminal>
      <Footer />
    </main>
  );
}

/** One line about a square: what is on-chain, and what this page has not sent or not confirmed yet. */
function Inspect({ i, px, draft, queued }: { i: number; px?: { colour: number; txHash: string; blockNumber: bigint }; draft?: number; queued?: number }) {
  const x = i % PLACE.width;
  const y = Math.floor(i / PLACE.width);
  return (
    <>
      ({x}, {y}){" "}
      {px ? (
        <>
          colour {px.colour} · placed in <a href={explorerTx(px.txHash)}>{short(px.txHash)}</a> · block #
          {px.blockNumber.toLocaleString("en-US")}
        </>
      ) : (
        "empty"
      )}
      {queued !== undefined && <span className="warn"> · colour {queued} sent, confirming</span>}
      {draft !== undefined && <span className="warn"> · colour {draft} painted here, not sent</span>}
    </>
  );
}

/** Square index → colour, for a list of pixels; a later entry wins. */
function byIndex(pixels: Pixel[]): Map<number, number> {
  return new Map(pixels.map((p) => [p.y * PLACE.width + p.x, p.colour]));
}

/** Players racing for the same board cell lose with a dead or unknown input: say so plainly. */
function describePlaceFailure(e: unknown): { level: "err"; text: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (!(e instanceof ScopeError || e instanceof SessionBalanceError) && /Dead|Unknown|Resolve|Conflict|RBF/i.test(msg)) {
    return { level: "err", text: "another player used the same board cell first; your pixels are kept, commit again" };
  }
  return describeFailure(e);
}

function remaining(s: Session, now: Date): string {
  const ms = Math.max(0, s.policy.expiresAt.getTime() - now.getTime());
  const m = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${m}m${sec.toString().padStart(2, "0")}s`;
}
