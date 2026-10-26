# Design: subscriptions

Status: **reviewed (26 Oct 2026), library built; see the review section at the end.** The finding below is
that subscriptions need **no change to the session lock**: the deployed lock
already enforces everything a subscription needs, once the session key is held
by the creator instead of the subscriber. That claim is what the review should
attack.

## Goal

A creator charges a fixed price once per period from a cell the subscriber
controls, with no app open and no wallet online on the subscriber's side, and
the subscriber can cancel at any moment. On-chain, the network guarantees:

- at most `price` per charge,
- at most one charge per period, per subscription cell,
- every charge goes to the creator's address and nowhere else,
- the subscriber can take everything back at any time, alone.

Out of scope: subscriptions in tokens (the token session layout makes this a
small follow-up, after the CKB version is proven); a price that changes over
time (cancel and open a new one); calendar periods.

## The idea: the creator holds the key

Today a session is opened by an owner for a key the owner's own browser holds.
A subscription is the same cell with the roles moved:

| Session lock field | Session (today) | Subscription |
|---|---|---|
| `owner_lock_hash` | the user's wallet | the **subscriber's** wallet |
| `session_lock_hash` | a key in the user's browser | the **creator's charger key** (a server key) |
| `max_per_tx` | the most one payment may move | the **price** |
| `min_interval` | optional rate limit | the **period**, in blocks |
| `recipient_lock_hash` | optional | the **creator's payout address** (required) |

Read against the lock's rules (contracts/session-lock/src/main.rs):

1. **Outflow.** A charge moves at most `max_per_tx` out of the subscription, fee
   included. The creator pays the fee from its own key cell, so the subscriber
   pays exactly the price.
2. **Rate limit.** Every input of the group must carry a relative `since` of at
   least `min_interval` blocks. The change of a charge is a new cell, so the next
   charge must wait another full period.
3. **No splitting.** A charge returns at most one change cell, so the creator
   cannot multiply cells to charge several times per period. The number of
   subscription cells is set by the subscriber (the library opens one).
4. **Recipient.** Outputs may only go to the subscription (change), the charger
   key's own cell (not growing), the subscriber's wallet, or the payout address.
5. **No type scripts** on the subscription cell or its change, so nothing can
   freeze it.
6. **Owner mode.** Any transaction that also spends a cell of the subscriber's
   wallet may do anything: cancel = sweep everything back, at any time. The
   creator's signature is never needed.

So nothing new is enforced on-chain, and the deployed code hash
(`TESTNET_DEPLOYMENT`) serves subscriptions as it is.

## Two constraints that fall out of the lock

- **The payout address must not be the charger key's lock.** With a recipient
  set, outputs under the key's lock may not hold more than the key brought in
  (error 17, `KeyCellGrew`). A charge paid to the key's own lock would grow it,
  so it is refused. The creator uses two addresses: a charger key on the server,
  and a payout address (ideally anyone-can-pay, so any price can be added to one
  cell; without it each charge creates a new cell and must be at least 61 CKB).
  `openSubscription` refuses `payTo` equal to the charger lock before anything is
  signed.
- **One charge per transaction.** Rule 4 applies per subscription: an output
  belonging to another subscriber's cell is "anyone else" to this one. A creator
  with many subscribers sends one transaction each per period. This is a limit,
  not a hole.

## Periods are in blocks

`since` in this lock is a relative block number, so a period is a block count. A
month on mainnet is roughly 260,000 blocks at about 10 s each, but block time
varies with difficulty. The library offers `blocksForSeconds(client, seconds)`,
estimated from the node's recent headers, and states the result as an estimate.
A creator who wants "no more than monthly" should round up.

## Who learns what

The indexer can search a lock by args prefix, and the args start with the
subscriber's lock hash, so the **subscriber** finds their subscriptions directly
(`findOwnedSessionCells` already does this). The **creator** cannot search by the
charger key, which sits in the middle of the args. So the subscriber's app sends
the creator the funding transaction hash, and the creator checks it on-chain:

`verifySubscription(client, deployment, outPoint, expected)` reads the cell and
confirms code hash, charger, payout address, price, period, and a minimum
balance. Nothing is trusted from the request but the out point, the same pattern
as `verifyAccess`.

## Library surface (proposed)

```ts
openSubscription(subscriber: ccc.Signer, deployment, {
  charger: string;      // the creator's charger key address
  payTo: string;        // the creator's payout address (anyone-can-pay recommended)
  price: bigint;        // shannons per period
  periodBlocks: bigint;
  budget: bigint;       // capacity put in the subscription cell
}): Promise<{ txHash; subscription: Subscription }>

chargeSubscription(charger: ccc.Signer, deployment, subscription, { topUp?: boolean })
cancelSubscription(subscriber: ccc.Signer, deployment, subscription)
verifySubscription(client, deployment, outPoint, expected)
blocksForSeconds(client, seconds)
```

