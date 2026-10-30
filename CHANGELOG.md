# Changelog

This project follows [semantic versioning](https://semver.org/). The session lock is
deployed on CKB **testnet only**; there is no mainnet deployment yet.

## Unreleased

### Added
- `SessionBalanceError.reason` (`SessionBalanceReason`): `"no-fee-cell"` or
  `"no-payout-cell"` when the cells missing are the payer's or the recipient's own
  (a charger with no fee cell, a `payTo` with no cell to top up), so a server can
  tell them from the subscription's state without matching messages. The demo's
  charge route now uses it.
- `SessionPolicyError.reason` (`SessionPolicyReason`): `"payto-not-anyone-can-pay"`
  when a charge needs to top up `payTo` and `payTo` is not anyone-can-pay. The
  demo's charge route answers it with 503 (the deployment's setup, not the
  subscription's state) instead of 409.

### Fixed (security audit, 30 Oct)
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
