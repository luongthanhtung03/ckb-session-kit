"use client";

import { ccc, useCcc, useSigner } from "@ckb-ccc/connector-react";
import {
  cancelSubscription,
  findSubscriptionCells,
  openSubscription,
  type SessionLockDeployment,
  type Subscription,
} from "ckb-session-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import deploymentJson from "../../../deployment/testnet.json";
import { ckb, describeFailure, explorerAddr, explorerTx, Footer, Log, Nav, short, type LogEntry } from "../shared";
import { Prompt, Terminal } from "../Terminal";
import { BUDGET, CHARGER, PAY_TO, PERIOD_BLOCKS, PRICE } from "./config";
import { termsFor } from "./terms";

const deployment = deploymentJson as SessionLockDeployment;

/**
 * What this browser keeps per wallet: the opening's hash and the account id it
 * committed to. No key: the subscription is plain data, and the account id is
 * what proves to the server that this subscription is ours.
 */
type Kept = { openTx: string; account: string };
const keyFor = (lockHash: string) => `ckb-session-kit:subscribe:${lockHash}`;

function loadKept(lockHash: string): Kept | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(keyFor(lockHash)) ?? "null");
    return v && typeof v.openTx === "string" && typeof v.account === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

function saveKept(lockHash: string, kept: Kept | undefined): void {
  try {
    if (kept) localStorage.setItem(keyFor(lockHash), JSON.stringify(kept));
    else localStorage.removeItem(keyFor(lockHash));
  } catch {
    // storage blocked: the subscription still exists on-chain; cancel works without it
  }
}

type Status = {
  paidThroughBlock?: string;
  tip: string;
  active: boolean;
  balance: string;
  chargesLeft: string;
  nextChargeIn?: string;
};
type Note = { title: string; body: string };

