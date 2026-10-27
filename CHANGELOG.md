# Changelog

This project follows [semantic versioning](https://semver.org/). The session lock is
deployed on CKB **testnet only**; there is no mainnet deployment yet.

## 1.0.0 (unreleased)

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
