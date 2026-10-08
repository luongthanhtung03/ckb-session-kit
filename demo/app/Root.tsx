"use client";

import { ccc } from "@ckb-ccc/connector-react";
import { useMemo } from "react";
import PayPerRead from "./read/PayPerRead";
import SessionDemo from "./SessionDemo";

export type PageName = "wallet" | "read";

/** Wallet connection for the session owner: CCC's standard picker, on testnet. */
export default function Root({ page }: { page: PageName }) {
  const client = useMemo(() => new ccc.ClientPublicTestnet(), []);
  return (
    <ccc.Provider defaultClient={client} name="ckb-session-kit" icon="/icon.svg">
      {page === "read" ? <PayPerRead /> : <SessionDemo />}
    </ccc.Provider>
  );
}
