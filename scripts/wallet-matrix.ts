/**
 * Wallet compatibility on testnet: the same session and subscription flows with
 * each kind of owner lock the demo's wallet picker can give, signed the way that
 * wallet signs. Every row ends up as real testnet transactions.
 *
 *   per owner kind: funded by the funder → session opened (one owner signature)
 *   → 1 CKB paid by the session key → session closed (owner sweeps, key cell back)
 *   → subscription opened (first period paid) → cancelled → everything back to the funder
 *
 * Owner kinds, by the lock each wallet uses:
 *   secp256k1-blake160  the default CKB lock (CKB CLI, Neuron, most libraries)
 *   omnilock-evm        Omnilock with Ethereum auth: MetaMask, OKX (EVM), any EIP-191 signer
 *   omnilock-btc        Omnilock with Bitcoin auth: UniSat, OKX (BTC), other ECDSA message signers
 *   omnilock-doge       Omnilock with Dogecoin auth
 *   nostr               the Nostr lock: any NIP-07 extension
 * JoyID signs with a passkey and cannot be scripted: tested by hand in the demo.
 *
 * Each owner is a throwaway key derived from the funder's key and the kind, so a
 * rerun reuses the same addresses. Prints a Markdown table of explorer links.
 *
 * Usage: FUNDER_KEY=0x... npm run matrix:wallets  (optional: ONLY=omnilock-evm,nostr)
 */
import { ccc } from "@ckb-ccc/core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { readFileSync } from "node:fs";
import {
  cancelSubscription,
  closeSession,
  createSession,
  openSession,
  openSubscription,
  spendInSession,
  type SessionLockDeployment,
} from "../src/index.js";

const CKB = 100_000_000n;
const explorer = (h: string) => `https://testnet.explorer.nervos.org/transaction/${h}`;
const deployment = JSON.parse(readFileSync("deployment/testnet.json", "utf8")) as SessionLockDeployment;
// The demo's creator: its anyone-can-pay cell takes the payments. The charger is a key of its own (31 Oct).
const CREATOR_ACP = "ckt1qq6pngwqn6e9vlm92th84rk0l4jp2h8lurchjmnwv8kq3rt5psf4vqfrks0ww06uv9pgqzwuajnq694mjncvctg0t589g";
const CHARGER = "ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq0c0ucvmy9vmq7e6pt58tja0tw46kx44qg44ekz4";

const utf8OrBytes = (m: string | ccc.BytesLike) => (typeof m === "string" ? ccc.bytesFrom(m, "utf8") : ccc.bytesFrom(m));

/** An Ethereum wallet: signs EIP-191 personal messages, as MetaMask does. */
class EvmKeySigner extends ccc.SignerEvm {
  constructor(
    client: ccc.Client,
    private readonly key: Uint8Array,
  ) {
    super(client);
  }
  async connect(): Promise<void> {}
  async isConnected(): Promise<boolean> {
    return true;
  }
  async getEvmAccount(): Promise<ccc.Hex> {
    const pub = secp256k1.getPublicKey(this.key, false).slice(1);
    return ccc.hexFrom(keccak_256(pub).slice(-20));
  }
  async signMessageRaw(message: string | ccc.BytesLike): Promise<string> {
    const msg = utf8OrBytes(message);
    const prefixed = ccc.bytesConcat(ccc.bytesFrom(`\x19Ethereum Signed Message:\n${msg.length}`, "utf8"), msg);
    const sig = secp256k1.sign(keccak_256(prefixed), this.key, { format: "recovered", prehash: false });
    // noble: recovery byte first; Ethereum: r || s || v (27 + recovery).
    return ccc.hexFrom(ccc.bytesConcat(sig.subarray(1), [27 + sig[0]]));
  }
}

/** A Bitcoin wallet: signs Bitcoin messages with ECDSA, as UniSat does. */
class BtcKeySigner extends ccc.SignerBtc {
  constructor(
    client: ccc.Client,
    private readonly key: Uint8Array,
  ) {
    super(client);
  }
  async connect(): Promise<void> {}
  async isConnected(): Promise<boolean> {
    return true;
  }
  async getBtcAccount(): Promise<string> {
    return ccc.hexFrom(secp256k1.getPublicKey(this.key, true)); // only shown, never parsed
  }
  async getBtcPublicKey(): Promise<ccc.Hex> {
    return ccc.hexFrom(secp256k1.getPublicKey(this.key, true));
  }
  async signMessageRaw(message: string | ccc.BytesLike): Promise<string> {
    const challenge = typeof message === "string" ? message : ccc.hexFrom(message).slice(2);
    const sig = secp256k1.sign(ccc.messageHashBtcEcdsa(challenge), this.key, { format: "recovered", prehash: false });
    // Compressed-key header byte 31 + recovery, then r || s, base64: what wallets return.
    return ccc.bytesTo(ccc.bytesConcat([31 + sig[0]], sig.subarray(1)), "base64");
  }
  async signPsbt(): Promise<ccc.Hex> {
    throw new Error("not needed here");
  }
  async broadcastPsbt(): Promise<ccc.Hex> {
    throw new Error("not needed here");
  }
}

type Kind = "secp256k1-blake160" | "omnilock-evm" | "omnilock-btc" | "omnilock-doge" | "nostr";
const KINDS: Kind[] = ["secp256k1-blake160", "omnilock-evm", "omnilock-btc", "omnilock-doge", "nostr"];

