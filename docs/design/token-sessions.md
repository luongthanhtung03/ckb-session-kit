# Design: token sessions

Status: **draft for review. No code until this is reviewed.** The session lock
holds funds and its deployed code is immutable, so the rules are written down,
attacked on paper, and only then built.

## Goal

A session that spends an xUDT token (a stablecoin, game credits, a creator's
token) the way today's sessions spend CKB: the owner signs once, the session key
pays many times with no wallet popup, and the network enforces a per-transaction
limit, an optional single recipient and an optional rate limit, in token units.

Out of scope: several token types in one session; sUDT (same idea, add later if
asked); token issuance or owner-mode tokens.

## Why today's lock refuses tokens

Error 18 exists because the limits count capacity only. With a type script on a
session cell, two attacks worked (both found in review, both proven in CKB-VM):

1. **Token drain at zero outflow.** A typed session cell's tokens could move to
   any output while the CKB capacity stayed put.
2. **Freeze.** A change cell given a type the key controls could later refuse
   every spend, the owner's sweep included.

A token session must close both by construction, not by forbidding types.

## Proposed rules

A new args layout tells the lock which token it guards. Lengths stay
unambiguous, so existing 80/112-byte sessions keep their meaning:

| bytes | field |
|---|---|
| 0..32 | owner_lock_hash |
| 32..64 | session_lock_hash |
| 64..72 | max_per_tx (CKB, u64 LE) |
| 72..80 | min_interval (u64 LE) |
| 80..112 | token_type_hash (32) |
| 112..128 | max_per_tx_token (u128 LE) |
| 128..160 | recipient_lock_hash (optional) |

So 128 bytes = token session, no recipient; 160 = token session with recipient.

Session mode, in addition to rules 1–4 of today's lock:

- **T1. One token, exactly.** Every input in this group either has no type, or a
  type whose hash is `token_type_hash`. The change (at most one output under this
  lock, rule 3) likewise. Any other type → reject (keeps error 18's protection:
  the key cannot attach a type it controls).
- **T2. Token outflow.** `sum(amount of group inputs) − amount of the change ≤
  max_per_tx_token`, where amount is the first 16 bytes of cell data (u128 LE,
  xUDT RFC 0052). Underflow (change holds more than came in) is a top-up: outflow 0.
- **T3. Change data is exactly the amount.** The change's data is exactly 16
  bytes. xUDT extension data is refused, so the key cannot stuff data or change
  how the token script treats the cell. (Untyped change keeps empty data.)
- **T4. Key cell gets no tokens (recipient set).** Outputs under the session key's
  lock may carry the token only up to what inputs under that lock brought in —
  the token version of error 17. Without it, the key parks tokens in its own cell
  and pays anyone from there.
- **T5. CKB limits unchanged.** `max_per_tx` still caps capacity outflow, fees
  included, so a token spend cannot drain the CKB that backs the cells.

The xUDT type script itself still runs and enforces conservation (outputs ≤
inputs per token), so the lock does not need to check where the rest of the
tokens went — only how much left this session.

## Paying in tokens

A new token cell for each payment costs ~142 CKB of capacity, so payments, like
pay-per-read today, should top up the recipient's existing token cell under an
anyone-can-pay lock. **To verify before coding:** that the testnet ACP lock (and
Omnilock in ACP mode) accepts an xUDT top-up from a third party, and the minimum
amounts its args impose.

## Threats, and which rule answers each

| # | Attacker | Attack | Answer |
|---|---|---|---|
| 1 | leaked key | move all tokens, CKB outflow 0 | T2 |
| 2 | leaked key | change typed with an upgradable type it controls → freeze | T1 |
| 3 | leaked key | park tokens in the key cell, pay anyone later | T4 |
| 4 | leaked key | split token change into many cells to beat the rate limit | rule 3 (unchanged) |
| 5 | leaked key | change data stuffed with an xUDT extension | T3 |
| 6 | leaked key | pay fees out of the session's CKB | T5 / rule 1 |
| 7 | anyone | create cells under the session lock with junk tokens or another type | they cannot be spent in session mode alongside real cells (T1); recovery must skip cells whose type is not the session's token (library change) |
| 8 | token issuer | upgrade a `type`-hash-type xUDT, or an owner-mode xUDT | inherent to the token, not the session; document: the owner trusts the token they put in |
| 9 | anyone | a cell with the token type but malformed data (< 16 bytes) | reject in session mode; owner mode sweeps it |
| 10 | leaked key | u128 overflow in sums | checked arithmetic; total supply < 2^128 |

