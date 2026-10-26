import type { Metadata } from "next";
import ClientOnly from "../ClientOnly";

export const metadata: Metadata = {
  title: "subscribe · ckb-session-kit",
  description: "A subscription the creator charges once per period while you are offline, and you cancel alone — CKB testnet",
};

export default function Page() {
  return <ClientOnly page="subscribe" />;
}
