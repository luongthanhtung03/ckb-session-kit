# API reference

Everything `ckb-session-kit` exports, grouped by what you are doing. Amounts are
in shannons (`bigint`; 1 CKB = 100,000,000). A test fails if an export is missing
from this page. Runnable examples: [`examples/`](../examples).

## A session key

### `createSession(policy, options?) → Session`
Generates a session key in memory (Web Crypto, rejection-sampled into a valid
secp256k1 scalar). `policy.expiresAt` must be a valid future date;
`policy.scope.maxPerTx` must be positive; `policy.scope.recipients`, if given,
non-empty. Throws `SessionPolicyError`. `options.now` and `options.randomBytes`
exist for tests.

### `isActive(session, now?) → boolean`
Whether `now` is before `expiresAt`. Expiry is enforced off-chain only: a CKB
script can prove time has passed, never that it has not.

### `checkRequest(session, { to, amount }, now?) → ScopeCheck`
The browser-side scope check: active, `amount` positive and at most `maxPerTx`,
`to` in `recipients` if set. `{ ok: true }` or `{ ok: false, reason }`. Runs
before any network call; the session lock checks again on-chain.

### Types: `Session`, `SessionPolicy`, `SessionScope`, `CreateOptions`, `ScopeCheck`
`Session` is `{ privateKey, publicKey, policy, onchain? }`. `onchain` is the
`OnChainBinding` set once the session is opened.

### `SessionPolicyError`
Thrown by `createSession` for a policy it refuses, and by `onchainRecipient` for
a scope the lock cannot enforce.

## On-chain sessions

### `openSession(owner, session, deployment, opts) → { txHash, binding }`
The owner's wallet funds a session cell (`opts.budget`) and a key cell
(`opts.feeBudget`) in one transaction: one signature. The key cell must be able
to go back to the owner at the end, so by default it is a cell under the owner's
lock plus 1 CKB (62 CKB for a secp256k1 owner, 64 for JoyID or Omnilock, whose
cells need 63), and a smaller `feeBudget` is refused. `opts.minInterval` sets
the on-chain rate limit in blocks. `opts.beforeSend(binding)` runs after the
transaction is signed and before it is sent: save the session there, so funds
never sit under a key that exists nowhere. The binding carries `openTx`, the
funding transaction's hash. Set `session.onchain = binding` afterwards. If the
send throws but the node did take the transaction, `openSession` returns
normally. A session cell occupies
121 CKB (153 with a recipient), which stays locked as the cell itself.

`opts.token: { type, amount, maxPerTx }` opens a token session: the session
cell also holds `amount` units of the xUDT `type` (taken from the owner's
cells, any surplus returned), and one spend may move at most `maxPerTx` units,
enforced by the lock. Only plain xUDT is accepted (`assertPlainXudt`). A token
session cell occupies 250 CKB (282 with a recipient).

### `spendInSession(session, client, deployment, binding, { to, amount | token, topUp?, memo?, beforeSend? }) → txHash`
The session key pays, no wallet involved. Checks the scope first (`ScopeError`),
then the network checks it again in the lock. A plain payment creates a cell, so
it is at least 61 CKB; `topUp: true` pays any amount into an existing
anyone-can-pay cell of `to`. `memo` goes into the key cell's witness, which the
key signs: see `verifyAccess`. Throws `SessionBalanceError` when the balance,
the change or the key cell would fall below what a cell needs (for the key
cell: what it needs to go back to the owner). `beforeSend(txHash)` runs with
the final hash before the payment is sent: record the payment there, so it is
never sent unrecorded.

In a token session, `{ to, token }` pays `token` units instead of shannons:
with `topUp: true` into the recipient's anyone-can-pay token cell (no CKB
leaves the session), otherwise in a new token cell whose capacity (about 142
CKB) must fit in `maxPerTx`. Tokens always stay in the change; a CKB payment
never burns them.

