/**
 * Proves the npm package works for a stranger: packs it, installs the tarball
 * into an empty project, and uses it from there through the public entry point.
 *
 * Usage: npm run pack:check
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pack-check-"));
const app = join(dir, "app");
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString();
try {
  sh(`npm pack --pack-destination "${dir}"`, process.cwd());
  const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  sh(`npm install --no-audit --no-fund "${join(dir, tgz)}"`, app);
  writeFileSync(
    join(app, "check.mjs"),
    `
import { checkRequest, createSession, sessionLockScript, TESTNET_DEPLOYMENT } from "ckb-session-kit";
const s = createSession({ expiresAt: new Date(Date.now() + 60_000), scope: { maxPerTx: 5n } });
if (!checkRequest(s, { to: "x", amount: 5n }).ok || checkRequest(s, { to: "x", amount: 6n }).ok) throw new Error("scope check");
const lock = sessionLockScript(TESTNET_DEPLOYMENT, {
  ownerLockHash: "0x" + "11".repeat(32), sessionLockHash: "0x" + "22".repeat(32), maxPerTx: 1n, minInterval: 0n,
});
if (lock.codeHash !== TESTNET_DEPLOYMENT.codeHash) throw new Error("lock script");
console.log("ok: " + ${JSON.stringify(tgz)} + " installs and works from a clean project");
`,
  );
  process.stdout.write(sh("node check.mjs", app));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
