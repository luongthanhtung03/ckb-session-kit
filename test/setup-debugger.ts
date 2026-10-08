/**
 * ckb-testtool spawns `ckb-debugger` by bare name, without a shell. On Windows,
 * offckb only puts a `.cmd` shim on PATH, which such a spawn cannot see, so put
 * the directory holding the real executable on PATH before the workers start.
 * (The same Windows problem ckb-cycle-tools' resolver fixes.)
 *
 * vitest globalSetup runs in the parent process; workers inherit the change.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export default function setup(): void {
  const dirs = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "offckb-nodejs", "Data", "tools"),
  ].filter((d): d is string => Boolean(d));
  for (const dir of dirs) {
    if (!["ckb-debugger.exe", "ckb-debugger"].some((b) => existsSync(join(dir, b)))) continue;
    process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
    return;
  }
}
