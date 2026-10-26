"use client";

import { ccc } from "@ckb-ccc/connector-react";
import { useMemo } from "react";
import PayPerMinute from "./listen/PayPerMinute";
import Place from "./place/Place";
import PayPerRead from "./read/PayPerRead";
import PayPerReadTokens from "./tokens/PayPerReadTokens";
import SessionDemo from "./SessionDemo";
import Subscribe from "./subscribe/Subscribe";

export type PageName = "wallet" | "read" | "tokens" | "place" | "listen" | "subscribe";

/** Wallet connection for the session owner: CCC's standard picker, on testnet. */
export default function Root({ page }: { page: PageName }) {
  const client = useMemo(() => new ccc.ClientPublicTestnet(), []);
  return (
    <ccc.Provider defaultClient={client} name="ckb-session-kit" icon="/icon.svg">
      {page === "read" ? (
        <PayPerRead />
      ) : page === "tokens" ? (
        <PayPerReadTokens />
      ) : page === "place" ? (
        <Place />
      ) : page === "listen" ? (
        <PayPerMinute />
      ) : page === "subscribe" ? (
        <Subscribe />
      ) : (
        <SessionDemo />
      )}
    </ccc.Provider>
  );
}
