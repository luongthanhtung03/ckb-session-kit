/**
 * End-to-end check on public testnet: fund a fresh session, spend within its
 * scope with no wallet in the loop, and confirm an out-of-scope spend is refused.
 *
 * Usage: FUNDER_KEY=0x... npm run smoke:testnet
 * FUNDER_KEY is a testnet-only key; it is read from the environment, never stored.
 */
import { ccc } from "@ckb-ccc/core";
import { createSession, ScopeError, sendInScope, sessionAddress } from "../src/index.js";

const explorer = (hash: string) => `https://testnet.explorer.nervos.org/transaction/${hash}`;

async function waitCommitted(client: ccc.Client, hash: ccc.Hex): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const res = await client.getTransaction(hash);
    if (res?.status === "committed") return;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`not committed after 10 minutes: ${explorer(hash)}`);
}

async function main(): Promise<void> {
  const funderKey = process.env.FUNDER_KEY;
  if (!funderKey) throw new Error("set FUNDER_KEY to a testnet private key");
  const client = new ccc.ClientPublicTestnet();
  const funder = new ccc.SignerCkbPrivateKey(client, funderKey);
  const funderAddress = await funder.getRecommendedAddress();

  const session = createSession({
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    scope: { maxPerTx: ccc.fixedPointFrom("100"), recipients: [funderAddress] },
  });
  const address = await sessionAddress(session, client);
  console.log(`session address : ${address}`);

  // 1. Fund the session with a 300 CKB budget.
  const { script: lock } = await ccc.Address.fromString(address, client);
  const fund = ccc.Transaction.from({ outputs: [{ lock, capacity: ccc.fixedPointFrom("300") }] });
  await fund.completeInputsByCapacity(funder);
  await fund.completeFeeBy(funder);
  const fundHash = await funder.sendTransaction(fund);
  console.log(`funded          : ${explorer(fundHash)}`);
  await waitCommitted(client, fundHash);

  // 2. Spend inside the scope — signed by the session key, no wallet.
  const spendHash = await sendInScope(session, client, { to: funderAddress, amount: ccc.fixedPointFrom("100") });
  console.log(`in-scope spend  : ${explorer(spendHash)}`);
  await waitCommitted(client, spendHash);

  // 3. Over the per-tx limit — must be refused before anything is signed.
  try {
    await sendInScope(session, client, { to: funderAddress, amount: ccc.fixedPointFrom("150") });
    throw new Error("over-limit spend was NOT refused");
  } catch (e) {
    if (!(e instanceof ScopeError)) throw e;
    console.log(`over-limit spend: refused — ${e.message}`);
  }
}

// The testnet client holds its connection open, so exit explicitly.
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