### `closeSession(owner, session, deployment, binding) → { sweepTx?, keyTx?, keyError?, nothingFound? }`
The owner sweeps the session cells (one signature), then the session key returns
the key cell to the owner. If the key cell cannot be returned, `keyError` says
why and the key should be kept for a retry. `nothingFound` means no cell is
left under the session or the key, and the key can be forgotten. While the
funding transaction (`binding.openTx`) is still pending or not yet indexed it
throws `SessionBalanceError` instead: forget a key only after `keyTx` or
`nothingFound`.

### `recoverSessions(owner, deployments) → { txHashes, recovered, cells, failed }`
Device-loss recovery, with the wallet alone: finds every session cell this owner
opened and sweeps them, in one transaction if it can, else one per session (so a
planted cell spent ahead of the sweep fails alone). Key cells cannot be
recovered without their key.

### `findSessionCells(session, client, deployment, binding) → SessionCells`
The live session cells and key cells of one session, with their totals
(`balance`, `feeBalance`, and `tokenBalance` in a token session).

### `findOwnedSessionCells(owner, deployments) → Cell[]`
Every live, well-formed session cell whose args start with the owner's lock
hash, found without any session key. Typed cells are kept only in token
sessions, and only when they hold that session's token with well-formed data:
anything else could make the sweep fail. Sweeps return tokens to the owner. `deployments` is one
deployment or a list.

### `assertSigningLock(lock, client)`
Throws `SessionPolicyError` unless the owner lock is known to sign the whole
transaction: secp256k1 (single or multisig), JoyID, Nostr, PW lock, or Omnilock
with a signature auth flag and no administrator or anyone-can-pay mode. The
session lock trusts that an input under the owner's lock means the owner
signed. `openSession` calls it; it also refuses a recipient equal to the
session key's own lock.

### `assertPlainXudt(type, client)`
Throws `SessionPolicyError` unless `type` is this network's xUDT with every
args flag clear: no extension scripts, no other owner (minting) modes. `openSession` calls it for `opts.token`.

### `matureCells(client, cells, blocks) → Cell[]`
The cells created at least `blocks` blocks before the tip. `spendInSession`
uses it in a rate-limited session, so a fresh cell (its own last change, or one
a stranger planted under the session lock) is never picked into a spend the
lock would refuse.

### `tokenAmount(data) → bigint`
The xUDT amount in a cell's data: u128 little-endian in the first 16 bytes.

### `onchainRecipient(session) → string | undefined`
The recipient the lock will enforce: `scope.recipients[0]`. More than one
recipient cannot be enforced on-chain and throws `SessionPolicyError`.

### `keyLockOf(session, client)`, `sessionLockOf(session, client, deployment, binding)`
The lock scripts of the key cell and of the session cells.

### Types: `OnChainBinding`, `SessionCells`
`OnChainBinding` is `{ ownerLock, minInterval, recipientLockHash?, token? }`,
where `token` is `{ type, maxPerTx }`.

### `SessionBalanceError`
Not enough in the session, its change, or its key cell, or a budget below what a
cell occupies.

## The session lock

### `TESTNET_DEPLOYMENT`
Where the lock lives on testnet (`codeHash`, `hashType: "data2"`, `cellDep`).
Equal to [`deployment/testnet.json`](../deployment/testnet.json).

### `TESTNET_LEGACY_DEPLOYMENTS`
Earlier deployments, newest first. Deployed code is immutable, so sessions opened
under an earlier version keep its rules until swept; recover with
`recoverSessions(wallet, [TESTNET_DEPLOYMENT, ...TESTNET_LEGACY_DEPLOYMENTS])`.

### `sessionLockScript(deployment, params)`, `sessionLockArgs(params)`, `sessionLockCellDep(deployment)`
Build the lock script, its 80- or 112-byte args
(`owner_lock_hash | session_lock_hash | max_per_tx | min_interval | recipient?`),
and its cell dep. With `params.token: { typeHash, maxPerTx }`, the args are 128
or 160 bytes: `token_type_hash | max_per_tx_token (u128)` before the recipient.

### `relativeBlocksSince(blocks)`
The relative block-number `since` the rate limit requires (RFC 0017).

