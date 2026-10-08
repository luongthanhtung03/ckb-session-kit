"use client";

import dynamic from "next/dynamic";
import type { PageName } from "./Root";

// The session key lives only in the browser (IndexedDB). Rendering the demo on
// the client only keeps it out of server rendering entirely.
const Root = dynamic(() => import("./Root"), {
  ssr: false,
  loading: () => (
    <main className="wrap">
      <span className="cursor" />
    </main>
  ),
});

export default function ClientOnly({ page = "wallet" }: { page?: PageName }) {
  return <Root page={page} />;
}
