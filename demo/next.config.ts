import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

// The demo imports the library's compiled output (../dist), exactly as an outside
// app would use the package. The root build runs first, so every deploy shows the
// library at that commit. The workspace root is the repository root.
const root = fileURLToPath(new URL("..", import.meta.url));

const config: NextConfig = {
  turbopack: { root, resolveAlias: { "ckb-session-kit": "../dist/index.js" } },
  outputFileTracingRoot: root,
  experimental: { externalDir: true },
  poweredByHeader: false,
  // The reading page pays without a popup, so no other site may frame it (clickjacking).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default config;
