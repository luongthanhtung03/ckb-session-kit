"use client";

import { ccc } from "@ckb-ccc/connector-react";
import { useMemo } from "react";
import SessionDemo from "./SessionDemo";

/** Wallet connection for the session owner: CCC's standard picker, on testnet. */
export default function Root() {
  const client = useMemo(() => new ccc.ClientPublicTestnet(), []);
  return (
    <ccc.Provider defaultClient={client} name="ckb-session-kit" icon="/icon.svg">
      <SessionDemo />
    </ccc.Provider>
  );
}
