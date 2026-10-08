import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { relativeBlocksSince, sessionLockArgs, sessionLockErrorFrom, TESTNET_DEPLOYMENT } from "../src/lock.js";

const A = "0x" + "aa".repeat(32);
const B = "0x" + "bb".repeat(32);
const C = "0x" + "cc".repeat(32);

describe("sessionLockArgs", () => {
  it("encodes the 80-byte layout the contract reads", () => {
    const args = sessionLockArgs({ ownerLockHash: A, sessionLockHash: B, maxPerTx: 100n * 10n ** 8n, minInterval: 5n });
    expect((args.length - 2) / 2).toBe(80);
    expect(args.slice(2, 66)).toBe("aa".repeat(32));
    expect(args.slice(66, 130)).toBe("bb".repeat(32));
    expect(args.slice(130, 146)).toBe("00e40b5402000000"); // 10_000_000_000 LE
    expect(args.slice(146, 162)).toBe("0500000000000000");
  });

  it("appends the recipient for the 112-byte layout", () => {
    const args = sessionLockArgs({ ownerLockHash: A, sessionLockHash: B, maxPerTx: 1n, recipientLockHash: C });
    expect((args.length - 2) / 2).toBe(112);
    expect(args.slice(-64)).toBe("cc".repeat(32));
  });

  it("refuses hashes of the wrong length and out-of-range numbers", () => {
    expect(() => sessionLockArgs({ ownerLockHash: "0x12", sessionLockHash: B, maxPerTx: 1n })).toThrow(/32 bytes/);
    expect(() => sessionLockArgs({ ownerLockHash: A, sessionLockHash: B, maxPerTx: -1n })).toThrow(/u64/);
    expect(() => sessionLockArgs({ ownerLockHash: A, sessionLockHash: B, maxPerTx: 1n << 64n })).toThrow(/u64/);
  });
});

describe("relativeBlocksSince", () => {
  it("sets the relative flag with the block-number metric", () => {
    expect(relativeBlocksSince(3n)).toBe(0x8000000000000003n);
  });
});

describe("sessionLockErrorFrom", () => {
  it("reads the code from a node rejection", () => {
    // Verbatim prefix of the testnet node's rejection, from npm run smoke:lock.
    const msg =
      "Client request error TransactionFailedToVerify: Verification failed Script(TransactionScriptError { source: Inputs[0].Lock, cause: ValidationFailure: see error code 12 on page https://nervosnetwork.github.io/ckb-script-e";
    expect(sessionLockErrorFrom(msg)).toEqual({ code: 12, meaning: "outflow exceeds max_per_tx" });
  });
  it("returns undefined when there is no code", () => {
    expect(sessionLockErrorFrom("PoolIsFull")).toBeUndefined();
  });
});

describe("TESTNET_DEPLOYMENT", () => {
  it("matches deployment/testnet.json, the record written by the deploy script", () => {
    const { codeHash, hashType, cellDep } = JSON.parse(readFileSync("deployment/testnet.json", "utf8"));
    expect(TESTNET_DEPLOYMENT).toEqual({ codeHash, hashType, cellDep });
  });
});
