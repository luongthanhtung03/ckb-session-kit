# ckb-session-kit

Browser-held self-custody sessions for CKB applications.

**Live demo:** [ckb-session-kit.vercel.app](https://ckb-session-kit.vercel.app/) — connect a wallet, sign once to open a session, pay with no popups while the network enforces the limits, sign once to close (CKB testnet).

**Status: early development.** Built in the open during my CKBuilder programme.

| When | Milestone |
|---|---|
| w/c 5 Oct 2026 | ✅ Scaffold, tests, CI |
| w/c 12 Oct | ✅ Session key held in the browser signs a testnet transfer; live demo |
| w/c 19 Oct | ✅ Session lock script (Rust) — outflow limit, recipient, rate limit enforced on-chain; deployed to testnet |
| w/c 26 Oct | ✅ Delegate, act repeatedly with no wallet dialog, revoke — library + demo (v0.2) |
| w/c 2 Nov | ✅ Survives reload; ✅ device-loss recovery |
| w/c 23 Nov | v1.0 on npm |

## The problem

A CKB application that needs to act repeatedly on a user's behalf — paying per API
call, submitting a transaction per interaction, anything with a loop in it — runs
into the same wall: every action opens a wallet dialog. Approving a hundred
signatures to make a hundred calls is not a usable product.

The obvious fix is to hand a key to the server, and that destroys the point.

## What this is meant to be

A session layer where:

- The session key is **created and held in the browser**, and never leaves it.
- It can sign within a **declared scope, enforced on-chain** — and nothing outside it.
- The session **survives a page reload**, and expires on terms the user set.
- The owner can **revoke it on-chain** at any moment.
- Losing the device does not mean losing the funds.

Its first example application is pay-per-read: a reader unlocks articles for
1 CKB each with no wallet prompt, and the session can only ever pay the creator.
The problem is not specific to that application.

## Try it

```bash
npm install
npm test                 # unit + CKB-VM tests, no network needed
npm run demo             # the Next.js web demo at http://localhost:3000
```

The demo (v0.2) connects a wallet through CCC (JoyID, MetaMask, OKX, UniSat, …).
The wallet signs **once** to open a session: it funds a session cell under the
on-chain session lock plus a small key cell that pays the session's fees. Payments
are then signed by a key held only in the browser, with **no wallet popup**, and the
network enforces the limits. The wallet signs **once more** to close the session and
take everything back.

```ts
import { createSession, openSession, spendInSession, closeSession, TESTNET_DEPLOYMENT as deployment } from "ckb-session-kit";

const session = createSession({ expiresAt, scope: { maxPerTx: 100n * 10n ** 8n } });
const { binding } = await openSession(wallet, session, deployment, { budget: 400n * 10n ** 8n });
await spendInSession(session, client, deployment, binding, { to, amount }); // no wallet
await closeSession(wallet, session, deployment, binding);                   // one signature
```

`npm run smoke:flow` runs exactly that against testnet with a key standing in for
the wallet. Run on 8 Oct 2026: [open](https://testnet.explorer.nervos.org/transaction/0x5835048d4226f0b74be01cd79664d7e4dce67ea8aa77bb9d3468e896d27bf2b8)
(owner signs) → [pay 100 CKB](https://testnet.explorer.nervos.org/transaction/0x9448e354252d71913d18fda2ba6d2460e1d78c2c0e4123eb8068482d7ec05c77)
and [pay 80 CKB](https://testnet.explorer.nervos.org/transaction/0x9391051dcc7f490ade402dbc2057de4382e005e9c9d21ad8d7f835328ddcd182)
(session key only) → 150 CKB refused → [key cell returned](https://testnet.explorer.nervos.org/transaction/0xe8eb8954674665aa1a4b990ecfd8ffea1ad728e8689a5f5aafdb9fc17c00b8d9)
and [session swept](https://testnet.explorer.nervos.org/transaction/0x0d2a05460bdbfd5693c2d91a55e9c96b2eaaa6fbb7e0b1e3237a1fe9c2d6f1e4) (owner signs).

### Lost the device? The wallet alone gets it back

The session key lives only in one browser. If that browser is gone, the owner's
wallet can still recover every session it ever opened:

```ts
await recoverSessions(wallet, deployment); // finds them all, one signature
```

Session-lock args begin with the owner's lock hash, so an indexer prefix search
finds the session cells without knowing the lost key, and owner mode sweeps them.
Cells whose args are malformed are skipped: the lock rejects them even in owner
mode, and anyone could plant one with the owner's hash as a prefix to block a
sweep. What cannot come back is the key cell (the fee budget), which only the
session key can spend; keep it small (61 CKB is the minimum).

`npm run smoke:recover` runs it on testnet. Run on 9 Oct 2026: two sessions
[opened](https://testnet.explorer.nervos.org/transaction/0x289291b3026af3d1e1929308b75276bc72d0c8de151f1b74f6b7926f29bda74b)
([second](https://testnet.explorer.nervos.org/transaction/0xb4d91cdb0751c7fd9908ac18930c07c74d09c67f7338916f9893eb8190acd883)),
one [spent from](https://testnet.explorer.nervos.org/transaction/0xf173fd2b02b1b8e208bd493c9d31ead9d5052b5aae190119a2393554de0e8079),
a [decoy](https://testnet.explorer.nervos.org/transaction/0x40781ca16108dfde33328ded076721137c6be935d2417258c881dfe4266f000f)
planted, both keys dropped → [one owner transaction](https://testnet.explorer.nervos.org/transaction/0x4efd8b7875c8a0f2883ac2b21ed509ff86c72012e6f4a24816783aa25e02eeaf)
swept every session cell back, decoy skipped.

## Example: pay-per-read

A reader's wallet signs once to open a session scoped to one creator. Each article
unlock is then a 1 CKB payment signed by the session key alone. Two things make
this work on CKB:

- **Payments smaller than a cell.** A new cell needs at least 61 CKB, so a 1 CKB
  payment cannot create one. Instead the creator keeps an
  [anyone-can-pay](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md)
  cell, and each payment tops it up: `spendInSession(…, { to, amount, topUp: true })`.
  The anyone-can-pay lock accepts the top-up without the creator's signature.
- **A stolen key can only pay the creator.** The session's recipient is the
  creator's anyone-can-pay address, so the session lock refuses any other output,
  and `max_per_tx` caps each unlock.

```ts
const session = createSession({ expiresAt, scope: { maxPerTx: 5n * CKB, recipients: [creatorAcp] } });
const { binding } = await openSession(wallet, session, deployment, { budget: 200n * CKB, recipient: creatorAcp });
await spendInSession(session, client, deployment, binding, { to: creatorAcp, amount: 1n * CKB, topUp: true });
```

**Server-verified unlocks, no database.** Each payment names its article in a
memo (`spendInSession(…, { memo })`), stored in the witness the session key signs,
so the payment commits to what it buys. To read, the browser signs a request with
the same key (`signAccess`), and the server checks the chain (`verifyAccess`):
committed, the creator gained at least the price, the memo matches, and the key
that signed the request is the key that paid. Anyone can see a payment on-chain;
only its payer can use it, and only for that article. The article text is never
in the page bundle.

```ts
// browser
const tx = await spendInSession(session, client, deployment, binding, { to: creatorAcp, amount: 1n * CKB, topUp: true, memo: paymentMemo("read:since") });
const proof = await signAccess(session, tx, paymentMemo("read:since"));
// server
const check = await verifyAccess(client, proof, { to: creatorLock, minAmount: 1n * CKB, memo: paymentMemo("read:since") });
```

`npm run smoke:pay-per-read` runs it on testnet; with `ARTICLE_API` set it also
claims each article through the demo's `/api/article` route. Run on 9 Oct 2026
against the production build:
[session opened](https://testnet.explorer.nervos.org/transaction/0xbaa5657c27d44e37e9557b1dbb0ee38fb3cda95924098529892906857b7ae72d)
(reader signs once, recipient = creator) → reads
[#1](https://testnet.explorer.nervos.org/transaction/0x5aeeb65326efb1ff2d651ba22f5a685c224162e974b51ceb9638f6576d056942),
[#2](https://testnet.explorer.nervos.org/transaction/0x575becbaa7aa2b03d26406c974ca417b82f06d044b863919d07cf5d760e6910b),
[#3](https://testnet.explorer.nervos.org/transaction/0x3b54027483f7239c1b5af7c82a773263107493c8db88183d9aef740091680eb0)
at 1 CKB each, session key only, each released by the route to the payer, while
a claim by another key and a claim for another article were refused →
paying anyone else and paying 6 CKB (limit 5) refused before signing →
[key cell returned](https://testnet.explorer.nervos.org/transaction/0xf7d9f2cc05d0841d59fa82d66ae5e3152b69860155fd6c6b2ca82dba15fa9493)
and [session swept](https://testnet.explorer.nervos.org/transaction/0x978e186aceeadca6d963cf6f570066c36028d7ba0273e5f84bfb7c6e46c9e281).
The on-chain side of the refusals is covered by the CKB-VM tests below.

**Try it in the browser:** [ckb-session-kit.vercel.app/read](https://ckb-session-kit.vercel.app/read)
(the `/read` page of the demo): open a reading session with one wallet signature,
then unlock articles for 1 CKB each with no popup.

A session cell with a recipient occupies 153 CKB, so a 200 CKB session has 47 CKB
to spend; the rest comes back on close. Each payment consumes one of the creator's
cells, so readers paying at the same moment compete for them; the library picks
one at random, and `npm run setup:creator` gives the demo's creator three.

## The on-chain session lock

[`contracts/session-lock`](contracts/session-lock/src/main.rs) is a CKB lock script in
Rust. A cell under it can be spent two ways:

- **Owner mode** — the transaction also spends a cell locked by the owner's lock.
  Anything goes: revoke, sweep, top up.
- **Session mode** — the transaction also spends the session key's *key cell*. The
  network then enforces, on-chain:
  - **outflow limit** — at most `max_per_tx` shannons leave per transaction, fees
    included, so the fee cannot be used to drain the cell;
  - **recipient allowlist** (optional) — payments may only go to one lock (plus
    change, the key cell, and the owner);
  - **rate limit** (optional) — each session cell must have aged `min_interval`
    blocks before it can be spent again (relative `since`).

Signatures are delegated to the standard secp256k1 locks of the owner and the
session key (the pattern sUDT's owner mode uses), so the script carries no
cryptography: **4.3 KB, no allocator, no C, 12,893 cycles per run** — about 0.8% of
a session spend. 22 tests run it in the real CKB-VM, most asserting a specific
rejection code, and CI builds the contract and requires them.

**What it cannot do:** enforce an expiry time. A CKB script can prove time has
passed (`since` is a lower bound) but never that it has not. Expiry is enforced
in the browser; the owner can revoke on-chain at any moment, and the session
cell's balance caps the total at risk.

A session-lock cell occupies 121 CKB (153 CKB with a recipient), so its balance
and its change must stay above that.

### Enforced by the real network

Deployed on testnet: code hash `0x1ae8b8f7…26bc20` (`data2`), see
[`deployment/testnet.json`](deployment/testnet.json).
`npm run smoke:lock` runs every rule against public testnet. Run on 8 Oct 2026:

| Step | Network said |
|---|---|
| Owner funds two session cells and a key cell | [accepted](https://testnet.explorer.nervos.org/transaction/0x7f1476477ebc17c50f338595aeca941722946fb5e3da48c52555a114b2c159de) |
| Session key spends exactly `max_per_tx` (100 CKB), no owner signature | [accepted](https://testnet.explorer.nervos.org/transaction/0x48b3bde2a50bb8ba3aff0800e850b2aa521793b35628d165eab7f22f984be828) |
| Session key spends 100 CKB + 1 shannon | **rejected**, error 12 (outflow exceeds max_per_tx) |
| Rate-limited cell spent with no `since` | **rejected**, error 14 (rate limited) |
| Same cell with `since` = 3 relative blocks | [accepted once mature](https://testnet.explorer.nervos.org/transaction/0xd2038582a6099ede9e1b906f257509ca0a50ec9a7aba2c12e39b519319b458cb) |
| Owner sweeps everything back | [accepted](https://testnet.explorer.nervos.org/transaction/0x4edd74ccfc854482cc3a5114aa8563e169f7666028f6bfb6d1c1b30f22ca53d6) |

Cycles, measured with [ckb-cycle-tools](https://github.com/luongthanhtung03/ckb-cycle-tools)
on the accepted session spend — the session lock 12,893, the key cell's
secp256k1 lock 1,635,560, matching the node's 1,648,453 exactly.

### v0.1 browser flow, verified on public testnet

`npm run smoke:testnet` funds a fresh session, spends inside its scope, and checks
that an over-limit spend is refused. Run on 8 Oct 2026:

| Step | Result |
|---|---|
| Fund the session (300 CKB) | [0x2acf…c45f](https://testnet.explorer.nervos.org/transaction/0x2acff2323c07cb36dd9d58343df83277cdab68725541020acbff4dc968d0c45f) |
| Spend 100 CKB, signed by the session key | [0x52a1…da50](https://testnet.explorer.nervos.org/transaction/0x52a1b3ba45a28614c30ddc52f0795c164141abbebd1558e6c69fb0ac45fada50) |
| Spend 150 CKB (limit 100) | refused before signing |

## Why it is a separate repository

The session problem has nothing to do with any one application. Anything that wants
to act repeatedly on a user's behalf in a browser has it, so it should not be buried
inside one application's source tree.

## Licence

MIT. See [LICENSE](LICENSE).

## Author

Luong Thanh Tung — [@luongthanhtung03](https://github.com/luongthanhtung03)
