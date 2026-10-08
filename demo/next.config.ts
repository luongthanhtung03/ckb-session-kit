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
};

export default config;
