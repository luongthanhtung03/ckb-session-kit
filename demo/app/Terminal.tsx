"use client";

import { ccc } from "@ckb-ccc/core";
import { useEffect, useState } from "react";

/** Live testnet tip, polled — the page is talking to a real chain. */
function useTip(client: ccc.Client) {
  const [tip, setTip] = useState<bigint>();
  const [down, setDown] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const n = await client.getTip();
        if (alive) {
          setTip(n);
          setDown(false);
        }
      } catch {
        if (alive) setDown(true);
      }
    };
    poll();
    const t = setInterval(poll, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [client]);
  return { tip, down };
}

export function Terminal({
  client,
  title,
  children,
}: {
  client: ccc.Client;
  title: string;
  children: React.ReactNode;
}) {
  const { tip, down } = useTip(client);
  return (
    <div className="term">
      <div className="titlebar">
        <span className="dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="title">{title}</span>
        <span className="chain" title="CKB public testnet (Pudge)">
          <span className={`pulse${down ? " off" : ""}`} />
          {down ? "rpc unreachable" : tip === undefined ? "connecting…" : `testnet #${tip.toLocaleString("en-US")}`}
        </span>
      </div>
      <div className="screen">{children}</div>
    </div>
  );
}

export function Prompt({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <p className="cmdline">
      <span className="prompt">
        builder@ckb:<span className="path">{path}</span>$
      </span>{" "}
      <span className="cmd">{children}</span>
    </p>
  );
}
