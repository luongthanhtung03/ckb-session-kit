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
(`opts.feeBudget`, default 62 CKB, must exceed 61) in one transaction: one
signature. `opts.minInterval` sets the on-chain rate limit in blocks.
`opts.beforeSend(binding)` runs after the transaction is built and before it is
sent: save the session there, so funds never sit under a key that exists
nowhere. Set `session.onchain = binding` afterwards. A session cell occupies
121 CKB (153 with a recipient), which stays locked as the cell itself.

### `spendInSession(session, client, deployment, binding, { to, amount, topUp?, memo? }) → txHash`
The session key pays, no wallet involved. Checks the scope first (`ScopeError`),
then the network checks it again in the lock. A plain payment creates a cell, so
it is at least 61 CKB; `topUp: true` pays any amount into an existing
anyone-can-pay cell of `to`. `memo` goes into the key cell's witness, which the
key signs: see `verifyAccess`. Throws `SessionBalanceError` when the balance,
the change or the key cell would fall below what a cell needs.

### `closeSession(owner, session, deployment, binding) → { sweepTx?, keyTx?, keyError? }`
The owner sweeps the session cells (one signature), then the session key returns
the key cell to the owner. If the key cell cannot be returned, `keyError` says
why and the key should be kept for a retry.

### `recoverSessions(owner, deployment) → { txHashes, recovered, cells, failed }`
Device-loss recovery, with the wallet alone: finds every session cell this owner
opened and sweeps them, in one transaction if it can, else one per session (so a
planted cell spent ahead of the sweep fails alone). Key cells cannot be
recovered without their key.

### `findSessionCells(session, client, deployment, binding) → SessionCells`
The live session cells and key cells of one session, with their totals
(`balance`, `feeBalance`).

### `findOwnedSessionCells(owner, deployment) → Cell[]`
Every live, well-formed, type-free session cell whose args start with the
owner's lock hash, found without any session key.

### `onchainRecipient(session) → string | undefined`
The recipient the lock will enforce: `scope.recipients[0]`. More than one
recipient cannot be enforced on-chain and throws `SessionPolicyError`.

### `keyLockOf(session, client)`, `sessionLockOf(session, client, deployment, binding)`
The lock scripts of the key cell and of the session cells.

### Types: `OnChainBinding`, `SessionCells`
`OnChainBinding` is `{ ownerLock, minInterval, recipientLockHash? }`.

### `SessionBalanceError`
Not enough in the session, its change, or its key cell, or a budget below what a
cell occupies.

## The session lock

### `TESTNET_DEPLOYMENT`
Where the lock lives on testnet (`codeHash`, `hashType: "data2"`, `cellDep`).
Equal to [`deployment/testnet.json`](../deployment/testnet.json).

### `sessionLockScript(deployment, params)`, `sessionLockArgs(params)`, `sessionLockCellDep(deployment)`
Build the lock script, its 80- or 112-byte args
(`owner_lock_hash | session_lock_hash | max_per_tx | min_interval | recipient?`),
and its cell dep.

### `relativeBlocksSince(blocks)`
The relative block-number `since` the rate limit requires (RFC 0017).

### `SESSION_LOCK_ERRORS`, `sessionLockErrorFrom(message)`
The lock's error codes (10 bad args … 18 type script in session mode) and a
parser that pulls the code out of a node's rejection message.

### Types: `SessionLockDeployment`, `SessionLockParams`

## Paid access

### `paymentMemo(label) → Hex`
A memo for `spendInSession`, e.g. `paymentMemo("read:article-1")`.

### `signAccess(session, txHash, memo) → AccessProof`
The payer proves that the key which paid `txHash` is asking.

### `verifyAccess(client, proof, { to, minAmount, memo }) → AccessCheck`
The server's check, with no database: the request is signed by the key that
paid; the payment is committed, carries exactly this memo and no other, and the
recipient gained at least `minAmount`. One payment buys one claim.

### Types: `AccessProof`, `AccessCheck`

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
