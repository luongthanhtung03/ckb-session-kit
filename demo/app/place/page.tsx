import type { Metadata } from "next";
import ClientOnly from "../ClientOnly";

export const metadata: Metadata = {
  title: "place · ckb-session-kit",
  description: "A shared pixel board on CKB testnet: one wallet signature, then 0.1 CKB a pixel with no popups",
};

export default function Page() {
  return <ClientOnly page="place" />;
}