### `SESSION_LOCK_ERRORS`, `sessionLockErrorFrom(message, sessionInputs?)`
The lock's error codes (10 bad args … 18 type script in session mode, 19
malformed token data, 20 token outflow over its limit) and a
parser that pulls the code out of a node's rejection message. A code from a
type script is not the session lock's and gives undefined; with
`sessionInputs` (the indexes of the session cells) so does one from another
input's lock.

### Types: `SessionLockDeployment`, `SessionLockParams`

## Paid access

### `paymentMemo(label) → Hex`
A memo for `spendInSession`, e.g. `paymentMemo("read:article-1")`.

### `signAccess(session, txHash, memo) → AccessProof`
The payer proves that the key which paid `txHash` is asking.

### `verifyAccess(client, proof, { to, minAmount, memo, token? }) → AccessCheck`
The server's check, with no database: the request is signed by the key that
paid; the payment is committed, carries exactly this memo and no other, and the
recipient gained at least `minAmount`. One payment buys one claim. With
`token` (an xUDT type script) the price is in that token's units: only cells of
exactly that type under `to` count, and CKB counts for nothing (nor tokens
toward a CKB price).

### Types: `AccessProof`, `AccessCheck`

## Subscriptions

The same session lock with the roles moved (docs/design/subscriptions.md): the
subscriber is the owner, the creator's charger key is the session key, the price
is `max_per_tx`, the period is `min_interval`, the payout address is the
recipient. The network lets the charger take at most the price, at most once per
period, only to the payout address; the subscriber can take everything back
alone at any time. No change to the deployed lock.

### `openSubscription(subscriber, deployment, { charger, payTo, price, periodBlocks, budget, account?, beforeSend? }) → { txHash, subscription }`
One transaction, one subscriber signature: the first period's price goes to
`payTo` at once (a new cell cannot be charged for a whole period), and one cell of
`budget` goes under the session lock; no key cell. With `account`,
`subscriptionMemo(account)` is committed in the witness of the subscriber's own
input. Refuses terms the lock would not enforce as meant: a price or period of 0,
`payTo` equal to the charger (every charge would fail with error 17), the
subscriber as charger or payout, a charger lock that needs no signature, an old
deployment of the lock, a live subscription with exactly the same terms, and a
price below a new payout cell's size unless `payTo` is anyone-can-pay. A budget
of 153 CKB plus n prices pays n more periods. Keep a plain cell in the wallet:
cancelling needs one.

### `subscriptionMemo(account) → Hex`
The memo an opening commits to, binding the subscription to one account at the creator: a 32-byte hash, so the account id never appears on-chain.

### `chargeSubscription(charger, deployment, subscription, { payTo, topUp?, beforeSend? }) → txHash`
The charger key takes one price, with the period as the inputs' relative `since`,
and pays it to `payTo` (topping up its anyone-can-pay cell with `topUp`). The fee
comes from one of the charger's own plain cells. Throws `SessionBalanceError`
before a full period (saying how many blocks are left) and once what is left
cannot cover a price plus a cell.

### `cancelSubscription(subscriber, deployment, subscription) → { txHash?, refunded, nothingFound? }`
Owner-mode sweep of everything left; no creator involved, no wait.
`recoverSessions` also finds and sweeps subscriptions.