export default function Subscribe() {
  const { open, disconnect, client } = useCcc();
  const signer = useSigner();
  const [address, setAddress] = useState<string>();
  const [lockHash, setLockHash] = useState<ccc.Hex>();
  const [sub, setSub] = useState<Subscription>();
  const [kept, setKept] = useState<Kept>();
  /** CKB still under this wallet's subscription lock, whatever this browser remembers. */
  const [onchain, setOnchain] = useState<bigint>();
  const [status, setStatus] = useState<Status>();
  const [notes, setNotes] = useState<Note[]>();
  const [refused, setRefused] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const charging = useRef(false);

  const push = (e: Omit<LogEntry, "at">) => setLog((l) => [{ at: new Date(), ...e }, ...l]);

  useEffect(() => {
    // Another wallet, or none: nothing of the last one's stays on screen.
    setStatus(undefined);
    setNotes(undefined);
    setRefused(undefined);
    setOnchain(undefined);
    if (!signer) {
      setAddress(undefined);
      setLockHash(undefined);
      setSub(undefined);
      setKept(undefined);
      return;
    }
    signer.getRecommendedAddressObj().then(async (a) => {
      const hash = a.script.hash();
      setAddress(a.toString());
      setLockHash(hash);
      setSub(await termsFor(client, hash));
      setKept(loadKept(hash));
    });
  }, [signer, client]);

  const refresh = useCallback(async () => {
    if (!sub) return;
    const cells = await findSubscriptionCells(client, deployment, sub).catch(() => undefined);
    if (cells) setOnchain(cells.balance);
    if (!kept) {
      setStatus(undefined);
      setNotes(undefined);
      return;
    }
    const res = await fetch("/api/subscription", {
      method: "POST",
      body: JSON.stringify({ subscriber: sub.subscriberLockHash, openTx: kept.openTx, account: kept.account }),
    }).catch(() => undefined);
    if (!res) return;
    const data = (await res.json()) as { status?: Status; notes?: Note[]; error?: string };
    if (res.ok && data.status) {
      setStatus(data.status);
      setNotes(data.notes);
      setRefused(undefined);
    } else if (res.status === 402) {
      setStatus(undefined);
      setNotes(undefined);
      setRefused(data.error);
    }
  }, [client, sub, kept]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  // A renewal is due: the period is over and the cell is a period old. A real
  // creator charges on a schedule; here the page asks the creator's server to.
  useEffect(() => {
    if (!sub || !status || busy || status.active || status.nextChargeIn !== "0" || status.chargesLeft === "0") return;
    if (charging.current) return;
    charging.current = true;
    (async () => {
      push({ level: "info", text: "period over: asking the creator's server to charge the next one…" });
      try {
        const res = await fetch("/api/subscription/charge", {
          method: "POST",
          body: JSON.stringify({ subscriber: sub.subscriberLockHash }),
        });
        const data = (await res.json()) as { txHash?: string; error?: string };
        if (data.txHash) push({ level: "ok", text: `the creator charged ${ckb(PRICE)} · no wallet involved`, hash: data.txHash });
        else push({ level: res.status === 409 ? "info" : "err", text: `no charge: ${data.error}` });
      } catch (e) {
        push(describeFailure(e));
      } finally {
        // One request per renewal; the next poll shows the new period.
        setTimeout(() => (charging.current = false), 60_000);
      }
    })();
  }, [sub, status, busy]);

  async function subscribe() {
    if (!signer || !lockHash) return;
    setBusy(true);
    try {
      const account = ccc.hexFrom(crypto.getRandomValues(new Uint8Array(32)));
      push({ level: "info", text: "waiting for your wallet to sign the opening…" });
      const { txHash } = await openSubscription(signer, deployment, {
        charger: CHARGER,
        payTo: PAY_TO,
        price: PRICE,
        periodBlocks: PERIOD_BLOCKS,
        budget: BUDGET,
        account,
        // Kept before it is sent: the account id is what proves the subscription is ours.
        beforeSend: async (s) => {
          const k = { openTx: s.openTx!, account };
          saveKept(lockHash, k);
          setKept(k);
        },
      });
      push({ level: "ok", text: `subscribed · first period paid (${ckb(PRICE)})`, hash: txHash });
      refresh();
    } catch (e) {
      push(describeFailure(e));
    } finally {
      setBusy(false);
    }
  }

  /** An opening that never landed (sent and lost, or refused): forget it and offer subscribing again. */
  function forget() {
    if (!lockHash) return;
    saveKept(lockHash, undefined);
    setKept(undefined);
    setRefused(undefined);
    push({ level: "info", text: "forgot the opening that never landed; nothing was paid" });
  }

  async function cancel() {
    if (!signer || !sub || !lockHash) return;
    setBusy(true);
    try {
      push({ level: "info", text: "waiting for your wallet to sweep the subscription back…" });
      const r = await cancelSubscription(signer, deployment, sub);
      if (r.nothingFound) push({ level: "info", text: "nothing left under the subscription" });
      else push({ level: "ok", text: `cancelled · ${ckb(r.refunded)} back to your wallet`, hash: r.txHash });
      saveKept(lockHash, undefined);
      setKept(undefined);
      setStatus(undefined);
      setNotes(undefined);
      setOnchain(undefined);
    } catch (e) {
      push(describeFailure(e));
    } finally {
      setBusy(false);
    }
  }

  const left = status?.paidThroughBlock ? BigInt(status.paidThroughBlock) - BigInt(status.tip) : undefined;
  const open_ = Boolean(onchain && onchain > 0n);

  return (
    <main className="wrap">
      <Nav here="subscribe" />
      <Terminal client={client} title="ckb-session-kit — subscribe">
        <h1>
          <span className="dim">[</span> subscribe <span className="dim">]</span>{" "}
          <span className="dim">:: {ckb(PRICE)} per {PERIOD_BLOCKS.toString()} blocks :: testnet</span>
        </h1>
        <p className="lede">
          Your wallet signs <strong>once</strong>. The creator then charges {ckb(PRICE)} every{" "}
          {PERIOD_BLOCKS.toString()} blocks (about 10 minutes) from a cell <strong>you</strong> own, while you are
          offline. The network lets the creator take at most the price, at most once per period, and only to
          the creator. You cancel alone, at any time.
        </p>
        <p className="note">
          # the same session lock as every other page, with the roles moved: the creator&apos;s{" "}
          <a href={explorerAddr(CHARGER)}>charger key</a> holds the session key, the price is the per-payment
          limit, the period is the rate limit. Charges top up the creator&apos;s{" "}
          <a href={explorerAddr(PAY_TO)}>anyone-can-pay cell</a>.
        </p>

        <section className="block">
          <h2>subscriber</h2>
          <Prompt path="~">wallet {signer ? "status" : "connect"}</Prompt>
          {signer ? (
            <dl>
              <dt>wallet</dt>
              <dd>
                {address ? <a href={explorerAddr(address)}>{short(address, 12)}</a> : "…"}{" "}
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

        {signer && !kept && !open_ && (
          <section className="block">
            <h2>subscribe</h2>
            <Prompt path="~">
              subscribe --price {ckb(PRICE).replace(" ", "")} --every {PERIOD_BLOCKS.toString()}blocks --budget{" "}
              {ckb(BUDGET).replace(" ", "")}
            </Prompt>
            <p className="hint">
              # pays the first period now and puts {ckb(BUDGET)} in the subscription cell: 153 CKB is the
              cell&apos;s own storage, the rest pays five more periods. What is left comes back when you cancel.
              Needs ~170 testnet CKB, and keep one more cell in the wallet to cancel with:{" "}
              <a href="https://faucet.nervos.org/">faucet</a>.
            </p>
            <button disabled={busy} onClick={subscribe}>
              {busy ? "waiting for wallet…" : "subscribe (1 signature) ⏎"}
            </button>
          </section>
        )}

        {signer && (kept || open_) && (
          <section className="block">
            <h2>subscription</h2>
            <Prompt path="~/subscription">subscription status</Prompt>
            <dl>
              <dt>state</dt>
              <dd>
                {status?.active ? (
                  <span className="ok">● paid up · {left?.toString()} blocks left in this period</span>
                ) : status ? (
                  <span className="bad">
                    ○ period over
                    {status.chargesLeft === "0"
                      ? " · the subscription has run dry: cancel to take the rest back"
                      : ` · renewal due${status.nextChargeIn && status.nextChargeIn !== "0" ? ` in ${status.nextChargeIn} blocks` : ""}`}
                  </span>
                ) : !kept ? (
                  <span className="bad">
                    ○ opened from another browser: this one does not hold its account id, so the creator will not
                    serve it here. You can still cancel.
                  </span>
                ) : refused ? (
                  <span className="bad">
                    ○ {refused}
                    {!open_ && onchain !== undefined && (
                      <>
                        {" "}
                        <button className="link" onClick={forget}>
                          the opening never landed: forget it
                        </button>
                      </>
                    )}
                  </span>
                ) : (
                  <span className="cursor" />
                )}
              </dd>
              <dt>balance</dt>
              <dd>
                {onchain === undefined ? "…" : ckb(onchain)}
                {status && <span className="dim"> · {status.chargesLeft} charges left</span>}
              </dd>
              {status?.paidThroughBlock && (
                <>
                  <dt>paid through</dt>
                  <dd>
                    block {status.paidThroughBlock} <span className="dim">· tip {status.tip}</span>
                  </dd>
                </>
              )}
              {kept && (
                <>
                  <dt>opened</dt>
                  <dd>
                    <a href={explorerTx(kept.openTx)}>{short(kept.openTx)}</a>
                  </dd>
                </>
              )}
            </dl>
          </section>
        )}

        <section className="block">
          <h2>members&apos; notes</h2>
          {notes ? (
            notes.map((n) => (
              <article key={n.title} className="article open">
                <h3>{n.title}</h3>
                <p>{n.body}</p>
              </article>
            ))
          ) : (
            <article className="article">
              <p className="locked" aria-hidden>
                {"█".repeat(48)} {"█".repeat(36)} {"█".repeat(52)}
              </p>
              <p className="hint">
                # the server sends these only while your subscription is paid up, checked on-chain on every request
              </p>
            </article>
          )}
        </section>

        {signer && (kept || open_) && (
          <section className="block">
            <h2>cancel</h2>
            <Prompt path="~/subscription">subscription cancel</Prompt>
            <p className="hint">
              # sweeps everything left back to your wallet in owner mode. One signature; the creator is not asked.
              Access ends at once.
            </p>
            <button className="danger" disabled={busy || !open_} onClick={cancel}>
              {busy ? "waiting for wallet…" : "cancel subscription"}
            </button>
          </section>
        )}

        <Log entries={log} />
      </Terminal>
      <Footer />
    </main>
  );
}
