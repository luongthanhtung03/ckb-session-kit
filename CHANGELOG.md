# Changelog

This project follows [semantic versioning](https://semver.org/). The session lock is
deployed on CKB **testnet only**; there is no mainnet deployment yet.

## Unreleased

### Added (mentor review, tracker #47, 2 Nov)
- Payout cell contention. A top-up (`spendInSession` with `topUp`,
  `chargeSubscription`, `openSubscription`) picks the recipient's cell with
  `pickPayoutCell`: confirmed cells first, shuffled, and the first free one of
  up to `MAX_POOL_CHECKS` (4) cells checked with `get_live_cell` and
  `include_tx_pool`, so a cell another payment in the node's pool spends is
  skipped. At most `MAX_PAYOUT_CELLS` (64) of the recipient's cells are read.
- `spendInSession` and `chargeSubscription` take `retry: { attempts, delayMs }`
  (`RetryOptions`, `DEFAULT_RETRY`: 3 attempts, 1000 ms doubling, with jitter).
  A send the node refuses for a spent input (`Dead`, `Unknown`, or an RBF
  refusal, `poolConflict`) is built again with another payout cell; the cell a
  `Dead` refusal names is not picked again. It used to be retried once, with no
  wait, and only with a client cache. A send whose outcome is unknown is still
  never retried.
- `SessionBalanceError` reason `"payout-busy"`: every payout cell checked is
  spent in the pool and none is left. Nothing is sent; it is retried like a
  refusal. The demo's charge route answers it with 503 and retry.
- `createPayoutCells(funder, payTo, { count, capacity?, token? })` gives an
  anyone-can-pay address more cells to top up. `npm run setup:creator` uses it
  and now gives the demo's creator eight cells (was three).
- `clearPlantedCells(subscriber, deployment, subscription)`: the subscriber
  sweeps cells a third party created under the subscription's lock back to
  itself, keeping the subscription's own cells, so it no longer has to cancel
  and open again past `MAX_SUBSCRIPTION_CELLS`.

### Changed (mentor review, 2 Nov)
- `assertSigningLock` accepts only reviewed owner lock configurations:
  secp256k1, multisig (v1, v2), Omnilock with auth 0x00-0x06 or 0x12 and no
  mode other than time-lock or supply, the Nostr lock in signing mode
  (`args[0]` = 0), and JoyID. The wallet matrix's locks all still pass.
- PW-Lock is now refused. The build deployed on mainnet and testnet is
  lay2dev/pw-lock's anyone-can-pay variant: with no signature in the witness it
  unlocks by payment, whatever the args, so anyone could sweep every session.
- The Nostr lock in proof of work mode (`args[0]` not 0) is now refused: it
  unlocks with work, not the holder's key.
- Anyone-can-pay is refused by code hash on both networks (and the older
  deployments pw-core lists), whatever the client's network; always-success
  too. These refusals carry `reason: "owner-lock-unsafe"`.
- Locks and configurations not reviewed (Omnilock auth 0xFC-0xFE, other Omnilock
  auth flags or mode bits, the ckb-proxy-locks, unknown locks, args the lock's
  code would not accept, multisig v2 beta) are refused with
  `reason: "owner-lock-unreviewed"`. Omnilock auth 0x07 and unknown Omnilock mode
  bits used to pass.
- Subscription cells are listed with the indexer's type filter (no type, or the
  subscription's token), so cells under any other type script no longer count
  toward `MAX_SUBSCRIPTION_CELLS`.
- The last charge is the newest spend with an input under the charger's lock,
  not any spend: a `clearPlantedCells` does not delay the next charge. A spend
  that cannot be told apart still counts as a charge.
- Chained payments are not used; the README says why.

### Added
- `openSession` warns when a session has no rate limit (`minInterval` left out
  or 0): every spend is within `maxPerTx`, but spends can repeat every block
  until the session is empty. The warning (`SessionWarning`, code
  `"no-rate-limit"`) goes to the new `opts.onWarning` before anything is
  signed, which may throw to stop the opening, or to `console.warn` without one.
  The demos' sessions open with no rate limit, so they now warn in the console.
- 23 CKB-VM tests of aggregate outflow across inputs (mentor review, 2 Nov):
  cells with the same args share one limit per transaction (CKB and token), a
  subscription's merged cells pay one price, cells with other args are checked
  on their own, and owner mode sweeps several cells at once. No fault found; the
  lock is unchanged.
- README and SECURITY-EVIDENCE: browser expiry revokes nothing on chain (funds
  stay at risk until the owner's sweep is confirmed); a period is a block count,
  not a fixed duration; the aggregate-outflow behaviour.
- `allowUnreviewedOwnerLock` (`SigningLockOptions`) on `assertSigningLock`,
  `openSession` and `openSubscription`: lets an unreviewed owner or charger lock
  through with a `console.warn`. It never lets an "owner-lock-unsafe" lock
  through.
- `SessionPolicyReason` gains `"owner-lock-unsafe"` and `"owner-lock-unreviewed"`.
- `SessionBalanceError.reason` (`SessionBalanceReason`): `"no-fee-cell"` or
  `"no-payout-cell"` when the cells missing are the payer's or the recipient's own
  (a charger with no fee cell, a `payTo` with no cell to top up), so a server can
  tell them from the subscription's state without matching messages. The demo's
  charge route now uses it.
- `SessionPolicyError.reason` (`SessionPolicyReason`): `"payto-not-anyone-can-pay"`
  when a charge needs to top up `payTo` and `payTo` is not anyone-can-pay. The
  demo's charge route answers it with 503 (the deployment's setup, not the
  subscription's state) instead of 409.

### Fixed (audit round 2, 31 Oct)
- Demo: enforced CSP now also sets `object-src 'none'`, `base-uri 'none'` and
  `form-action 'self'`; the full policy (scripts, styles, images, testnet RPC and
  JoyID aggregator only) is sent as `Content-Security-Policy-Report-Only`.
- CI: GitHub actions pinned to commit SHAs, checkouts with
  `persist-credentials: false`.
- `openSession` and `openSubscription` refuse `TESTNET_LEGACY_DEPLOYMENTS`
  (`assertCurrentDeployment`, new). `openSession` used to accept them: a token
  session under the 13 Oct lock was stuck for good (that code refuses 128/160-byte
  args before owner mode), and new sessions under the 8 Oct one lacked errors
  16-18. Spending, closing, recovering, charging and cancelling still accept old
  deployments, so funds under them can come back.
- Before building an opening, the deployment's cell dep is read from the
  client's network (`getCellLive`; a dep group is resolved) and must hold code
  hashing to `codeHash` (data hash, or type hash for `hashType: "type"`).
  `TESTNET_DEPLOYMENT` on a mainnet client, a typo in `codeHash` or a wrong out
  point used to put funds under a lock with no code. One lookup per client and
  deployment. `hashType: "data"` is refused too: the lock faults under CKB-VM
  version 0. There is still no mainnet deployment; README and API.md say how to
  pass your own.
- `spendInSession` and `chargeSubscription`: a key or charger cell above its
  floor but short of the fee threw CCC's plain "Insufficient CKB"; it is now
  `SessionBalanceError` with reason `"no-fee-cell"`. The charger's fee cells must
  hold at least the floor plus 0.01 CKB. Found by the round-2 property suite,
  added in `test/property-library.test.ts` and `test/property-fuzz.test.ts`,
  which now fails on any plain error.
- `addTopUp` (top-ups in `spendInSession`, `chargeSubscription`,
  `openSubscription`) skips a payee token cell the payment would take past
  2^128 - 1 units, and throws `SessionBalanceError` `"no-payout-cell"` if every
  cell would, instead of a plain overflow error.
- `closeSession` refuses a signer whose lock is not `binding.ownerLock` with a
  `SessionPolicyError`, before asking it to sign. After a wallet switch, the
  new wallet was shown a sweep of the old wallet's session to itself (the lock
  refused it on-chain, so nothing was lost).
- `closeSession` can finish once the session is empty on-chain: with the
  funding committed and nothing indexed, it asks the node whether the funding's
  outputs under the session and the key are still live, and reports
  `nothingFound` when all are spent. Before, a close whose key return was taken
  but whose reply was lost (or a close from a second tab) left a key that could
  never be forgotten. The key return now goes through `signAndSend`, so a lost
  reply the node did take is reported as `keyTx`.
  It reports `nothingFound` only once the node's indexer has reached the tip
  and a second search still finds nothing, so a later spend's key cell that is
  not indexed yet never lets the key be forgotten.
- CCC's client cache lists a client's own outputs as live until cleared, so a
  tab (or a warm server instance) built every later spend on cells another tab
  had spent, and the node rejected each one. `spendInSession`, `closeSession`,
  `chargeSubscription` and `cancelSubscription` now leave out cached-only cells
  the node no longer has, and on a rejection for a spent or unknown input clear
  the cache and build the transaction once more.
- `verifyAccess`, `verifySubscription` and `subscriptionStatus` read payments
  with `getTransactionNoCache`. `getTransaction` answers from the cache when
  the node no longer knows a transaction, so a payment that was reorged out kept
  granting access on a long-lived server client.
- Demo: one "unknown" answer just after a lost send no longer makes a page
  forget the session key (about 62 CKB stranded once the funding lands) or a
  payment record. A key or record is forgotten only when the node rejected the
  transaction, or has not known it for 10 minutes (the rule the payment polls
  already used); meanwhile the page keeps polling it.
- Demo: every page's wallet lookup drops a late answer from the previous
  wallet, and the subscribe page drops a status refresh started for the
  previous wallet, asset or opening, and clears its status and notes on
  disconnect.
- Demo: the CKB Place board asks again about a placement `get_transaction`
  missed once, instead of leaving it off the board until a reload.
- Demo: the charge route builds a new CCC client per request.

### Fixed (security audit, 30 Oct)
- `recoverSessions`: when the one sweep is refused, sessions are now swept one
  session lock at a time (full lock hash), not one session key hash at a time. A
  planted cell under other args carrying the victim's public key hash (a foreign
  type script the sweep cannot consume) joined the victim's group and blocked its
  recovery on every retry. `findOwnedSessionCells` keeps a typed cell only if its
  type is a plain xUDT on the network (`assertPlainXudt`'s rules) holding exactly
  the 16-byte amount a session makes.
- `spendInSession` pays the fee from the largest key cell (ties: lowest out
  point), not the first one listed: a 61 CKB cell anyone sent to the key address,
  or the old key cell beside a top-up, blocked every spend. Still one key cell in
  and one smaller one out, as the lock requires.
- `verifyAccess` and `checkPlacement` count only memos in witnesses a signature
  covers: the first witness of each secp256k1 lock group, and any past the
  inputs. The session cell's and an anyone-can-pay cell's witnesses are signed by
  nobody, so whoever relayed a payment could add a memo there and void it for
  good (or, on a CKB Place board, choose the pixels of a payment without one).
  Several signed memos still fail. `placementMemo` takes the resolved inputs as
  an optional third argument for the exact check; without them it is a prefilter.
- Docs: with a recipient set, up to `max_per_tx` per transaction can still leave
  as the miner fee (the recipient rule covers outputs only). The README and
  `openSession` now say so and recommend a rate limit (`minInterval`) whenever a
  recipient is set. The lock is unchanged.
- `subscriptionStatus`, `chargeSubscription` and `findSubscriptionCells` read at
  most `MAX_SUBSCRIPTION_CELLS` (16, exported) cells under a subscription's lock,
  and at most 64 recent transactions of its history. Beyond that they throw
  `SessionPolicyError` with the new reason `"too-many-cells"` instead of reading
  part of the cells, which could deny a paid-up subscriber or let a cell left out
  of a charge pay a second price in the period. Planted cells (anyone can create
  them) made each status request look up every creating transaction and all its
  inputs again: 100 cells cost 3,307 RPC calls. `cancelSubscription` still reads
  and sweeps every cell, so the subscriber can clear planted ones.
- Subscription payments are checked once per transaction within a call, and a
  transaction whose outputs to `payTo` already fall short is refused before its
  inputs are looked up.
- `chargeSubscription` picks its fee cell from the first 64 cells under the
  charger's lock instead of reading all of them.
- Demo: `/api/subscription` answers `"too-many-cells"` with 409 (the page shows
  it), not 503 with retry.
- Demo: the charger address is the creator's key, so `CHARGER_KEY` on the server
  could spend the creator's income and payout cells. New `npm run setup:charger`
  creates a separate key (`.env.charger`, written once, mode 0600) and prints its
  address and next steps; the docs now require a charger key of its own holding
  only fee cells. `CHARGER` is replaced once that key is funded and set on Vercel.

### Fixed (30 Oct)
- `chargeSubscription` and `nextChargeIn` date the last charge from the
  subscription lock's indexer history, not from its change cell: a charge of the
  whole balance (the last 153 CKB with a price of 153 CKB or more) leaves no
  change, so a younger top-up could pay a second price under a period later.
- `subscriptionStatus` counts that last whole-balance charge as a paid period;
  it used to end access as soon as the last period was paid. A cancel still ends
  access at once.

### Fixed (code review, 28 Oct)
- Token overflow guard: a planted cell of 2^128-1 free tokens could push the
  subscriber's own cell out of a cancel (the guard kept cells in indexer order), and
  blocked `closeSession` and `recoverSessions` of token sessions (no guard at all).
  One guard now serves sessions, recovery and subscriptions; it keeps cells created
  by the owner or the key first.
- `recoverSessions`, `closeSession`, `cancelSubscription`: an owner sweep the node
  accepted is reported as sent even when the reply times out (it skipped the
  check `signAndSend` does). `recoverSessions` now throws when the owner holds no
  plain cell, instead of reporting every session as failed.
- `chargeSubscription` waits a full period after the last charge, not only after
  the oldest cell: a top-up cell older than the last charge's change could pay a
  second price in the same period. `nextChargeIn` counts the same way.
- Session stores: a save of the same key without the on-chain binding (from a
  stale tab) is refused with `SessionStoreConflict` instead of dropping the binding.
- Demo: the charge route answers 503 with `retry` when the creator's own cells are
  missing (no fee cell for the charger, no payout cell to top up), not 409.
- `chargeSubscription` pays its fee from a random one of the charger's cells, and a
  CKB `openSubscription` tops up a random payout cell, so concurrent charges and
  openings rarely compete for one cell.

### Changed
- `verifyAccess` resolves a payment's inputs in parallel once the memo check
  passes; subscription charges and status fetch each creating transaction once.

## 1.0.0 (2026-10-27)

First stable release. Everything below is on testnet, with a smoke script and explorer
links in the README.

### Session lock (Rust)
- Delegates to a standard owner lock; in session mode it enforces a per-payment
  outflow limit, an optional recipient, and a per-cell rate limit (`min_interval`).
- Refuses splitting (error 16), a growing key cell when a recipient is set (17), and
  type scripts in session mode (18).
- Token sessions (xUDT): a per-payment limit in token units (20); tokens always come
  back as tokens (19).
- Current testnet deployment exported as `TESTNET_DEPLOYMENT`; earlier ones stay in
  `TESTNET_LEGACY_DEPLOYMENTS` so old sessions remain sweepable.

### Library
- `openSession`, `spendInSession`, `closeSession`: one owner signature to open, none to
  pay, one to close. Keys are saved before funding (`beforeSend`).
- Browser stores (`indexedDbStore`) that refuse cross-tab overwrites.
- Device-loss recovery: `recoverSessions` / `findOwnedSessionCells` sweep every
  session back with the owner's wallet alone.
- Pay-per-read: payments top up the creator's anyone-can-pay cell; `paymentMemo`,
  `signAccess`, `verifyAccess` check paid access on-chain, in CKB or tokens, with no
  database. One payment, one claim.
- CKB Place: a pixel board rebuilt from the chain (`place` exports).
- Subscriptions on the same lock: the creator charges a fixed price once per period,
  the subscriber cancels alone; paid in CKB or in a plain xUDT token.

### Docs and demo
- `docs/API.md` (a test checks every export is documented), runnable `examples/`,
  `docs/WALKTHROUGH.md`, a "Limits" section in the README.
- Demo at ckb-session-kit.vercel.app: pay-per-read (CKB and tokens), CKB Place,
  pay-per-minute, subscriptions (CKB and tokens), recovery.
