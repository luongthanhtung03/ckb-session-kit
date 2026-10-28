# Security evidence: the session lock on CKB testnet

This report collects, for each rule the session lock enforces, what the rule is,
where the script checks it, the transactions the network accepted, the
transactions it refused with the node's error text, and the tests that cover it.
It answers the request in
[CKBuilder-projects#47](https://github.com/Nervos-Community-Catalyst/CKBuilder-projects/issues/47).

Every transaction hash below was checked against public testnet with read-only
RPC (`get_transaction`) on 28 Oct 2026: each is committed, and each that touches
a session-lock cell runs the deployment named next to it. `npm run evidence`
repeats that check from the raw logs in [`evidence/`](evidence/).

Labels used below:

- **testnet, current**: refused or accepted by public testnet, on the current deployment.
- **testnet, legacy only**: shown on an earlier deployment, not repeated on the current one.
- **CKB-VM only**: covered by the CKB-VM tests (the same binary, run in ckb-debugger against mocked transactions), never sent to testnet.

## 1. The contract version tested

| | |
|---|---|
| Code hash | `0xab419466529ea479590d4be7b23580ce2ddc640ba902735c9ad9a22dc64c08ce` (`hash_type: data2`) |
| Deploy cell | [`0xf3098bdb…77f2`](https://testnet.explorer.nervos.org/transaction/0xf3098bdb9a7bb1c500990be0f1159b7e66f507fef6b7a4f904046024284877f2) index 0, block 22,736,207, 14 Oct 2026 05:31 UTC. Live; `get_live_cell` data hash equals the code hash; 7,656 bytes |
| Record | [`deployment/testnet.json`](../deployment/testnet.json) |
| Source | [`contracts/session-lock/src/main.rs`](../contracts/session-lock/src/main.rs), last changed in commit `ba1fa58` (14 Oct 2026); deployment recorded in `46c71dc`. The file is unchanged from `ba1fa58` to the commit this report ships in |
| Build | rustc 1.99.0, host `x86_64-pc-windows-gnu`, pinned in [`rust-toolchain.toml`](../contracts/session-lock/rust-toolchain.toml). sha256 of the binary `b08c5bfc4072440d72ea309f77af1418686ca03446558ba8c112bfe70ed09429` |
| CKB-VM tests | [`test/session-lock.test.ts`](../test/session-lock.test.ts), 74 tests, all passing on 28 Oct 2026 against the binary above |

Rebuild and compare with the deployed code (Windows, repository root):

```sh
rustup toolchain install 1.99.0-x86_64-pc-windows-gnu --profile minimal --target riscv64imac-unknown-none-elf
(cd contracts/session-lock && cargo +1.99.0-x86_64-pc-windows-gnu build --release --locked)
npm ci && npm run check:lock-hash
```

Output on 28 Oct 2026:

```
built    : 0xab419466529ea479590d4be7b23580ce2ddc640ba902735c9ad9a22dc64c08ce
deployed : 0xab419466529ea479590d4be7b23580ce2ddc640ba902735c9ad9a22dc64c08ce (data2, deployment/testnet.json)
OK: the build is byte-identical to the deployed session lock
```

Then run the CKB-VM tests (needs `ckb-debugger` on PATH; one test by name with `-t`):

```sh
npx vitest run test/session-lock.test.ts
npx vitest run test/session-lock.test.ts -t "rejects one shannon over max_per_tx"
```

Earlier deployments, kept in `TESTNET_LEGACY_DEPLOYMENTS` (`src/lock.ts`) so
`recoverSessions` can still sweep sessions opened under them:

| Deployment | Code hash | Deploy tx | Lacks |
|---|---|---|---|
| 8 Oct 2026 | `0x1ae8b8f7…26bc20` | [`0xab2e69b8…43d2`](https://testnet.explorer.nervos.org/transaction/0xab2e69b8b97c15bddeb80954edd6d33befcd2fe9e4243377a46f14a3e1c343d2) | errors 16, 17, 18; token sessions |
| 13 Oct 2026 | `0x1cb77242…1590cd` | [`0x37cfe04f…b071`](https://testnet.explorer.nervos.org/transaction/0x37cfe04f64fd4dbec3803a972a51b7080f9ca1a3042535e97b7a756d0e03b071) | token sessions (errors 19, 20) |

## 2. How a rejection is recorded

A transaction the node refuses never gets on chain, so it has no explorer link.
What exists is the node's answer to `send_transaction`, which the smoke scripts
parse and log. Each rejected attempt below is sent against live cells from the
same run, between accepted transactions that do have links. The node's text for
a session-lock refusal has this form (from
[`evidence/2026-10-14-smoke-lock.log`](evidence/2026-10-14-smoke-lock.log), step 3):

```
Client request error TransactionFailedToVerify: Verification failed Script(TransactionScriptError { source: Inputs[0].Lock, cause: ValidationFailure: see error code 12 on page https://nervosnetwork.github.io/ckb-script-e…
```

`source: Inputs[0].Lock` says the lock of input 0 (the session cell) refused,
and the number after `error code` is the session lock's code. In these runs the
lock smoke kept the first 220 characters of the node's text, and the token and
subscription smokes logged only the parsed code. All four scripts now print the
node's full text, so a new run records it in full.

## 3. Rules and evidence

Error codes are from `enum Error` in `main.rs`. Each test name is in
`test/session-lock.test.ts`.

### Spending limit (error 12, outflow exceeds `max_per_tx`)

- **Rule.** In session mode, capacity of the session inputs minus capacity
  returned to the same lock must not exceed `max_per_tx`. Fees count as outflow.
- **Check.** `main.rs`, `if spent.saturating_sub(change) > args.max_per_tx { return Err(Error::OutflowExceeded) }`.
- **Status: testnet, current.**
- **Accepted.** A spend of exactly 100 CKB (`max_per_tx`), session key only:
  [`0xe2fced3a…0a8b`](https://testnet.explorer.nervos.org/transaction/0xe2fced3a5d73059465f0b9400acdf0cba3fc27e441b82d1faebcbe44b1b20a8b)
  (14 Oct, block 22,736,242). Cells funded in
  [`0x12a553c1…a350`](https://testnet.explorer.nervos.org/transaction/0x12a553c12e733a50f18db09edf8112031c9e39b1949e1f11699a67e3e30ba350).
- **Rejected.** 100 CKB plus 1 shannon, same run:
  `rejected by the network: code 12 (outflow exceeds max_per_tx)`, node text
  `... source: Inputs[0].Lock, cause: ValidationFailure: see error code 12 ...`
  ([log](evidence/2026-10-14-smoke-lock.log), step 3).
- **Rejected, adversarial.** A token subscription charge of exactly the price in
  tokens that also moves 1 shannon of CKB (the per-payment CKB limit is 0):
  `refused by the node: error 12, outflow exceeds max_per_tx`
  ([log](evidence/2026-10-26-smoke-subscription-token.log), 26 Oct), between the
  opening [`0xc168cc4f…53ba`](https://testnet.explorer.nervos.org/transaction/0xc168cc4f0122a0c84add3449a261dd400defacffc59934d2c906da60d10353ba)
  and charge 1 [`0x7aa3872f…eb6d`](https://testnet.explorer.nervos.org/transaction/0x7aa3872fec7e32e5b1f4e719d034a0d7310f717aa128642a1bfb2d252efceb6d).
- **CKB-VM tests.** "accepts a spend of exactly max_per_tx, change back to the
  session"; "rejects one shannon over max_per_tx"; "counts the fee as outflow, so
  it cannot be used to drain the cell"; "sums every session cell in the group";
  "does not count change sent to a different session lock as change"; "rejects
  two mature cells in one transaction moving more than max_per_tx together";
  "rejects a top-up larger than max_per_tx"; "rejects charging more than the
  price"; "rejects one shannon of CKB leaving the subscription, even with the
  price exact".
- **Not on testnet:** the fee-as-outflow case is CKB-VM only.
- **Reproduce.** `FUNDER_KEY=0x... npm run smoke:lock`;
  `FUNDER_KEY=0x... CREATOR_KEY=0x... npm run smoke:subscription-token`.

### Token spending limit (error 20, token outflow exceeds `max_per_tx_token`)

- **Rule.** In a token session, token units in the session inputs minus units in
  the change must not exceed `max_per_tx_token`.
- **Check.** `main.rs`, `if token_in.saturating_sub(token_change) > token.max_per_tx { return Err(Error::TokenOutflowExceeded) }`.
- **Status: testnet, current.**
- **Accepted.** 3 units twice to the creator, session key only:
  [`0xa8d1d98f…4a88`](https://testnet.explorer.nervos.org/transaction/0xa8d1d98f8fd5b22cab9fd989b58a39995171e7099b1df5df46292c6ca8f94a88),
  [`0xba27bcc5…b19d`](https://testnet.explorer.nervos.org/transaction/0xba27bcc564c00cdf2b8b3d3badc30091a29f17fbc4ce71bbb84117af6cb7b19d)
  (14 Oct; session opened in
  [`0x7dac7740…105d`](https://testnet.explorer.nervos.org/transaction/0x7dac7740cf9be29cf900085e98f43cb3557e2c956b9946a2d20ddc3dec49105d),
  limit 10 per spend).
- **Rejected.** A hand-built spend of 11 units:
  `11 units: rejected by the network, code 20 (token outflow exceeds max_per_tx_token)`
  ([log](evidence/2026-10-14-smoke-token.log)). The raw node text was not logged in this run.
- **CKB-VM tests.** "accepts paying max_per_tx_token, token change back to the
  session"; "rejects one unit over max_per_tx_token, at zero CKB outflow"; "sums
  tokens across every session cell in the group"; "rejects dropping all tokens
  into untyped change"; "does not read an amount from untyped change (ff..ff
  would underflow into a top-up)"; "rejects one unit over the price"; "the
  session lock still refuses one unit over the limit".
- **Reproduce.** `FUNDER_KEY=0x... npm run smoke:token`.

### Rate limit (error 14, rate limited: input too young)

- **Rule.** If `min_interval > 0`, every session input must carry a relative
  block-number `since` of at least `min_interval`.
- **Check.** `main.rs`, the `args.min_interval > 0` block: `!relative_blocks || since & SINCE_VALUE_MASK < args.min_interval` returns `Error::RateLimited`. The node enforces the `since` itself, so the cell must really have aged that many blocks.
- **Status: testnet, current.**
- **Rejected.** The rate-limited cell (`min_interval` 3) spent with no `since`:
  `rejected by the network: code 14 (rate limited: input too young)`, node text
  `... source: Inputs[0].Lock, cause: ValidationFailure: see error code 14 ...`
  ([log](evidence/2026-10-14-smoke-lock.log), step 4).
- **Accepted.** The same cell with `since` = 3 relative blocks, once mature:
  [`0xe53e4ada…7653`](https://testnet.explorer.nervos.org/transaction/0xe53e4ada7f76d847b7e1883115c9b31851d8962e195cc2eb1fdaeb53e6b07653)
  (block 22,736,245).
- **Rejected, adversarial.** A subscription charge 1 block after opening, period
  10 blocks: `refused by the node: error 14, rate limited: input too young`, in
  both the CKB and the token subscription runs (26 Oct;
  [log](evidence/2026-10-26-smoke-subscription.log),
  [log](evidence/2026-10-26-smoke-subscription-token.log)). The charges a period
  apart were accepted:
  [`0xf98e36b2…db16`](https://testnet.explorer.nervos.org/transaction/0xf98e36b2f5ef1bb86875fb0989e32f25f67807bc95e34aa273b497db5eebdb16)
  and [`0x930beb93…60e0`](https://testnet.explorer.nervos.org/transaction/0x930beb93436c884f679f691a901eec1db4742fd69cd28e8d63b4eb386de260e0)
  (blocks 22,870,797 and 22,870,810, opening at 22,870,783).
- **CKB-VM tests.** "accepts an input aged at least min_interval blocks";
  "rejects an input with no since"; "rejects an input one block too young";
  "rejects an absolute since, which says nothing about the cell's age"; "rejects
  a relative epoch since: the interval is in blocks"; "rejects a second charge
  before the period has passed"; "rejects a charge before the period has passed".
- **Not on testnet:** absolute and epoch `since` values are CKB-VM only.
- **Reproduce.** `FUNDER_KEY=0x... npm run smoke:lock`;
  `FUNDER_KEY=0x... CREATOR_KEY=0x... npm run smoke:subscription`.

### No splitting (error 16, too many change cells)

- **Rule.** A session spend may send at most one output back to the session
  lock, so the key cannot multiply cells to multiply the per-cell rate limit.
- **Check.** `main.rs`, `if change_cells > 1 { return Err(Error::TooManyChangeCells) }`.
- **Status: testnet, current.**
- **Rejected.** The change split into two cells at zero outflow:
  `rejected by the network: code 16 (too many change cells: a session spend may not split the session cell)`,
  node text `... source: Inputs[0].Lock, cause: ValidationFailure: see error code 16 ...`
  ([log](evidence/2026-10-14-smoke-lock.log), step 6).
- **Accepted, same session.** Steps 2 and 5 above (one change cell each).
- **CKB-VM tests.** "rejects splitting one session cell into two, even with zero
  outflow"; "rejects a payment that also splits the change"; "accepts merging two
  mature cells into one, outflow summed across both"; "still lets the owner
  split, since owner mode ignores the scope"; "rejects splitting token change".
- **Reproduce.** `FUNDER_KEY=0x... npm run smoke:lock`.

### Recipient restriction (errors 13 and 17)

- **Rule.** With a recipient set, every output must be locked by the session
  lock (change), the session key's lock (its key cell), the owner, or the
  recipient (error 13). Outputs under the key's lock may hold no more than the
  key's inputs brought in (error 17), so the key cannot park session funds in its
  own cell and pay anyone from there.
- **Check.** `main.rs`, `else if lock != recipient && lock != args.owner_lock_hash { return Err(Error::RecipientNotAllowed) }`
  and `if key_out > key_in { return Err(Error::KeyCellGrew) }` (tokens: `key_token_out > key_token_in`).
- **Status, error 17: testnet, current.**
  - **Rejected.** A recipient-scoped cell moving 50 CKB into the key cell:
    `rejected by the network: code 17 (the key cell may not grow in a session spend)`,
    node text `... source: Inputs[0].Lock, cause: ValidationFailure: see error code 17 ...`
    ([log](evidence/2026-10-14-smoke-lock.log), step 7).
- **Status, error 13: CKB-VM only.** No testnet run sends a payment to a third
  party from a recipient-scoped session. The library refuses such a payment
  before signing (`spendInSession` checks the scope), so the network never sees
  it; that browser-side refusal was shown on testnet only on the 8 Oct
  deployment (README, pay-per-read run of 9 Oct).
- **Accepted, recipient-scoped, current.** Payments that went only to the
  recipient: token payments
  [`0xa8d1d98f…4a88`](https://testnet.explorer.nervos.org/transaction/0xa8d1d98f8fd5b22cab9fd989b58a39995171e7099b1df5df46292c6ca8f94a88)
  and [`0xba27bcc5…b19d`](https://testnet.explorer.nervos.org/transaction/0xba27bcc564c00cdf2b8b3d3badc30091a29f17fbc4ce71bbb84117af6cb7b19d)
  (session paying only the creator), and the subscription charges
  [`0xf98e36b2…db16`](https://testnet.explorer.nervos.org/transaction/0xf98e36b2f5ef1bb86875fb0989e32f25f67807bc95e34aa273b497db5eebdb16)
  and [`0x930beb93…60e0`](https://testnet.explorer.nervos.org/transaction/0x930beb93436c884f679f691a901eec1db4742fd69cd28e8d63b4eb386de260e0)
  (recipient = the creator's payout address).
- **CKB-VM tests.** "accepts paying the allowed recipient"; "accepts returning
  funds to the owner"; "rejects paying anyone else, even within the limit" (13);
  "rejects the charge going anywhere but the payout address" (13); "rejects the
  charge going to anyone but the payout address" (13); "accepts the key cell
  coming back smaller (it paid the fee)"; "rejects moving session funds into the
  key cell" (17); "rejects a new key-locked cell funded from the session" (17);
  "rejects a payout address equal to the charger key: the charge would grow the
  key cell" (17); "rejects moving session tokens into the key cell (recipient
  set)" (17); "lets the key cell keep tokens it already held (recipient set)".
- **Reproduce.** `FUNDER_KEY=0x... npm run smoke:lock` (17).

### No type scripts (error 18, typed cell)

- **Rule.** In a plain session, session inputs, their change and payments to the
  recipient carry no type script; in a token session, none but the session's own
  xUDT. A change cell typed by a script the key controls could later refuse every
  spend, the owner's sweep included.
- **Check.** `main.rs`, the `Error::TypedCell` returns: on group inputs (`has_type` / `Held::Other`), on the change output, and on payments to the recipient or owner.
- **Status: testnet, current.**
- **Rejected, adversarial.** The change given a valid Type ID type script (so
  only the session lock objects):
  `rejected by the network: code 18 (session cells and their change may not carry a type script (in a token session: none but the token))`,
  node text `... source: Inputs[0].Lock, cause: ValidationFailure: see error code 18 ...`
  ([log](evidence/2026-10-14-smoke-lock.log), step 8).
- **CKB-VM tests.** "rejects change given a type script, even at zero outflow";
  "rejects spending a typed session cell"; "rejects paying the recipient in a
  typed cell"; "rejects change typed with a script the key controls"; "rejects
  spending a session cell typed with something other than the token"; "rejects
  paying the recipient in a cell typed by another script (recipient set)"; "a
  plain (80/112-byte) session still refuses a token cell"; "owner mode may still
  sweep a typed cell (the type script decides for itself)".
- **Not on testnet:** typed recipient payments and typed session inputs are CKB-VM only.
- **Reproduce.** `FUNDER_KEY=0x... npm run smoke:lock`.

### Owner mode and recovery (no error code: the owner path)

- **Rule.** If any input is locked by the owner's lock, the session lock accepts
  the transaction whatever it does: revoke, sweep, top up. This is how a session
  is closed, how a subscriber cancels, and how `recoverSessions` sweeps sessions
  whose keys are lost.
- **Check.** `main.rs`, `if owner_present { return Ok(()) }`, evaluated before any
  session rule. The key-cell sum computed before it saturates instead of
  failing, so an oversized key cell cannot block an owner sweep.
- **Status: testnet, current.**
- **Accepted, owner sweep ignoring the scope.** The three session cells (one
  rate-limited, one recipient-scoped) and the key cell swept back in one
  transaction, no `since`:
  [`0x8019404b…6bae5`](https://testnet.explorer.nervos.org/transaction/0x8019404b3708050660b921201ec534cc7f20ef68fa1e836012d33f531066bae5)
  ([log](evidence/2026-10-14-smoke-lock.log), step 9).
- **Accepted, recovery without the session keys, with a decoy.** Two sessions
  (one recipient-scoped with 112-byte args, opened in
  [`0xc19557c5…be94`](https://testnet.explorer.nervos.org/transaction/0xc19557c5cd99a983607d8246671bae1013ea7ab7575c0004fbe124f7a0cabe94);
  one plain, last spent in
  [`0xb93c673a…df34`](https://testnet.explorer.nervos.org/transaction/0xb93c673a25f7a55a874e9febca06dfa99161adffb2f0d1055c0c89abcbd1df34)).
  An attacker-style decoy cell under the session lock with malformed args that
  start with the owner's hash was planted in
  [`0x5da6f0fc…a2b4`](https://testnet.explorer.nervos.org/transaction/0x5da6f0fc022fc8b57f3027353c05655df922bef41bc72f678a07f4eff566a2b4).
  Both keys were dropped; the owner's wallet alone found both sessions, skipped
  the decoy, and swept 389 CKB back in one transaction with one signature:
  [`0x69022300…427e`](https://testnet.explorer.nervos.org/transaction/0x690223009970442db6de2135a8ef2242e0ae2eff2efd6e016fab8f50cee2427e)
  ([log](evidence/2026-10-14-smoke-recover.log)). The decoy cell is still live
  and unspendable (checked with `get_live_cell` on 28 Oct). The log starts at the
  decoy step; the two session cells above were read from the sweep's inputs.
- **Accepted, subscriber cancels alone.**
  [`0x235c9d2e…9c4f`](https://testnet.explorer.nervos.org/transaction/0x235c9d2e4fc2205fa552c144890002f611c362402b62ceb1dc8540160c459c4f)
  (153 CKB back) and the token subscription
  [`0x9121f5f3…5f51`](https://testnet.explorer.nervos.org/transaction/0x9121f5f3bcd7614a2c191ec99550bf57f56117733cdd670a3e2fb300f9c05f51).
- **Accepted, owner sweeps across owner lock types (26 Oct).** secp256k1
  [`0xd9336db9…61f4`](https://testnet.explorer.nervos.org/transaction/0xd9336db92d25b50f4f42cb715c8b1f84bca40c30d3cff9638108bd6021ad61f4),
  Omnilock Ethereum auth
  [`0xe5bc64e9…1170`](https://testnet.explorer.nervos.org/transaction/0xe5bc64e9980482c5eeeb832a204fa9142006b64badc97f6f845f328ecc0f1170),
  Omnilock Bitcoin auth
  [`0x5f7f4d69…056f`](https://testnet.explorer.nervos.org/transaction/0x5f7f4d69404be44a09bc0d35e40890e85e1c16ab70fefb20926ae516c4f4056f),
  Omnilock Dogecoin auth
  [`0x356fb5f1…d260`](https://testnet.explorer.nervos.org/transaction/0x356fb5f179bb2aee0d396b1933840eb6c96b693907d68deaf78970934a2cd260),
  Nostr lock
  [`0x05dfbc09…7e62f`](https://testnet.explorer.nervos.org/transaction/0x05dfbc0979d09a784d4943d49ecbfcb6a5d718c01a620816b4cdb0bc4f57e62f)
  ([log](evidence/2026-10-26-wallet-matrix.log),
  [log](evidence/2026-10-26-wallet-matrix-evm.log); the first log's Ethereum row
  failed on a library check that was then fixed, and the second log is the re-run).
- **Legacy only.** The README's device-loss run of 9 Oct
  ([`0x4efd8b78…eeaf`](https://testnet.explorer.nervos.org/transaction/0x4efd8b7875c8a0f2883ac2b21ed509ff86c72012e6f4a24816783aa25e02eeaf))
  ran on the 8 Oct deployment.
- **CKB-VM tests.** "owner mode: the owner may sweep everything, ignoring the
  scope"; "owner mode ignores key cells whose capacities overflow a u64
  together"; "owner mode sweeps a malformed token cell and a foreign-typed cell";
  "lets the subscriber cancel alone, at any time, with no wait"; "lets the
  subscriber cancel alone, at any time, sweeping the tokens back"; "the owner
  sweeps every token back". Library tests in `test/recover.test.ts` (mocked
  client, not CKB-VM): "sweeps everything in one transaction when it can"; "falls
  back to one sweep per session when a planted cell is spent first".
- **Reproduce.** `FUNDER_KEY=0x... npm run smoke:recover`;
  `FUNDER_KEY=0x... npm run matrix:wallets`.

### Authorisation, args and data checks (errors 10, 11, 15, 19): CKB-VM only

None of these has been triggered on testnet. They are covered by CKB-VM tests
against the deployed binary:

| Code | Meaning | Check in `main.rs` | CKB-VM tests |
|---|---|---|---|
| 10 | bad args | `parse_args`: args not 80, 112, 128 or 160 bytes | "rejects args that are too short / between the two valid lengths / between the plain and the token lengths / between the two token lengths / too long" |
| 11 | not authorised | `if !session_present { return Err(Error::NotAuthorized) }` | "rejects a spend with neither the owner nor the session key present"; "rejects a stranger's input posing as authorisation" |
| 15 | capacity overflow | `checked_add(...).ok_or(Error::CapacityOverflow)` on every sum | "rejects inputs whose token amounts overflow u128" |
| 19 | token data | token cell with under 16 data bytes, or token change not exactly 16 | "rejects token change carrying extension data"; "rejects token change with under 16 data bytes"; "rejects a token-typed session input with under 16 data bytes"; "rejects a key-locked token output with short data (recipient set)" |

On testnet, the recovery run's decoy cell (malformed args) is the one instance
of error 10's subject on chain: it is live and has never been spent, but no
transaction spending it was sent, so there is no node rejection for it.

## 4. Summary

| Rule | Code | Testnet, current | Raw node text logged | CKB-VM |
|---|---|---|---|---|
| Spending limit (CKB) | 12 | rejected and accepted | yes (first 220 characters) | yes |
| Spending limit (token) | 20 | rejected and accepted | no, parsed code only | yes |
| Rate limit | 14 | rejected and accepted | yes (first 220 characters) | yes |
| No splitting | 16 | rejected | yes (first 220 characters) | yes |
| Recipient: key cell may not grow | 17 | rejected | yes (first 220 characters) | yes |
| Recipient: pay only the recipient | 13 | accepted only (no third-party attempt) | - | yes |
| No type scripts | 18 | rejected | yes (first 220 characters) | yes |
| Owner sweep, recovery, cancel | - | accepted (with decoy, keys lost) | - | yes |
| Args, authorisation, overflow, token data | 10, 11, 15, 19 | not run | - | yes |
| Expiry | - | not enforceable on chain | - | - |

The 8 Oct deployment's lock smoke
([log](evidence/legacy-2026-10-08-smoke-lock.log)) showed errors 12 and 14 on
that older code; it is kept for history and is not evidence for the current
deployment.

## 5. Not covered, and limits

Consistent with the README's [Limits](../README.md#limits):

- **Not audited, testnet only.** The lock has had community and adversarial
  reviews, each finding fixed with a regression test, but no external audit.
- **Expiry is not on chain.** A CKB script cannot prove that time has not
  passed; `expiresAt` is checked in the browser. A leaked key stays valid until
  the owner sweeps, within `max_per_tx`, the recipient and the rate limit.
- **The rate limit is per cell.** The lock forbids splitting, but anyone may add
  cells under a session lock with their own money, giving the key more cells to
  spend from in the same block.
- **An owner sweep can be raced.** The key holder can replace a pending sweep by
  paying a higher fee. No testnet run here races a sweep.
- **The key cell is not recoverable without the key.** Recovery sweeps every
  session cell; the key cell (the fee budget) needs the key.
- **Owner locks must need a signature.** The lock treats any input under the
  owner's lock as the owner's consent; an anyone-can-pay owner lock would give
  anyone owner mode. `openSession` refuses one; the lock itself cannot tell.
- **Gaps in this evidence.** Error 13 (third-party payment) and errors 10, 11,
  15 and 19 have not been sent to testnet; the token limit's rejection has no raw
  node text; the other rejections keep only the first 220 characters of the
  node's text. A new run of the smoke scripts records the full text.

## 6. Re-checking this report

```sh
npm run evidence
```

reads every log in [`docs/evidence/`](evidence/), prints each step and each
rejection code, and checks every transaction hash on public testnet with
read-only RPC: committed, its block and time, and which session-lock deployment
it runs. It also checks that the deploy cell is live and its data hash equals
`codeHash`. It exits 1 if a hash is not committed or a log not named `legacy-*`
contains a transaction on another deployment. `CKB_RPC` selects another testnet
node. It sends nothing.