`Subscription` is plain data (subscriber lock, charger lock hash, payout lock
hash, price, period, the cell's out point), safe to store on both sides; unlike a
`Session` it holds no private key. Opening needs one subscriber signature and
creates **one** cell (no key cell: the creator already owns charger cells).
`chargeSubscription` reuses the spend path of `spendInSession` (mature cells
only, one change cell, fee from the key cell, `topUp` into an anyone-can-pay
payout cell).

Charges until the cell runs dry: a subscription cell with a recipient needs 153
CKB to exist, so a charge must either leave at least that or take the whole
cell (only possible when the whole cell is at most the price). `budget` of
`153 + n * price` CKB pays n periods exactly; anything left is returned on cancel.

## Threats, and which rule answers each

| Threat | Answer |
|---|---|
| Creator charges more than the price | Rule 1 (error 12) |
| Creator charges twice in one period | Rule 2 (error 14); splitting first is refused by rule 3 (error 16) |
| Creator pays the charge to a third party | Rule 4 (error 13) |
| Charger key leaks | The thief can take the price once per period per subscriber, but only to the payout address or as miner fee (outflow counts fees), and keeps that power over every subscriber who has not re-opened under a new key. Rotating = subscribers re-open; cancel stops it at once |
| Creator freezes the cell with a type script | Rule 5 (error 18) |
| Creator refuses to let the subscriber leave | Owner mode needs no creator signature |
| Subscriber cancels right after being served | Inherent to pre-paid service: the creator charges at the start of a period, not the end |
| Creator charges just before a cancel lands | Inherent; at most one price, since a period has passed |
| Anyone adds a fresh cell under the same lock | Harmless: it only adds funds; `chargeSubscription` takes mature cells only (as `spendInSession` does since 14 Oct) |
| Subscriber's wallet is a lock that signs nothing | `assertSigningLock`, as for sessions |

## Open questions for review

1. Is there any path where the charger key, combining several subscribers' cells
   in one transaction, gets past rule 4? (Expected: no, each group sees the other
   cells' change as "anyone else".)
2. Does anything in owner mode let the creator act as the subscriber? (Expected:
   no, owner mode needs an input under the subscriber's own lock.)
3. Is a block-count period acceptable for users, or is an epoch or timestamp
   `since` needed? That would be a lock change, so it gets its own threat model.

## Plan

1. Review of this document (a separate reviewer).
2. CKB-VM tests for the subscription shape on the deployed binary: a charge
   accepted after the period, refused early (14), refused over the price (12),
   refused to anyone else (13), payout = charger refused (17), cancel by the
   subscriber alone.
3. Library functions above, unit tests, API.md entries.
4. `smoke:subscription` on testnet: open, charge, early charge refused by the
   node, second charge after the period, cancel. Explorer links in the README.
5. Demo page `/subscribe`, in the same terminal style.

## Review, 26 Oct 2026 (adversarial pass) — changes adopted

Full report: kept outside the repository (drafts/subscriptions-review.md). The
claim held for the subscriber's money: at most the price per period, paid only to
the payout lock, the subscriber or fees; nobody can block a cancel; batching
subscribers fails with error 13. It did not hold for the creator's revenue. All
fixes are in the library; the lock is unchanged.

| Finding | Change |
|---|---|
| H1 The first period was free: a new cell cannot be charged for a whole period, so open, use, cancel, repeat | The opening pays the first period to `payTo` in the same transaction |
| H2 In owner mode the subscriber can re-create the cell to reset its age and put charges off forever | `verifySubscription` requires the transaction that created the cell to have paid the price to `payTo` and returns `paidThroughBlock`; access follows payments, not the live cell |
| H3 Subscription cells are public: anyone could present someone else's | `account` is committed in the opening's witness under the subscriber's signature (`subscriptionMemo`) and checked by `verifySubscription` |
| H4 Period 0 (no rate limit), 80-byte args (no recipient), price 0, period ≥ 2^56 | Refused at open; the verifier accepts 112-byte args only |
| M1 Two live cells under one lock are one group: two charges per period | `openSubscription` refuses a live subscription with the same terms. A top-up is cancel and re-open |
| M2 A charger lock that needs no signature lets anyone trigger charges | `assertSigningLock` on the charger lock too |
| M3 Key-leak row understated | Threat table corrected |
| M4 Cancel needs a plain cell in the subscriber's wallet | Documented in the API |
| M5 Old lock code lacks errors 16-18; in the token layout bytes 80..112 are the token | Open refuses legacy deployments; the verifier pins the current code hash and 112 bytes |
| L1 With a price of 153 CKB or more, the cell's last 153 can be charged too | Documented |
| L2 The charger can write data into the change cell, hiding it from the cell collector | Subscription cells are collected with or without data |
| L3 Races: charge against cancel, the shared fee cell, the shared payout cell | Inherent; a lost race is a retry |
| L4 The price must fit the payout lock's minimum cell | Checked before signing |