function ownerFor(kind: Kind, client: ccc.Client, funderKey: string): ccc.Signer {
  const key = ccc.hashCkb(ccc.bytesConcat(ccc.bytesFrom(funderKey), ccc.bytesFrom(`wallet-matrix ${kind}`, "utf8")));
  const raw = ccc.bytesFrom(key);
  switch (kind) {
    case "secp256k1-blake160":
      return new ccc.SignerCkbPrivateKey(client, key);
    case "omnilock-evm":
      return new EvmKeySigner(client, raw);
    case "omnilock-btc":
      return new BtcKeySigner(client, raw);
    case "omnilock-doge":
      return new ccc.SignerDogePrivateKey(client, key);
    case "nostr":
      return new ccc.SignerNostrPrivateKey(client, key);
  }
}

async function committed(client: ccc.Client, hash: ccc.Hex): Promise<void> {
  for (let i = 0; i < 720; i++) {
    if ((await client.getTransaction(hash))?.status === "committed") return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`not committed after an hour: ${explorer(hash)}`);
}

async function balanceOf(client: ccc.Client, lock: ccc.Script): Promise<bigint> {
  let total = 0n;
  for await (const cell of client.findCellsByLock(lock, null, true)) total += cell.cellOutput.capacity;
  return total;
}

interface Row {
  kind: Kind;
  address?: string;
  steps: [string, string][];
  error?: string;
}

async function runKind(kind: Kind, client: ccc.Client, funder: ccc.Signer, funderKey: string): Promise<Row> {
  const owner = ownerFor(kind, client, funderKey);
  const addr = await owner.getRecommendedAddressObj();
  const row: Row = { kind, address: addr.toString(), steps: [] };
  const step = async (name: string, send: () => Promise<ccc.Hex | undefined>) => {
    const hash = await send();
    if (!hash) return;
    console.log(`  ${name}: ${explorer(hash)}`);
    row.steps.push([name, hash]);
    await committed(client, hash);
  };
  console.log(`${kind}  ${addr.toString()}`);
  try {
    if ((await balanceOf(client, addr.script)) < 300n * CKB) {
      await step("funded", async () => {
        const tx = ccc.Transaction.from({ outputs: [{ lock: addr.script, capacity: 340n * CKB }] });
        await tx.completeInputsByCapacity(funder);
        await tx.completeFeeBy(funder);
        return funder.sendTransaction(tx);
      });
    }

    const session = createSession({ expiresAt: new Date(Date.now() + 3_600_000), scope: { maxPerTx: 5n * CKB, recipients: [CREATOR_ACP] } });
    let binding: Awaited<ReturnType<typeof openSession>>["binding"] | undefined;
    await step("session opened", async () => {
      const r = await openSession(owner, session, deployment, { budget: 200n * CKB });
      binding = r.binding;
      session.onchain = r.binding;
      return r.txHash;
    });
    await step("paid 1 CKB", () =>
      spendInSession(session, client, deployment, binding!, { to: CREATOR_ACP, amount: CKB, topUp: true }),
    );
    const closed = await closeSession(owner, session, deployment, binding!);
    if (closed.keyError) throw new Error(`key cell: ${closed.keyError}`);
    await step("session swept", async () => closed.sweepTx);
    await step("key cell back", async () => closed.keyTx);

    const { txHash: subTx, subscription } = await openSubscription(owner, deployment, {
      charger: CHARGER,
      payTo: CREATOR_ACP,
      price: 2n * CKB,
      periodBlocks: 60n,
      budget: 155n * CKB,
      account: ccc.hexFrom(crypto.getRandomValues(new Uint8Array(32))),
    });
    await step("subscribed", async () => subTx);
    await step("cancelled", async () => (await cancelSubscription(owner, deployment, subscription)).txHash);

    await step("returned", async () => {
      const funderLock = (await funder.getRecommendedAddressObj()).script;
      const tx = ccc.Transaction.from({ outputs: [{ lock: funderLock, capacity: 0n }] });
      await tx.completeInputsAll(owner);
      await tx.completeFeeChangeToOutput(owner, 0);
      return owner.sendTransaction(tx);
    });
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
    console.log(`  ✗ ${row.error}`);
  }
  return row;
}

async function main(): Promise<void> {
  const funderKey = process.env.FUNDER_KEY;
  if (!funderKey) throw new Error("set FUNDER_KEY to a testnet private key");
  const client = new ccc.ClientPublicTestnet({ url: process.env.CKB_RPC_URL ?? "https://testnet.ckb.dev/" });
  const funder = new ccc.SignerCkbPrivateKey(client, funderKey);
  const only = process.env.ONLY?.split(",");
  const rows: Row[] = [];
  for (const kind of KINDS.filter((k) => !only || only.includes(k))) rows.push(await runKind(kind, client, funder, funderKey));

  const cols = ["session opened", "paid 1 CKB", "session swept", "key cell back", "subscribed", "cancelled"];
  console.log(`\n| Owner lock | ${cols.join(" | ")} |\n|---|${cols.map(() => "---").join("|")}|`);
  for (const r of rows) {
    const cell = (c: string) => {
      const s = r.steps.find(([n]) => n === c);
      return s ? `[${s[1].slice(0, 10)}…](${explorer(s[1])})` : r.error ? "failed" : "";
    };
    console.log(`| ${r.kind} | ${cols.map(cell).join(" | ")} |`);
  }
  for (const r of rows.filter((r) => r.error)) console.log(`\n${r.kind}: ${r.error}`);
  if (rows.some((r) => r.error)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
