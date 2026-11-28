# Integration walkthrough: an opt-in session in an existing CCC dApp

This is how an app that already builds its own transactions with CCC adds a
session as an option, without changing its contracts or its wallet flow. The
worked example is CrowdCell, a crowdfunding dApp on CKB, and its
[pull request #14](https://github.com/alesfer001/CrowdCell/pull/14), "Opt-in
pledge session: resend a pledge that lost the race without a second wallet
prompt (testnet)". It is the first integration of this kit into an outside
project: contributed by the kit's author and approved by CrowdCell's
maintainer after testing it on testnet with JoyID. It is open, not merged yet.

The problem it solves: every pledge spends the campaign cell, so when two
pledges land at once the node refuses the second, the page rebuilds it, and the
wallet asks the backer to sign again. With a pledge session open, the wallet
signs once to set a small budget aside, and pledges (and their rebuilds) are
funded and signed in the browser. The backer stays the wallet: the pledge and
the receipt are in the wallet's name, so refunds and receipt reclaims are
unchanged.

The code below follows PR #14 at commit
[`69e2911`](https://github.com/alesfer001/CrowdCell/pull/14/commits/69e2911a423b1a7120a7d246d9f05d471d990ba4),
written against ckb-session-kit 2.2.0. The snippets here use the 2.3.0 API
(every 2.2.0 export keeps its signature; 2.3.0 adds reason codes to the
errors, used in [step 6](#6-tell-refusals-apart-by-reason-code)). They are
shortened from the PR but typecheck against the 2.3.0 exports. App-specific
names (`PLEDGE_CELL_OVERHEAD`, `CONTRACTS`, `toast`, the page's transaction
builder) are CrowdCell's own.

Testnet only: the session lock is deployed on testnet, not mainnet.

## 0. What the app needs

- `ckb-session-kit` and the app's existing `@ckb-ccc/core` (the kit depends on
  `@ckb-ccc/core ^1.23.0`; one copy in the bundle avoids two `ccc.Script`
  classes). CrowdCell pins the exact version: `"ckb-session-kit": "2.2.0"`.
- A transaction the app builds itself. CrowdCell's pledge spends the campaign
  cell and creates three outputs: the new campaign cell, a pledge cell and a
  receipt.
- No contract change. The session pays for the app's outputs like any other
  input would; the app's scripts never see the session lock.

## 1. Size the session

A session that funds app-built transactions has **no recipient**: a
recipient-scoped session may only pay its recipient and the owner, in plain
cells, so it could never create a typed pledge cell (lock errors 13 and 18).
Without a recipient, the limit that matters is `maxPerTx`, and it counts
everything a transaction takes from the session beyond the app's own inputs:
the pledge, and the storage of the pledge cell and the receipt.

```ts
import type { Session } from "ckb-session-kit";

/** What a pledge takes from the session besides the amount: the pledge cell's storage and the receipt. */
export const PLEDGE_SESSION_OVERHEAD = PLEDGE_CELL_OVERHEAD + RECEIPT_CELL_CAPACITY;

/** Smallest session cell (8 bytes of capacity + a 113-byte lock script). Not exported by the kit. */
export const SESSION_CELL_CAPACITY = 121n * 100_000_000n;

/** The largest pledge the session can fund in one transaction */
export function maxPledgeOf(session: Session): bigint {
  return session.policy.scope.maxPerTx - PLEDGE_SESSION_OVERHEAD;
}

/** Budget for `pledges` pledges of up to `maxPledge` each, plus a session cell for what is left */
export function pledgeSessionBudget(maxPledge: bigint, pledges: number): bigint {
  return (maxPledge + PLEDGE_SESSION_OVERHEAD) * BigInt(pledges) + SESSION_CELL_CAPACITY;
}
```

CrowdCell's overhead is 552 CKB: 252 for the pledge cell, which returns with
the pledge on refund or release, and 300 for the receipt, which the backer
reclaims once the campaign is finalized. So a session for pledges up to 100 CKB
has `maxPerTx` 652 CKB. The overhead is the app's number, not the kit's. Change from a pledge is either nothing or a
whole session cell, which is why the budget carries one on top.

PR #14: [lines 36-73 of `pledgeSession.ts`](https://github.com/alesfer001/CrowdCell/blob/69e2911a423b1a7120a7d246d9f05d471d990ba4/off-chain/frontend/src/lib/pledgeSession.ts#L36-L73).

## 2. Open the session: one wallet signature

```ts
import { ccc } from "@ckb-ccc/core";
import { createSession, indexedDbStore, openSession, TESTNET_DEPLOYMENT, type SessionWarning } from "ckb-session-kit";

/** How long a pledge session lasts in this browser. The chain only ends it on Close. */
export const PLEDGE_SESSION_HOURS = 1;

// A store key of the app's own, so this never clashes with another app's session on the same origin
const store = () => indexedDbStore(globalThis.indexedDB, "crowdcell-pledge-session");

export async function openPledgeSession(signer: ccc.Signer, maxPledge: bigint, pledges: number): Promise<Session> {
  const session = createSession({
    expiresAt: new Date(Date.now() + PLEDGE_SESSION_HOURS * 3600 * 1000),
    // No recipients: a pledge pays the campaign, pledge and receipt cells
    scope: { maxPerTx: maxPledge + PLEDGE_SESSION_OVERHEAD },
  });
  const { binding } = await openSession(signer, session, TESTNET_DEPLOYMENT, {
    budget: pledgeSessionBudget(maxPledge, pledges),
    onWarning: handleOpenWarning,
    // Saved after signing and before sending: the funds never sit under a key that exists nowhere.
    // If the node then refuses the funding, the stored session was never funded (see below).
    beforeSend: (binding) => store().save({ ...session, onchain: binding }),
  });
  return { ...session, onchain: binding };
}

function handleOpenWarning(warning: SessionWarning) {
  // Expected: pledges must be able to follow each other. The panel tells the backer what it means.
  if (warning.code === "no-rate-limit") return;
  // The wallet's lock runs a build the kit has not reviewed, or one it could not read:
  // stop before anything is signed
  if (warning.code === "owner-lock-build-unreviewed" || warning.code === "owner-lock-build-unresolved") {
    throw new Error("Pledge sessions aren't available for this wallet right now. Pledge from your wallet as usual.");
  }
}

/** The session this browser holds, if any: saved before its funding was sent, so it may hold nothing. */
export async function loadPledgeSession(): Promise<Session | null> {
  const session = await store().load();
  return session?.onchain ? session : null;
}
```

Points that matter:

- **Save in `beforeSend`, not after.** The key is the only way to spend the
  key cell; saving after the send leaves a window where a failed save loses it.
  The other side of this: if the node refuses the funding transaction, the
  store keeps a session that was never funded, and `loadPledgeSession` returns
  it with nothing left. Close clears it: `closeSession` returns
  `nothingFound` when the node does not know `openTx`, and the key is then
  forgotten. Alternatively, catch the error from `openSession` and clear the
  store once `client.getTransaction(binding.openTx)` shows the node does not
  have it; while the node has it, keep the key, since the funding may still
  commit.
- **`onWarning` runs before the wallet prompt.** Throwing from it stops the
  opening with nothing signed. CrowdCell accepts `no-rate-limit` (pledges may
  follow each other in consecutive blocks) and refuses a wallet lock build the
  kit has not reviewed. PR #14 only logs `owner-lock-build-unresolved` (the
  lock's code cell could not be read, so its build was not checked); stopping
  there too, as above, is the safer choice.
- **A session opens once.** In 2.3.0, calling `openSession` again on a session
  that is already open (its `onchain` is set, or its key holds a cell) throws
  `SessionPolicyError` with reason `"session-already-open"`, and the store
  refuses to replace a stored binding with a different one
  (`SessionStoreConflict`). Call `createSession` for every opening. A second
  tab should load the stored session rather than open another.
- **The fee budget.** Besides `budget`, `openSession` puts a key cell aside
  that pays every fee: by default a cell under the owner's lock plus 1 CKB
  (64 CKB for JoyID or Omnilock, 62 CKB for a secp256k1 wallet). What fees
  left of it comes back on close.

PR #14: [`openPledgeSession`, lines 85-101](https://github.com/alesfer001/CrowdCell/blob/69e2911a423b1a7120a7d246d9f05d471d990ba4/off-chain/frontend/src/lib/pledgeSession.ts#L85-L101)
and [`handleOpenWarning`, lines 113-121](https://github.com/alesfer001/CrowdCell/blob/69e2911a423b1a7120a7d246d9f05d471d990ba4/off-chain/frontend/src/lib/pledgeSession.ts#L113-L121).

## 3. Decide, per pledge, whether the session pays

The wallet path stays the default. Before each pledge the page asks whether the
session can pay; if not, it says why and uses the wallet exactly as before.

```ts
import { findSessionCells, isActive } from "ckb-session-kit";

/** Why this pledge can't come from the session, or null if it can */
export async function pledgeSessionUnusable(
  session: Session,
  client: ccc.Client,
  backerLockHash: string,
  amount: bigint,
): Promise<string | null> {
  if (!isActive(session)) return "Your pledge session has expired.";
  if (ccc.Script.from(session.onchain!.ownerLock).hash() !== backerLockHash) {
    return "Your pledge session belongs to another wallet.";
  }
  if (amount > maxPledgeOf(session)) {
    return `Your pledge session covers pledges up to ${ccc.fixedPointToString(maxPledgeOf(session))} CKB.`;
  }
  let balance: bigint;
  try {
    ({ balance } = await findSessionCells(session, client, TESTNET_DEPLOYMENT, session.onchain!));
  } catch {
    return "Your pledge session's balance couldn't be read."; // the wallet pays instead
  }
  const need = amount + PLEDGE_SESSION_OVERHEAD;
  // The session keeps nothing or a whole session cell: fundInSession refuses to leave a sliver
  if (balance !== need && balance < need + SESSION_CELL_CAPACITY) return "Your pledge session doesn't have enough left.";
  return null;
}
```

Change from a pledge is nothing or at least a session cell (121 CKB), so a
balance just above the need is refused: with 1,021 CKB left, a pledge that
needs 952 CKB would leave 69 CKB, and `fundInSession` throws. A failed read
falls back to the wallet rather than failing the pledge.

PR #14 at `69e2911` does not do this yet: it compares the balance with the need
only, and does not catch a failed read. CrowdCell's maintainer reported the
change-rule case in his approving review, and the fix is one of the follow-ups
to the PR.

The owner check matters after a wallet switch: the backer's lock hash goes into
the pledge cell, and a session opened by another wallet would pay for a pledge
in that other wallet's name.

PR #14, without the two changes above: [lines 133-149](https://github.com/alesfer001/CrowdCell/blob/69e2911a423b1a7120a7d246d9f05d471d990ba4/off-chain/frontend/src/lib/pledgeSession.ts#L133-L149).

## 4. Fund the pledge from the session

The page builds the pledge transaction as it always did (campaign cell in,
three outputs). On the wallet path it then calls `completeInputsByCapacity` and
`completeFeeBy` with the wallet; on the session path it skips both and hands the
transaction to the kit.

`fundInSession` is the funding step: it adds session cells as inputs, at most
one plain change cell under the session lock, and the key cell, which comes
back last and pays the fee. It checks the result the way the lock will, and
signs nothing. `sendWithSession` calls `build`, funds the result with
`fundInSession`, signs with the session key alone and sends it. CrowdCell uses
`sendWithSession`:

```ts
import { keyLockOf, sendWithSession, sessionLockOf } from "ckb-session-kit";

/** Same fee rate as a wallet pledge, and never raised on a retry (it could replace another backer's pledge) */
const PLEDGE_FEE_RATE = 2000;

export async function sendPledgeWithSession(
  session: Session,
  client: ccc.Client,
  tx: ccc.Transaction,
  backerLock: ccc.Script,
): Promise<ccc.Hex> {
  const binding = session.onchain!;
  const own = [await sessionLockOf(session, client, TESTNET_DEPLOYMENT, binding), await keyLockOf(session, client)];
  // Retries only on the session's own cells; any other refusal (a dead campaign cell,
  // an RBF refusal) is thrown unchanged for the page's own retry loop
  return sendWithSession(session, client, TESTNET_DEPLOYMENT, binding, async () => tx, {
    feeRate: PLEDGE_FEE_RATE,
    check: (funded) => assertPledgeShape(funded, tx, backerLock, own),
  });
}

/**
 * The only shape a session-funded pledge may have: the page's input and three outputs as
 * built, then nothing but the session's change and its key cell. This guards against bugs
 * in the app, not against a leaked key: the session lock bounds that on its own.
 */
function assertPledgeShape(funded: ccc.Transaction, built: ccc.Transaction, backerLock: ccc.Script, own: ccc.Script[]) {
  const same = (a: ccc.CellOutput, b: ccc.CellOutput) => ccc.hexFrom(a.toBytes()) === ccc.hexFrom(b.toBytes());
  const [, pledge, receipt] = built.outputs;
  const backer = backerLock.hash().slice(2);
  if (
    !funded.inputs[0]?.previousOutput.eq(built.inputs[0].previousOutput) ||
    built.outputs.some((o, i) => !funded.outputs[i] || !same(funded.outputs[i], o)) ||
    built.outputsData.some((d, i) => funded.outputsData[i] !== d) ||
    pledge.lock.codeHash !== CONTRACTS.pledgeLock.codeHash ||
    // Pledge lock args bytes 40..72 are the backer's lock hash: the pledge is in the wallet's name
    pledge.lock.args.slice(2 + 40 * 2, 2 + 72 * 2) !== backer ||
    !receipt.lock.eq(backerLock) ||
    receipt.type?.codeHash !== CONTRACTS.receipt.codeHash ||
    funded.outputs.slice(built.outputs.length).some((o) => o.type || !own.some((lock) => lock.eq(o.lock)))
  ) {
    throw new Error("The session-funded pledge doesn't have the expected shape; nothing was sent.");
  }
}
```

An app that wants to show the finished transaction, or send it through its own
pipeline, can call `fundInSession` directly and sign it later:

```ts
import { fundInSession } from "ckb-session-kit";

export async function previewPledge(session: Session, client: ccc.Client, tx: ccc.Transaction) {
  const { tx: funded, outflow, sessionInputs } = await fundInSession(session, client, TESTNET_DEPLOYMENT, session.onchain!, tx, {
    feeRate: PLEDGE_FEE_RATE,
  });
  // outflow: shannons leaving the session cells, the amount the lock holds to maxPerTx (the fee is not in it)
  return { funded, outflow, inputsAdded: sessionInputs.length };
}
```

What the kit refuses before anything is signed (most of these the lock would
refuse too; the balance and fee ones are build failures):

- an app input under the **owner's** lock: the lock would switch to owner mode
  and need the wallet's signature (`SessionPolicyError`, `"owner-lock-input"`).
  So the session path must not run `completeInputsByCapacity(signer)` first;
- app inputs or outputs under the session lock or the key's lock, or app inputs
  worth more than its outputs (`"app-tx-shape"`);
- a session with a recipient (`"session-has-recipient"`);
- a transaction needing more than `maxPerTx` from the session (`ScopeError`,
  `"over-max-per-tx"`), or a session past `expiresAt` (`"session-expired"`);
- a key cell that cannot pay the fee (`SessionBalanceError`, `"no-fee-cell"`);
- a balance too low, change that would be less than a session cell (121 CKB),
  or, with a rate limit, no session cell old enough yet (each a
  `SessionBalanceError` with no reason).

`openSession` itself refuses a wallet whose lock cannot own a session
(`SessionPolicyError`, `"owner-lock-unsafe"`) or has not been reviewed
(`"owner-lock-unreviewed"`), before the wallet is asked to sign.

The page then picks the path. PR #14,
[`page.tsx` lines 207-214](https://github.com/alesfer001/CrowdCell/blob/69e2911a423b1a7120a7d246d9f05d471d990ba4/off-chain/frontend/src/app/campaigns/%5Bid%5D/page.tsx#L207-L214)
and [lines 345-353](https://github.com/alesfer001/CrowdCell/blob/69e2911a423b1a7120a7d246d9f05d471d990ba4/off-chain/frontend/src/app/campaigns/%5Bid%5D/page.tsx#L345-L353),
in short:

```ts
// pledgeSession: what loadPledgeSession() or openPledgeSession() returned, or null
export async function pledgeOnce(signer: ccc.Signer, backerLock: ccc.Script, amount: bigint): Promise<ccc.Hex> {
  const client = signer.client;
  let session: Session | null = null;
  if (pledgeSession) {
    const reason = await pledgeSessionUnusable(pledgeSession, client, backerLock.hash(), amount);
    if (reason) toast("info", `${reason} Pledging from your wallet instead.`);
    else session = pledgeSession;
  }

  for (;;) {
    const tx = await buildPledgeTx(client, backerLock, amount); // the app's own builder, unchanged
    if (!session) {
      await tx.completeInputsByCapacity(signer);
      await tx.completeFeeBy(signer, 2000);
    }
    try {
      return session ? await sendPledgeWithSession(session, client, tx, backerLock) : await signer.sendTransaction(tx);
    } catch (err) {
      // The session refused before anything was sent (step 6): rebuild and pay from the wallet
      if (session && isSessionRefusal(err)) {
        session = null;
        toast("info", "Your pledge session can't pay this pledge. Pledging from your wallet instead.");
        continue;
      }
      throw err; // a lost race goes to the app's retry loop (step 5)
    }
  }
}
```

PR #14 at `69e2911` has the check before the pledge but not the `catch`: a
session refusal at send time fails the pledge there. Falling back at send time
is one of the follow-ups.

## 5. Races: the app's retry loop stays the app's

`sendWithSession` retries on its own only when the node refuses a cell the
session added (another tab spent it). When the refusal names the app's cell
(another backer's pledge took the campaign cell first), the error comes out
unchanged so the app's existing loop can wait for the campaign cell to move and
build again. `deadInputs(e)` is true for a dead or unknown input, and
`poolConflict(e)` for an RBF refusal (the rival is still in the pool, so the
node runs RBF checks instead of answering `Dead`). The fee rate is the same on
every attempt: raising it on a retry could replace the other backer's pending
pledge.

```ts
import { deadInputs, poolConflict } from "ckb-session-kit";

/** Whether a send lost the race for the app's own cell: wait for it to move, then build again */
export function lostRace(err: unknown): { retry: boolean; rivalPending: boolean } {
  return { retry: deadInputs(err) || poolConflict(err), rivalPending: poolConflict(err) };
}
```

CrowdCell's page uses its own `isInputAlreadySpentError` for the same test, and
in PR #14 the "Please approve the updated pledge in your wallet" toast shows on
the wallet path only. On testnet a pending rival can take over a minute to
commit, so a 30 s wait is not always enough: CrowdCell
[pull request #15](https://github.com/alesfer001/CrowdCell/pull/15)
([`0a67ff3`](https://github.com/alesfer001/CrowdCell/pull/15/commits/0a67ff3e7f1002a2c9e6b197da7822fa2fddba8e)),
separate from #14, makes the page's retry loop wait up to 90 s after an RBF
refusal. Both PRs are open; once both are merged, the same loop serves the
wallet path and the session path.

## 6. Tell refusals apart by reason code

From 2.3.0 the refusals a UI usually branches on carry a `reason`, so the app
does not have to match the message text (which may change). The rest are
balance or timing errors with no reason, and `isSessionRefusal` below catches
them by class. Two uses in a pledge flow:

**Fall back to the wallet when the session refuses at send time.** The check in
step 3 runs once, before the pledge. If the pledge then waits for the campaign
cell, the session can expire or run low in the meantime. Each of these errors is
thrown before anything is signed or sent, so the wallet can pay instead without
losing an attempt (`pledgeOnce` in step 4 shows where it plugs in; PR #14 at
`69e2911` fails the pledge here, and falling back is a follow-up):

```ts
import { ScopeError, SendOutcomeUnknownError, SessionBalanceError, SessionPolicyError } from "ckb-session-kit";

/** The session refused to pay, before anything was sent. The wallet can pay instead. */
export function isSessionRefusal(err: unknown): boolean {
  return err instanceof ScopeError || err instanceof SessionBalanceError || err instanceof SessionPolicyError;
}

/** The node may have taken the transaction: never resend through another path. */
export function outcomeUnknown(err: unknown): boolean {
  return err instanceof SendOutcomeUnknownError;
}
```

**Show a short message.**

```ts
export function sessionErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ScopeError) {
    if (err.reason === "session-expired") return "Your pledge session has expired.";
    if (err.reason === "over-max-per-tx") return "This pledge is over what the session covers per pledge.";
  }
  if (err instanceof SessionBalanceError) {
    if (err.reason === "no-fee-cell") return "The session's fee cell has run out.";
    if (err.reason === "no-owner-cell") {
      return "Your wallet's main address needs one plain CKB cell to sign this with. Send it a small amount and try again.";
    }
    if (err.reason === "not-indexed-yet") return "The session isn't indexed yet. Close again in a minute.";
  }
  if (err instanceof SessionPolicyError) {
    if (err.reason === "session-already-open") return "This pledge session is already open. Reload the page to see it.";
    if (err.reason === "session-expired") return "Your pledge session has expired.";
    if (err.reason === "wrong-signer") return "Connect the wallet that opened this session.";
    if (err.reason === "owner-lock-unreviewed" || err.reason === "owner-lock-unsafe") {
      return "Pledge sessions aren't available for this wallet. Pledge from your wallet as usual.";
    }
  }
  return err instanceof Error ? err.message : fallback;
}
```

The full lists are in [API.md](API.md): `ScopeReason`, `SessionPolicyReason`
and `SessionBalanceReason`.

## 7. Close the session, and recover funds without the key

Closing is the second wallet signature. `closeSession` sweeps what is left in
the session cells back to the wallet (signed by the wallet, owner mode), then
returns the key cell with the session key. Forget the key only when nothing is
left under it.

```ts
import { closeSession } from "ckb-session-kit";

export async function closePledgeSession(signer: ccc.Signer, session: Session) {
  // Another wallet is refused first, before any read or prompt (SessionPolicyError "wrong-signer")
  const result = await closeSession(signer, session, TESTNET_DEPLOYMENT, session.onchain!);
  // keyError: swept, but the key cell didn't come back (yet). Keep the key and close again.
  if (result.keyError === undefined) await store().clear(session);
  return result;
}
```

What can come back:

- no `keyError`: done (`sweepTx` and/or `keyTx` set; only `keyTx` if the
  session cells were already empty). The PR's panel then says "What was left
  is on its way back to your wallet".
- `keyError` set: the sweep went out but the key cell did not; the key stays
  stored and Close can run again.
- `nothingFound: true`: nothing is left under the session or the key (a close
  in another tab, or a close whose reply was lost).
- `SessionBalanceError` `"not-indexed-yet"`: the funding transaction is still
  pending, or the indexer is behind. Nothing was sent; keep the key and close
  again in a minute.
- `SessionBalanceError` `"no-owner-cell"`: the owner sweep needs one plain
  cell (no type, no data) under the wallet's main lock to prove ownership, and
  there is none. Nothing was signed; the wallet must receive a little CKB first.
- a `SessionBalanceError` with no reason, "the funding transaction made no cell
  under this session": the session was closed against the wrong deployment.
  Keep the key and check the deployment.

If the key is lost (site data cleared, a private window closed, another
device), the session cells are not lost: their lock args start with the owner's
lock hash, so the wallet can find and sweep them alone, usually in one
signature:

```ts
import { recoverSessions, TESTNET_DEPLOYMENT, TESTNET_LEGACY_DEPLOYMENTS } from "ckb-session-kit";

export async function sweepLostSessions(signer: ccc.Signer) {
  const { txHashes, recovered, failed, error, unknown } = await recoverSessions(signer, [TESTNET_DEPLOYMENT, ...TESTNET_LEGACY_DEPLOYMENTS]);
  // `error`: a sweep after the first found no plain owner cell, say; show it, offer to retry.
  // `unknown`: sweeps that may still commit; look up each `txHash` before sweeping again.
  return { txHashes, recovered, failed, error, unknown: unknown?.map((e) => e.txHash) ?? [] };
}
```

This ends **every** session the wallet still has open, in another browser or
another app too, not just the lost one: say so and ask the user to confirm
first. It is one signature, or one per session if the combined sweep is
refused (`failed` counts the sessions not recovered), and like Close it needs
one plain cell under the wallet's lock (`"no-owner-cell"`). Each one-per-session
sweep spends that cell and gets it back as change, which the next sweep spends
at once. Only if something else spends that change first can a later sweep
find no plain cell yet: once some sessions were swept, that fault is returned
in `error` next to their `txHashes` rather than thrown, and the rest count in
`failed`; run the sweep again a little later for them. A sweep whose send could not be confirmed
either way is listed in `unknown`: check those hashes first.

The key cell (the fee budget: 62 CKB for a secp256k1 wallet, 64 for JoyID or
Omnilock, less fees spent) is under the key's own lock and cannot be recovered
without the key. PR #14 offers Close only; a sweep without
the key is what the panel's copy calls "a manual sweep".

PR #14: [`closePledgeSession`, lines 208-212](https://github.com/alesfer001/CrowdCell/blob/69e2911a423b1a7120a7d246d9f05d471d990ba4/off-chain/frontend/src/lib/pledgeSession.ts#L208-L212).

## 8. What the user must be told

The session is a trade: fewer wallet prompts for a key that sits in the
browser. The backer should read the terms before the wallet asks. PR #14's
panel says, before opening
([`PledgeSessionPanel.tsx` lines 158-196](https://github.com/alesfer001/CrowdCell/blob/69e2911a423b1a7120a7d246d9f05d471d990ba4/off-chain/frontend/src/components/PledgeSessionPanel.tsx#L158-L196)):

- what it is for: "When two pledges land at once, yours is rebuilt and your
  wallet asks again. With a session, your wallet signs once to set a small
  budget aside, and pledges from it are signed in this browser."
- that ownership does not move: "Your pledges and receipts stay in your
  wallet's name. Closing it is a second wallet prompt and returns whatever is
  left."
- the amounts: the budget, the deposits each pledge carries, and the fee cell.
- the expiry and the risk: "It lasts 1 hour in this browser, but only Close
  ends it on chain. There is no rate limit: until you close it, a key taken
  from this browser could spend all of it."
- **where the key lives**: "The key lives only in this browser, so keep its
  site data and don't use a private window: closing one loses the key, Close
  can't refund, and the budget needs a manual sweep." (added in
  [`69e2911`](https://github.com/alesfer001/CrowdCell/pull/14/commits/69e2911a423b1a7120a7d246d9f05d471d990ba4)).

And while open
([lines 117-123](https://github.com/alesfer001/CrowdCell/blob/69e2911a423b1a7120a7d246d9f05d471d990ba4/off-chain/frontend/src/components/PledgeSessionPanel.tsx#L117-L123)):
the cap per pledge, what is left, the expiry, and "Until it is closed, a key
taken from this browser could spend what is left, up to [maxPerTx] CKB per
transaction, to anyone. It can't touch your wallet, your pledges or your
receipts." (the page fills in the session's `maxPerTx`). A Close button is always
shown while a session is open, on every campaign page, not only the one it was
opened on. PR #14 shows it to whichever wallet is connected; another wallet's
Close is refused before signing (`"wrong-signer"`). Better: show the session
only when its `ownerLock` matches the connected wallet, and otherwise a note to
switch back.

The "to anyone" is accurate: a session with no recipient lets a leaked key pay
any lock. The panel's per-transaction figure needs context, though, and the
app's copy should not make it sound like more protection than it is:

- **No rate limit.** The session has `minInterval` 0, so the cap per
  transaction does not slow a thief: a leaked key can empty the whole budget in
  a few consecutive transactions.
- **The key cell too.** The fee budget (62 to 64 CKB) is under the key's own
  lock, outside `maxPerTx` and the session lock: a leaked key can spend it
  outright.
- **The expiry is checked only in the browser.** The lock has no expiry; on
  chain the key works until Close.
- **The key is stored unencrypted** in this origin's IndexedDB. Anything that
  can run script on the dApp's pages can read it: an XSS bug, a compromised
  dependency, an extension with access to the site. The session's risk is the
  page's XSS and supply-chain risk.

It can never spend the wallet's own cells, pledges or receipts. Keep the budget
small, and suggest closing the session when the backer is done.

## 9. On testnet

The maintainer
[approved PR #14](https://github.com/alesfer001/CrowdCell/pull/14#pullrequestreview-5978466616)
after trying it on testnet in the browser with JoyID. The two changes asked for
before merge (the site-data warning, an exact version pin) are commit `69e2911`.

Before the PR was opened (17 Nov), the draft that became its
`pledgeSession.ts` ran unchanged in a script on 7 Nov 2026 (a secp256k1 key
standing in for the wallet), on a test campaign of its own. That draft still
bridged types between two copies of CCC; the PR was written on a CrowdCell main
with one copy, so the bridge is gone, and the kit calls are the same.

- [session opened](https://testnet.explorer.nervos.org/transaction/0x07a0a862efcc10d329d87a3b2b5c73ae93fb35eec1e59187d9b68e7fa968a544),
  one wallet signature, budget 1,425 CKB;
- [100 CKB pledged from the session](https://testnet.explorer.nervos.org/transaction/0xaa2551bc2e240446b8cd1c0a7e998ae307b67ea945a093cc68d9aaa6ec83c73d),
  no wallet signature, receipt under the wallet's lock;
- a forced race: a [rival wallet pledge](https://testnet.explorer.nervos.org/transaction/0x119c31a0ec17ce35ac1c636a83fe554c12d3d8b8eebebc455e8d90728d2bb4a6)
  took the campaign cell, and the session pledge was refused,
  [rebuilt on top and sent](https://testnet.explorer.nervos.org/transaction/0x4659b9b2bde18f2038b2b9b4930402f283c1cff3db55ef730b6a2f64b317ca28)
  with no wallet signature;
- a 101 CKB pledge forced through was refused by the kit before signing
  (653 CKB over the 652 CKB `maxPerTx`); another wallet got "belongs to another
  wallet", and its Close was refused before signing;
- closed with one wallet signature:
  [sweep](https://testnet.explorer.nervos.org/transaction/0xfeac937d58b632f22027180fd573bee6bb9c30a64fadc6cf987d8001030b5ca7)
  and [key cell back](https://testnet.explorer.nervos.org/transaction/0xddcac7b1877a88386d566654be6617ac5f1e395ad0bbbb1b5cded21a3aa0fe64);
- after the deadline, the campaign was
  [finalized as Failed](https://testnet.explorer.nervos.org/transaction/0x4be6c79ea5fc9e623acf8fff673a676ba07c2ae43a3b2c1dcb1fd64121598942)
  and the pledges refunded (for example
  [this refund](https://testnet.explorer.nervos.org/transaction/0xacb3e9da4cfcff63eb8d927aedf7f0439dcd4e0b5af6ca1d81fd5b51e825c1c5)).

The kit's own run of the same flow, `npm run smoke:fund-pledge` against
CrowdCell's live testnet scripts, is in the README under
[Funding an app-built transaction](../README.md#funding-an-app-built-transaction),
and `test/fund-pledge-vm.test.ts` runs a session-funded pledge through
CrowdCell's five scripts and the session lock in the CKB-VM.

## Checklist

- [ ] The session has no recipient, and `maxPerTx` = largest amount + the
      storage of every cell the app creates.
- [ ] `beforeSend` saves the session; a new `createSession` for each opening.
- [ ] The wallet path is unchanged and is the default; the session path skips
      the wallet's `completeInputsByCapacity` / `completeFeeBy`.
- [ ] Before each send: active, same owner as the connected wallet, within the
      cap, and a balance that is exactly the need or leaves at least a session
      cell; a failed read means the wallet pays. At send time, a kit refusal
      falls back to the wallet.
- [ ] `check` pins the shape of the funded transaction.
- [ ] The app's own race loop handles `deadInputs` / `poolConflict`, at a
      fixed fee rate.
- [ ] Close is always reachable; the key is cleared only without `keyError`.
- [ ] The user is told: what the key can spend (the whole budget and the fee
      cell, with no rate limit), that only Close ends it on chain, and that it
      lives only in this browser's site data, readable by anything running on
      its origin.
- [ ] A sweep without the key warns that it ends every open session of that
      wallet.
