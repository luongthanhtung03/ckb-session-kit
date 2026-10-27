// Checks that the session lock built locally is the code deployed on testnet:
// its CKB data hash (blake2b-256, "ckb-default-hash") must equal the codeHash in
// deployment/testnet.json. Builds nothing: build first, in contracts/session-lock,
// with `cargo +1.99.0-x86_64-pc-windows-gnu build --release` (the toolchain and
// host the deployed binary came from; see rust-toolchain.toml there). Exits 1 on
// a mismatch or a missing binary.
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { ccc } from "@ckb-ccc/core";

const BINARY = "contracts/session-lock/target/riscv64imac-unknown-none-elf/release/session-lock";
const RECORD = "deployment/testnet.json";

if (!existsSync(BINARY)) {
  console.error(`missing ${BINARY}: build it with \`cargo build --release\` in contracts/session-lock`);
  process.exit(1);
}

const binary = readFileSync(BINARY);
const record = JSON.parse(readFileSync(RECORD, "utf8"));
const built = ccc.hashCkb(binary);
const deployed = String(record.codeHash).toLowerCase();

console.log(`binary   : ${BINARY} (${binary.length} bytes)`);
console.log(`sha256   : ${createHash("sha256").update(binary).digest("hex")}`);
console.log(`built    : ${built}`);
console.log(`deployed : ${deployed} (${record.hashType}, ${RECORD})`);

if (built !== deployed) {
  console.error("MISMATCH: this build is not the deployed session lock (built with rustc 1.99.0 on x86_64-pc-windows-gnu?)");
  process.exit(1);
}
console.log("OK: the build is byte-identical to the deployed session lock");