## Open questions for review

1. Should the change be allowed to drop the type (all tokens spent, CKB change
   only)? Proposed: yes, untyped change is fine — nothing to protect.
2. Is "first 16 bytes" right for every xUDT on testnet we care about, including
   ones with extension scripts in args? Proposed: refuse xUDT args with
   extension flags in the token type hash's script — but the lock only sees the
   hash; check the type script's args via load_cell_by_field(Type) on the inputs.
3. Rate limit in token sessions: same per-cell `since` rule; any reason to differ?
4. Library: `openSession` with `{ token: { typeScript, budget, maxPerTx } }`, and
   `spendInSession` with `{ token: amount }`. The demo: pay-per-read in tokens.

## Plan

1. Review this document (community or adversarial agent pass); settle the open
   questions.
2. Verify the ACP top-up for xUDT on testnet (read-only first).
3. Implement T1–T5 in the lock behind the new args lengths; every threat in the
   table gets a CKB-VM test; the existing 33 tests must pass unchanged.
4. Adversarial review of the code; deploy as a new code hash; smoke on testnet.

## Review, 14 Oct 2026 (adversarial pass) — changes adopted

Verdict: T1–T5 hold the bounds against a leaked key, once "amount" is defined
by type. Changes:

- **Amount is type-gated (was the main gap).** `amount(c) = u128 LE of
  data[0..16]` if `type_hash(c) == token_type_hash`, else 0, on every side
  (group inputs, change, T4). Otherwise an untyped change with data `ff…ff`
  underflows T2 into a "top-up" and the key takes everything. A token-typed
  input with fewer than 16 bytes of data is rejected. Checked u128 sums; no
  supply assumption (xUDT owner mode can mint u128::MAX).
- **All token reads after the owner-mode return**, as capacity reads are today,
  so planted junk can never make an owner sweep fail at the lock.
- **T3:** a token-typed change has exactly 16 bytes; an untyped change counts 0.
- **T4:** Σ amount(outputs under the key lock) ≤ Σ amount(inputs under it); a
  key-locked output with the token type and short data is rejected; malformed
  key inputs count 0.
- **Optional (recipient set):** every output not under the key lock is untyped or
  typed `token_type_hash`, so a leaked key cannot pay the recipient in a cell
  typed with a script it controls (bounded griefing, also possible today).
- **Threat 9 corrected:** a token cell with short data can only be made in xUDT
  owner mode (the issuer) and the owner cannot sweep it either; recovery skips it.
- **Threat 8 named:** testnet xUDT with hash_type `type` points at an upgradable
  Type ID cell held by an ordinary key; the `data1` code hash pins the binary.
  `token_type_hash` must be the exact script on the owner's cells (the two
  testnet forms are different tokens).
- **Off-chain checks in openSession:** refuse xUDT args ≥ 36 bytes with extension
  flags (`flags & 0x1FFFFFFF != 0`); refuse owner locks that sign nothing.
- **Already fixed (affected today's sessions too):** an anyone-can-pay owner
  lock, or Omnilock in anyone-can-pay mode, unlocks with no signature and would
  give anyone owner mode. `openSession` now refuses them (`assertSigningLock`).
- **Facts verified:** a third party can top up an xUDT cell under the RFC 0026
  ACP lock with no signature (testnet tx 0x3275381a…b27c, 10,000 units into a
  142 CKB cell); Omnilock-ACP requires at least 1 unit/shannon per top-up. A
  token session cell occupies 250 CKB (128-byte args) or 282 CKB (160-byte).
- **Harness:** token tests need per-cell data and two type modes — a stand-in
  token type to reach the lock's own error codes, and the real xudt_rce + ACP
  binaries for integration (top-up, owner sweep).

Full review: E:\REMOTE\ckb\drafts\token-sessions-review.md (local).