### `verifySubscription(client, deployment, outPoint, { charger, payTo, price, periodBlocks, minBalance?, account? }) → SubscriptionCheck`
The creator's check, from the chain alone: the cell is live, under this
deployment (never an older one), untyped and without data, 112-byte args with
exactly these terms, at least `minBalance`; and the transaction that created it
paid `payTo` at least one price (the opening, or a charge), so a cell the
subscriber re-created to reset its age is refused. Returns `paidThroughBlock`
(that transaction's block plus one period) and `chargesLeft`. With `account`,
the creating transaction must carry `subscriptionMemo(account)` under the
subscriber's signature: check it once, at registration, on the opening's cell.

### `findSubscriptionCells(client, deployment, subscription) → { lock, cells, balance, nextChargeIn }`
`nextChargeIn` is the number of blocks until a cell is a full period old (0 = it can be charged now).

### `subscriptionLock(deployment, subscription)`
The session-lock script of a subscription.

### `blocksForSeconds(client, seconds, sample?) → bigint`
About how many blocks `seconds` is, from the average block time of the last
`sample` (1000) blocks. An estimate; round up.

### Types: `Subscription`, `SubscriptionCheck`
`Subscription` holds the five terms as lock hashes and numbers, and no private key.

## A shared pixel board (CKB Place)

A board is an anyone-can-pay address. Each placement is a session payment that
tops it up with `price × pixels` and lists the pixels in its memo:
`spendInSession(…, { to: board, amount: placementPrice(n), topUp: true, memo: encodePlacement(pixels) })`.
The board is rebuilt from the chain with no database: find the transactions on
the board's lock, keep those `checkPlacement` accepts, `applyPlacements`. These
functions do no network I/O; the demo's `demo/app/place/chain.ts` does the reading.

Memo format, version 1: the bytes `"px1"` (`0x70 0x78 0x31`), then one
`x u8 | y u8 | colour u8` triple per pixel, 1 to `maxPixels` of them. One bad
triple makes the whole memo invalid.

### `PLACE_BOARD`
The demo's board: `{ width: 32, height: 32, colours: 16, price: 0.1 CKB, maxPixels: 32 }`.
Every function takes a `PlaceBoard` as its last argument and defaults to this one.

### `encodePlacement(pixels, board?) → Hex`
The memo for a placement. Throws `PlaceMemoError` for no pixels, more than
`maxPixels`, or a pixel off the board or outside the palette.

### `decodePlacement(memo, board?) → Pixel[] | undefined`
The pixels in a memo, in order; `undefined` for anything that is not a valid
version-1 memo for this board. Never throws: memos come from anyone. The length
is checked before anything is read, so a memo is at most `3 + 3 × maxPixels` bytes.

### `placementPrice(pixels, board?) → bigint`
`price × pixels`, in shannons.

### `placementMemo(tx, board?) → { index, pixels } | undefined`
The cheap check, before resolving any input: the transaction carries exactly one
memo, in a witness at an input's index, and it decodes.

### `checkPlacement(tx, inputs, boardLock, board?) → PlacementCheck`
Whether a transaction is a valid placement, given its input cells resolved in
order: one valid memo, in the first witness of a lock group that is not the
board's (the witness the payer's lock signs: `spendInSession` puts it on the
key cell), and the board's lock gained at least `price × pixels`, outputs minus
inputs. `{ ok: true, pixels, paid }` or `{ ok: false, reason }`.

### `applyPlacements(placements, board?) → BoardState`
The board after the placements, in chain order (block number, then position in
the block) whatever order they come in; last write wins. A row-major array of
`{ colour, txHash, blockNumber }`, `undefined` where nothing was placed.

### Types: `PlaceBoard`, `Pixel`, `Placement`, `PlacedPixel`, `BoardState`, `PlacementCheck`
`Placement` is `{ txHash, blockNumber, txIndex, pixels }`: a checked placement
and where it sits in the chain.

### `PlaceMemoError`
A placement that cannot be encoded, or a board that does not fit the format
(sides and palette 1–256, positive price).

## Keeping a session between page loads

### `indexedDbStore(idb?, key?) → SessionStore`
One session per `key` in IndexedDB. `save` refuses to replace a different
stored session (`SessionStoreConflict`: another tab got there first); `clear(session)`
forgets it only if it is still the stored one.

### `memoryStore() → SessionStore`
The same contract in memory, for tests and servers.

### `serializeSession(session)`, `deserializeSession(json)`
JSON with bigints and dates preserved; a newer storage version is refused.

### Types: `SessionStore`

### `SessionStoreConflict`
A different session is already stored under this key.

## Off-chain transfers (v0.1)

### `sendInScope(session, client, { to, amount }, now?)`, `sessionAddress(session, client)`, `sessionSigner(session, client)`
The session key as a plain secp256k1 key, with the scope checked only in the
browser. Kept for the v0.1 flow; on-chain sessions use `spendInSession`.

### `ScopeError`
A request outside the session's scope.
