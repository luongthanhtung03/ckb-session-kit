import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/setup-debugger.ts"],
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
