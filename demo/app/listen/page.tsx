import type { Metadata } from "next";
import ClientOnly from "../ClientOnly";

export const metadata: Metadata = {
  title: "pay-per-minute · ckb-session-kit",
  description: "Pay a creator 0.5 CKB a minute while a track plays: one wallet signature, then no popups — CKB testnet",
};

export default function Page() {
  return <ClientOnly page="listen" />;
}
