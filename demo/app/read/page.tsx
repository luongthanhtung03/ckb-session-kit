import type { Metadata } from "next";
import ClientOnly from "../ClientOnly";

export const metadata: Metadata = {
  title: "pay-per-read · ckb-session-kit",
  description: "Unlock articles for 1 CKB each: one wallet signature, then no popups — CKB testnet",
};

export default function Page() {
  return <ClientOnly page="read" />;
}
