import type { Metadata } from "next";
import ClientOnly from "../ClientOnly";

export const metadata: Metadata = {
  title: "pay-per-read in tokens · ckb-session-kit",
  description: "Unlock articles for 2 units of an xUDT token: one wallet signature, then no popups — CKB testnet",
};

export default function Page() {
  return <ClientOnly page="tokens" />;
}
