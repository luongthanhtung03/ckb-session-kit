import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The demo's server code imports the package by name; in tests, that is the source.
  resolve: { alias: { "ckb-session-kit": fileURLToPath(new URL("src/index.ts", import.meta.url)) } },
  test: {
    globalSetup: ["test/setup-debugger.ts"],
    include: ["test/**/*.test.ts", "demo/app/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
