import { defineConfig, devices } from "@playwright/test";

/**
 * Browser smoke checks of the demo, with no wallet: every page loads, renders,
 * reads the chain, and logs no errors. They never connect or sign with a wallet.
 *
 *   npm run e2e                                   # the live demo on Vercel
 *   BASE_URL=http://localhost:3000 npm run e2e    # `npm run demo` running locally
 *
 * Test files are *.e2e.ts, so vitest (test/**, demo/app/**) never picks them up,
 * and e2e/ is outside the package's "files", so npm never packs it.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  outputDir: "test-results",
  // The pages read testnet over public RPC: give it time, and one retry in CI so a
  // single slow block does not page anyone. A demo that is really down fails twice.
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "https://ckb-session-kit.vercel.app",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
