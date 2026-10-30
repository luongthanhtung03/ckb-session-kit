import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

// The demo imports the library's compiled output (../dist), exactly as an outside
// app would use the package. The root build runs first, so every deploy shows the
// library at that commit. The workspace root is the repository root.
const root = fileURLToPath(new URL("..", import.meta.url));

// Enforced: the directives that cannot break a page or a wallet. The reading page
// pays without a popup, so no other site may frame it (clickjacking).
const enforced = [
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
];

// Reported, not enforced: the full policy. Hosts are the ones the browser talks to:
// CCC's ClientPublicTestnet RPC (WebSocket first, HTTP fallbacks) and the COTA
// aggregator JoyID's signer reads. Wallets themselves are popups (JoyID) or browser
// extensions, which a page's CSP does not govern. Next.js prerenders these pages
// with inline bootstrap scripts, so script-src 'self' alone would block them;
// enforcing it needs per-request nonces, which means rendering every page
// dynamically. Until then this reports what an enforced policy would block.
const full = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://testnet.ckb.dev wss://testnet.ckb.dev https://testnet.ckbapp.dev https://cota.nervina.dev",
  ...enforced,
];

const config: NextConfig = {
  turbopack: { root, resolveAlias: { "ckb-session-kit": "../dist/index.js" } },
  outputFileTracingRoot: root,
  experimental: { externalDir: true },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: enforced.join("; ") },
          { key: "Content-Security-Policy-Report-Only", value: full.join("; ") },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default config;
