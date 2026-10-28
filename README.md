# ckb-session-kit

Browser-held self-custody sessions for CKB applications.

**Live demo:** [ckb-session-kit.vercel.app](https://ckb-session-kit.vercel.app/) — connect a wallet, sign once to open a session, pay with no popups while the network enforces the limits, sign once to close (CKB testnet).

**Status: v1.0, on CKB testnet (not audited, no mainnet deployment).** Built in the open during my CKBuilder programme.

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

## Install

```bash
npm install ckb-session-kit
```

[ckb-session-kit on npm](https://www.npmjs.com/package/ckb-session-kit) (v1.0.0, ESM, Node 20 or later
and browsers). The API is in [docs/API.md](docs/API.md); the walkthrough in
[docs/WALKTHROUGH.md](docs/WALKTHROUGH.md).

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

New here? [`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) tours every demo page on
testnet in about fifteen minutes, with one wallet.

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
await recoverSessions(wallet, deployment); // finds them all, usually one signature
```

Session-lock args begin with the owner's lock hash, so an indexer prefix search
finds the session cells without knowing the lost key, and owner mode sweeps them.
Cells whose args are malformed are skipped: the lock rejects them even in owner
mode, and anyone could plant one with the owner's hash as a prefix to block a
sweep. Anyone can also plant a *well-formed* cell with the owner's hash and their
own key, and spend it just before the sweep lands; if the single sweep fails,
each session is swept on its own (one signature each), so only the planted cell
is left out. What cannot come back is the key cell (the fee budget), which only
the session key can spend; keep it small. It must stay big enough to go back to
the owner after paying fees, so `openSession` sizes it from the owner's lock: 62
CKB by default for a secp256k1 owner, 64 for JoyID or Omnilock (MetaMask, UniSat,
OKX), whose cells need 63. The extra 1 CKB pays thousands of fees.

`npm run smoke:recover` runs it on testnet. Run on 9 Oct 2026: two sessions
[opened](https://testnet.explorer.nervos.org/transaction/0x289291b3026af3d1e1929308b75276bc72d0c8de151f1b74f6b7926f29bda74b)
([second](https://testnet.explorer.nervos.org/transaction/0xb4d91cdb0751c7fd9908ac18930c07c74d09c67f7338916f9893eb8190acd883)),
one [spent from](https://testnet.explorer.nervos.org/transaction/0xf173fd2b02b1b8e208bd493c9d31ead9d5052b5aae190119a2393554de0e8079),
a [decoy](https://testnet.explorer.nervos.org/transaction/0x40781ca16108dfde33328ded076721137c6be935d2417258c881dfe4266f000f)
planted, both keys dropped → [one owner transaction](https://testnet.explorer.nervos.org/transaction/0x4efd8b7875c8a0f2883ac2b21ed509ff86c72012e6f4a24816783aa25e02eeaf)
swept every session cell back, decoy skipped.

## Examples and API

- [`examples/node-quickstart.ts`](examples/node-quickstart.ts): open, pay twice
  with no wallet, close, in one file (`OWNER_KEY=0x… npx tsx --tsconfig examples/tsconfig.json examples/node-quickstart.ts`).
  Run on 13 Oct 2026: [open](https://testnet.explorer.nervos.org/transaction/0x8229533c8769bb30730d075abd5c6cf60b39ab9765a3fc24adeb6d6af649cf8c)
  → [pay 61](https://testnet.explorer.nervos.org/transaction/0x75e3673ce82d202dd76bd30903f199b83eddd0e4b2085fd45b2cd286cf27fea7)
  → [pay 65](https://testnet.explorer.nervos.org/transaction/0x821816ec1916c805e98b0de1ec5e3c606837950edb468a7a4d998dd7f8f9598a)
  → [sweep](https://testnet.explorer.nervos.org/transaction/0x36d47d37139d21affe8d0660395dba03aba2d3b247566f1e34684d85b9aac67d)
  and [key cell back](https://testnet.explorer.nervos.org/transaction/0x41604d6d13fc7f7b0e7adc92316651a25507a7a2ffe8b2964887b3935498de75).
- [`examples/browser-session.ts`](examples/browser-session.ts): what an app does
  around any CCC wallet: save before funding, one session per tab, restore on load.
- [`examples/paywall-server.ts`](examples/paywall-server.ts): a paywall with no
  database, on `node:http`.
- [`docs/API.md`](docs/API.md): every export, grouped by task. CI typechecks the
  examples and fails if an export is missing from the reference.

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
const { binding } = await openSession(wallet, session, deployment, { budget: 200n * CKB });
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

## Example: CKB Place, a pixel board on testnet

[`/place`](https://ckb-session-kit.vercel.app/place): a shared 32×32 board. Open a
session once (one wallet signature; the session lock lets it pay only the board),
then every batch of up to 32 pixels is one 0.1 CKB-per-pixel payment signed by
the session key, with no wallet popup. The pixels travel in the payment's memo
(`"px1"` + `x, y, colour` per pixel); the board is rebuilt from the chain by
reading those memos in chain order, counting only payments that carry exactly one
memo, signed by the payer, for at least the price. No server, no database:
[`src/place.ts`](src/place.ts).

`npm run smoke:place` paints "CKB" on testnet. Run on 14 Oct 2026:
[board cells created](https://testnet.explorer.nervos.org/transaction/0x2dbcf33a2c8360a1ad2a7984f2f1331f345b0c9874511e7f5c7f828db24dea1f)
→ [session opened](https://testnet.explorer.nervos.org/transaction/0x91cfac448029eba2354e08a6a3f6fbeaf4227a6507ebcda267e5a4e0060d3715)
→ [29 pixels, 2.9 CKB, no wallet](https://testnet.explorer.nervos.org/transaction/0x91acae7b00a0210e3779b76ec974395964ba65e7797780dd3a9d815e4245d0f5)
→ [swept](https://testnet.explorer.nervos.org/transaction/0x3c3b734fdda064e108dbcf0d989d573625e5823a54f92233a66f0cfa0e08b1e3)
and [key cell back](https://testnet.explorer.nervos.org/transaction/0x3c369a5c81e66847003ff4019fd01773d97563378a07d05857a5c18d4096e006).

## Example: pay-per-minute

[`/listen`](https://ckb-session-kit.vercel.app/listen): a player for three
generative tracks (Web Audio, composed per minute on the server). Open a session
once; while it plays, the session key pays 0.5 CKB for the next minute 30 s
before it is needed, with memo `listen:<track>:<minute>`, and the server releases
that minute only to the key that paid for it (`verifyAccess`). Pause, and the
payments stop. No database.

`npm run smoke:listen` runs it on testnet with the server's own gating. Run on 14 Oct 2026:
[session opened](https://testnet.explorer.nervos.org/transaction/0x818094035373e3a62d34af39f98fab664f6dc089d3149d57b0a53ea7e3a30c1b)
→ [minute 0](https://testnet.explorer.nervos.org/transaction/0x10df4596aaad21201c33784fb28387d8f129d4bcf546c6a54b49ea8cb48c55c7)
→ [minute 1](https://testnet.explorer.nervos.org/transaction/0xb53479536932ff07a19d87d4d0d48fada4981e1bc66687a7a9ddd5f0fac1b6f1),
each released by the server; minute 2 claimed with minute 0's payment: refused
→ [swept](https://testnet.explorer.nervos.org/transaction/0x2f091ff6430b62d157743450cf18cc9d5f52d91852012cc348ff377f79dab8e0)
and [key cell back](https://testnet.explorer.nervos.org/transaction/0x5024c47cd6eacb822bc6c9392270bc6b4389110a353b0139475aafdbddb8cf2e).

## Token sessions (xUDT)

A session can hold a token as well as CKB: a stablecoin, game credits, a
creator's token. The owner signs once; the session key pays in the token with
no wallet, and the lock caps the units per spend the way it caps shannons, with
the same recipient and rate-limit rules. Payments top up the recipient's
anyone-can-pay token cell, so no CKB leaves the session. Closing or recovering
returns the tokens as tokens.

```ts
const { binding } = await openSession(wallet, session, TESTNET_DEPLOYMENT, {
  budget: 300n * CKB,
  token: { type: xudtType, amount: 100n, maxPerTx: 10n },
});
await spendInSession(session, client, TESTNET_DEPLOYMENT, binding, { to: creator, token: 3n, topUp: true });
```

Design, threats and both reviews: [`docs/design/token-sessions.md`](docs/design/token-sessions.md).
`npm run smoke:token` runs it on testnet. Run on 14 Oct 2026, with a test xUDT:
[session opened, 100 units](https://testnet.explorer.nervos.org/transaction/0x7dac7740cf9be29cf900085e98f43cb3557e2c956b9946a2d20ddc3dec49105d)
→ [3 units](https://testnet.explorer.nervos.org/transaction/0xa8d1d98f8fd5b22cab9fd989b58a39995171e7099b1df5df46292c6ca8f94a88)
→ [3 units](https://testnet.explorer.nervos.org/transaction/0xba27bcc564c00cdf2b8b3d3badc30091a29f17fbc4ce71bbb84117af6cb7b19d),
no wallet; 11 units in a 10-unit session: rejected by the network (code 20)
→ [94 units swept back](https://testnet.explorer.nervos.org/transaction/0x798c65c8ab49de39eb5aeb084c386f6ec1e1803e12636129ba73ace24b710a5d).

**Try it in the browser:** [ckb-session-kit.vercel.app/tokens](https://ckb-session-kit.vercel.app/tokens):
pay-per-read again, 2 tokens per article. The demo token is free to mint from the
page: its issuer is an anyone-can-pay cell nobody holds the key to, and xUDT lets
whoever spends an issuer cell mint, so anyone can (it is worth nothing). The
server releases an article after `verifyAccess(…, { token })` finds, on-chain,
that this key paid 2 units of this token for it. `npm run setup:token` creates
the issuer cells; `npm run smoke:read-tokens` runs the page's flow on testnet.
Run on 14 Oct 2026:
[minted 20 units with only the minter's key](https://testnet.explorer.nervos.org/transaction/0x37e5005a74ee503a86813907c6aef1d02e930c9575c271751d6fafed9cdeef75)
→ [session opened](https://testnet.explorer.nervos.org/transaction/0x366d40dad9c8be024af28e93aa4b65e8f0a7ad9903ff923eb5c192d49c99c678)
→ [2 units for an article](https://testnet.explorer.nervos.org/transaction/0x9a16f6601309af1deec985c55a7537195047c28630d0cae719e8e8afc3d01dee),
released by the demo's server route; at a 3-unit price the same payment is refused
→ [18 units back](https://testnet.explorer.nervos.org/transaction/0x3688288b9c49c771b85a38a80806f9fefead39b936caea92ecb97e6d4a3aa2ee).

## Subscriptions

The same lock with the roles moved: the subscriber owns the cell, the creator's
server holds the session key. The network lets the creator charge at most the
price, at most once per period, and only to the creator's address, while the
subscriber is offline; the subscriber cancels alone at any time. **No change to
the deployed lock**: the price is `max_per_tx`, the period is `min_interval`,
the payout address is the recipient.

```ts
// subscriber: one signature; the first period is paid at once
const { subscription } = await openSubscription(wallet, TESTNET_DEPLOYMENT, {
  charger, payTo, price: 10n * CKB, periodBlocks: 10n, budget: 173n * CKB, account,
});
// creator's server, once per period, no subscriber involved
await chargeSubscription(chargerKey, TESTNET_DEPLOYMENT, subscription, { payTo, topUp: true });
// creator's server, on every request, with no database
const r = await subscriptionStatus(client, TESTNET_DEPLOYMENT, subscription, { openTx, account });
// subscriber, any time
await cancelSubscription(wallet, TESTNET_DEPLOYMENT, subscription);
```

The design was attacked on paper before any code
([`docs/design/subscriptions.md`](docs/design/subscriptions.md)). The
subscriber's money held; the creator's side did not, and the library now covers it:
- the opening pays the first period, since a new cell cannot be charged for a whole period;
- access follows payments, not the live cell, so re-creating the cell to reset its age gains nothing;
- the opening commits to an account id (hashed) under the subscriber's signature, so nobody can present someone else's subscription.

A charge costs the session lock 20,999 cycles.

`npm run smoke:subscription` runs it on testnet. Run on 26 Oct 2026:
[opened, first period paid](https://testnet.explorer.nervos.org/transaction/0x383242a3bf89ae8007fc8fc4f7ec04420718c2e32590bdbbd445bcf4c4e2a1b9)
→ the creator's check accepts the terms, the first payment and the account, and refuses another account
→ a charge 1 block in: rejected by the network (code 14)
→ [charge 1](https://testnet.explorer.nervos.org/transaction/0xf98e36b2f5ef1bb86875fb0989e32f25f67807bc95e34aa273b497db5eebdb16)
→ [charge 2](https://testnet.explorer.nervos.org/transaction/0x930beb93436c884f679f691a901eec1db4742fd69cd28e8d63b4eb386de260e0), a period later, charger key only
→ a third charge refused: what is left cannot cover a price and a cell
→ [cancelled by the subscriber alone, 153 CKB back](https://testnet.explorer.nervos.org/transaction/0x235c9d2e4fc2205fa552c144890002f611c362402b62ceb1dc8540160c459c4f).

**Paid in a token.** The same flow in an xUDT (a stablecoin, say): pass
`token: { type, amount }` to `openSubscription`. The lock's per-payment CKB limit
is 0, so no CKB ever leaves the cell; the price is the per-payment token limit, and
charges top up the creator's anyone-can-pay token cell. `npm run smoke:subscription-token`
ran it on 27 Oct 2026 with the demo token:
[opened, first 2 units paid](https://testnet.explorer.nervos.org/transaction/0xc168cc4f0122a0c84add3449a261dd400defacffc59934d2c906da60d10353ba)
→ a charge 1 block in: rejected (code 14); a charge moving 1 shannon of CKB too: rejected (code 12)
→ [charge 1](https://testnet.explorer.nervos.org/transaction/0x7aa3872fec7e32e5b1f4e719d034a0d7310f717aa128642a1bfb2d252efceb6d)
→ [charge 2](https://testnet.explorer.nervos.org/transaction/0x20ee3154a4db0d375f3f444e48fe9d4e47587abb2df0111c7979c0d03823335c), each 2 units with no CKB out
→ a third refused: no tokens left
→ [cancelled by the subscriber alone](https://testnet.explorer.nervos.org/transaction/0x9121f5f3bcd7614a2c191ec99550bf57f56117733cdd670a3e2fb300f9c05f51).

**Try it in the browser:** [ckb-session-kit.vercel.app/subscribe](https://ckb-session-kit.vercel.app/subscribe):
2 CKB per 60 blocks; members' notes the server releases only while you are paid up.

## Which wallets can own a session

The owner signs to open, close and recover, so the owner's wallet must work. `npm
run matrix:wallets` runs the session and subscription flows on testnet with each
kind of owner lock the demo's wallet picker gives, signing the way that wallet
signs (EIP-191 for Ethereum wallets, Bitcoin message signing, and so on). Run on
26-27 Oct 2026:

| Owner wallet | session opened | paid 1 CKB | session swept | key cell back | subscribed | cancelled |
|---|---|---|---|---|---|---|
| CKB default lock (secp256k1): Neuron, CKB CLI, most libraries | [0x5e14b73f…](https://testnet.explorer.nervos.org/transaction/0x5e14b73f596c0938d228f117bfcae5788ae1c043f93ba6c97b73041febe2a7a4) | [0xd89e75ff…](https://testnet.explorer.nervos.org/transaction/0xd89e75ffc99be568127dda64b35f09966c0a6e9f6c3b805b2e2d85cc099260f9) | [0xd9336db9…](https://testnet.explorer.nervos.org/transaction/0xd9336db92d25b50f4f42cb715c8b1f84bca40c30d3cff9638108bd6021ad61f4) | [0x881ca37f…](https://testnet.explorer.nervos.org/transaction/0x881ca37f01bfe087da0e1eda74e712f2ac1e9d18b126867099c20a7a2fc42a87) | [0x2b0274df…](https://testnet.explorer.nervos.org/transaction/0x2b0274df681c435ab40a685110906dfe7e78658b5cb87eac885823da3329dad7) | [0x9aeff7dc…](https://testnet.explorer.nervos.org/transaction/0x9aeff7dc0518e8b4a12228cfe60768bd0a02481c474e38b5bb61733a1284f634) |
| Omnilock, Ethereum auth (0x12): MetaMask, OKX (EVM) | [0xae66203d…](https://testnet.explorer.nervos.org/transaction/0xae66203d64e7000d200992280e0bfbff7ffd08b83a18b22686fa01e7663230f1) | [0x3b0211b0…](https://testnet.explorer.nervos.org/transaction/0x3b0211b0c260c9cd0a009276271c9cb5007fcd4d566ab4eac161280a8e4c0206) | [0xe5bc64e9…](https://testnet.explorer.nervos.org/transaction/0xe5bc64e9980482c5eeeb832a204fa9142006b64badc97f6f845f328ecc0f1170) | [0xf795b033…](https://testnet.explorer.nervos.org/transaction/0xf795b0331fbee0e850f238c89f3728b4f7e22fcaacf66ee0e2cfc7344c9f83fd) | [0x6f5b5666…](https://testnet.explorer.nervos.org/transaction/0x6f5b5666593c7d4c63a69c0afcec90a1440dc1ad3c1570001cc8c059621c889c) | [0x9e963bbf…](https://testnet.explorer.nervos.org/transaction/0x9e963bbfdf38eebc238f7b4c77290fc9228e8f6fdaba70ee039c73a7821517e3) |
| Omnilock, Bitcoin auth: UniSat, OKX (BTC) | [0x9a1beefc…](https://testnet.explorer.nervos.org/transaction/0x9a1beefc1fbc7d6a3d0eee5ef14a4b9c37c60f26794ff9716ee8ea8da9235f3d) | [0xe5db9f8b…](https://testnet.explorer.nervos.org/transaction/0xe5db9f8bf28be2a1e5859037643ba2b84cb38150b143c8113479002e7ff21e11) | [0x5f7f4d69…](https://testnet.explorer.nervos.org/transaction/0x5f7f4d69404be44a09bc0d35e40890e85e1c16ab70fefb20926ae516c4f4056f) | [0x44a0e09d…](https://testnet.explorer.nervos.org/transaction/0x44a0e09da81c6df8377971c08e08131c88fd22e307a511f6077f63d02a9ae86e) | [0xf44697da…](https://testnet.explorer.nervos.org/transaction/0xf44697da2f0c19d62370113d89b5e767735338eadab5ec236c2946831842c2a3) | [0x38141883…](https://testnet.explorer.nervos.org/transaction/0x3814188336d6a345a525a0eb9805d35202072c2567c4f1bae3b50a2a1fdb0be9) |
| Omnilock, Dogecoin auth | [0xbd693312…](https://testnet.explorer.nervos.org/transaction/0xbd6933129c74bae2a9ed16467ea422c093e8869f901a871994cc41838667bbb5) | [0x1f7069e9…](https://testnet.explorer.nervos.org/transaction/0x1f7069e9fb0e078dccaa291be51c24bc86d6245b2925446a917d09b68f18dbf2) | [0x356fb5f1…](https://testnet.explorer.nervos.org/transaction/0x356fb5f179bb2aee0d396b1933840eb6c96b693907d68deaf78970934a2cd260) | [0x093d5331…](https://testnet.explorer.nervos.org/transaction/0x093d533118f9f671928f87a710eb0079275246ad552ab39c8e131e60c5df9c1d) | [0x6d8c67d7…](https://testnet.explorer.nervos.org/transaction/0x6d8c67d776d499b099649bcbc24d7647d42ec488c6f95e30a8c5177764980c42) | [0x0e98ab80…](https://testnet.explorer.nervos.org/transaction/0x0e98ab80f1b09993fcb78bf7ed835f1212c8c00f79c57483a4c242eabfdb88ec) |
| Nostr lock: NIP-07 extensions | [0x24e6503a…](https://testnet.explorer.nervos.org/transaction/0x24e6503a5e0113bef6b506434cf202e2fa6e10d47723e301d290bdcadcf4a079) | [0x297eaa51…](https://testnet.explorer.nervos.org/transaction/0x297eaa51014e9a4a6cdfa889527ac32e381aebe21d2cfa2b21078a849fb79989) | [0x05dfbc09…](https://testnet.explorer.nervos.org/transaction/0x05dfbc0979d09a784d4943d49ecbfcb6a5d718c01a620816b4cdb0bc4f57e62f) | [0xd9139c2e…](https://testnet.explorer.nervos.org/transaction/0xd9139c2ee919c133c3d107b0e5a60789e48553ba38f33024d90af10a7c9ce601) | [0x832c08a3…](https://testnet.explorer.nervos.org/transaction/0x832c08a309464e20ce3441034d1aebcdade51721f21bc14bbc11b7237ed7484b) | [0xf6cfb847…](https://testnet.explorer.nervos.org/transaction/0xf6cfb8478fd6f53bab2b192f6ebfd7b498522299d122b91205a759b43e97778f) |

The first run refused the MetaMask row: the check that refuses owner locks which
verify no signature did not know Omnilock's auth flag 0x12, the one CCC gives
Ethereum wallets. Fixed, with a test built from the lock CCC derives for an
Ethereum account. **JoyID** signs with a passkey and cannot be scripted; it was
tested by hand in the demo (10 Oct).

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
    change, the key cell, and the owner). The key cell may come back smaller
    (it pays the fee) but never larger, so the key cannot park session funds in
    its own cell and pay anyone from there;
  - **rate limit** (optional) — each session cell must have aged `min_interval`
    blocks before it can be spent again (relative `since`). The limit is **per
    cell**: with *n* session cells, the key can spend from each of them in the same
    block. `openSession` creates one cell;
  - **no splitting** — a session spend may send at most one cell back to the
    session lock, so the key can merge session cells but never multiply them,
    which makes the per-cell rate limit a per-session one for sessions opened
    with `openSession`. (Anyone can add cells under a session lock, but only
    with their own money: it never multiplies what the owner put in);
  - **no type scripts** — in a plain session, the session cells spent and their
    change carry no type script: a change cell given a type the key controls could
    later refuse every spend, the owner's sweep included, freezing the whole
    balance. A token session allows exactly one type, its own xUDT, and caps the
    units that leave per spend (`max_per_tx_token`) the way it caps shannons.

Signatures are delegated to the standard secp256k1 locks of the owner and the
session key (the pattern sUDT's owner mode uses), so the script carries no
cryptography: **7.6 KB, no allocator, no C, 15,651 cycles per run** — about 0.9% of
a session spend (29,031 on a token spend, 1.7%). 74 tests run it in the real CKB-VM, most asserting a specific
rejection code, and CI builds the contract and requires them.

**What it cannot do:** enforce an expiry time. A CKB script can prove time has
passed (`since` is a lower bound) but never that it has not. Expiry is enforced
in the browser; the owner can revoke on-chain at any moment, and the session
cell's balance caps the total at risk.

**Enforced where:**

| Rule | Browser (`checkRequest`) | Session lock (on-chain) |
|---|---|---|
| `expiresAt` | yes | **no** (cannot be) |
| `maxPerTx` | yes | yes, fees included |
| recipient | yes | yes, if `scope.recipients` has one entry (`openSession` reads it from the scope) |
| rate limit | — | yes, per cell (`min_interval` blocks) |
| revocation | — | only by an owner transaction (`closeSession` / `recoverSessions`) |

### If a session key leaks

The key cannot be revoked by expiry: after `expiresAt` it still satisfies the lock
until the owner acts. Until then it can move at most `max_per_tx` per transaction,
only to the recipient if one is set, and, with a rate limit, once per
`min_interval` blocks per session cell. The owner should sweep at once:

- with the key still at hand: `closeSession(wallet, session, deployment, binding)`;
- without it (device lost or wiped): `recoverSessions(wallet, deployment)` finds
  every session the wallet opened and sweeps them, without the key.

An owner sweep is accepted at any time and ignores the scope. It is not certain
to beat a spend already racing it: the key holder can replace a pending sweep by
paying a higher fee, so sweep early, and resweep what is left. Keep budgets
small: the budget is the most a session can ever lose.

**Owner and session locks must need a signature.** The lock trusts that an input
under the owner's lock means the owner signed. Plain secp256k1, JoyID and
Omnilock are fine; an anyone-can-pay owner lock is not, since anyone may spend
into it and would get owner mode.

A session-lock cell occupies 121 CKB (153 CKB with a recipient), so its balance
and its change must stay above that.

### Enforced by the real network

Deployed on testnet: code hash `0xab419466…4c08ce` (`data2`, [deploy tx](https://testnet.explorer.nervos.org/transaction/0xf3098bdb9a7bb1c500990be0f1159b7e66f507fef6b7a4f904046024284877f2)),
see [`deployment/testnet.json`](deployment/testnet.json). The code is immutable.
Earlier deployments (8 Oct, before errors 16–18; 13 Oct, before token sessions)
are kept in `TESTNET_LEGACY_DEPLOYMENTS`, so `recoverSessions` still sweeps
sessions opened under them.

Verify the deployed lock yourself. The deployed binary was built with rustc
1.99.0 on the x86_64-pc-windows-gnu host (pinned in
[`rust-toolchain.toml`](contracts/session-lock/rust-toolchain.toml)), and a
rebuild there is byte-identical to the code on chain. On Windows, from the
repository root:

```sh
rustup toolchain install 1.99.0-x86_64-pc-windows-gnu --profile minimal --target riscv64imac-unknown-none-elf
(cd contracts/session-lock && cargo +1.99.0-x86_64-pc-windows-gnu build --release --locked)
npm ci && npm run check:lock-hash
```

The last command compares the build's data hash with `codeHash` in
`deployment/testnet.json` and fails on any difference; CI's `lock-hash` job runs
the same three steps. Another host or rustc builds a working lock with other
bytes, so its hash will not match.

[`docs/SECURITY-EVIDENCE.md`](docs/SECURITY-EVIDENCE.md) collects the evidence
for each rule and error code in one report: the check in the script, the accepted
transactions, the node's rejection text, the CKB-VM tests, and which rules have
only been shown in CKB-VM tests. `npm run evidence` re-checks its logs against
testnet, read-only.

`npm run smoke:lock` runs the rules in the table below against public testnet. Run on 14 Oct 2026, on the current lock:

| Step | Network said |
|---|---|
| Owner funds three session cells and a key cell | [accepted](https://testnet.explorer.nervos.org/transaction/0x12a553c12e733a50f18db09edf8112031c9e39b1949e1f11699a67e3e30ba350) |
| Session key spends exactly `max_per_tx` (100 CKB), no owner signature | [accepted](https://testnet.explorer.nervos.org/transaction/0xe2fced3a5d73059465f0b9400acdf0cba3fc27e441b82d1faebcbe44b1b20a8b) |
| Session key spends 100 CKB + 1 shannon | **rejected**, error 12 (outflow exceeds max_per_tx) |
| Rate-limited cell spent with no `since` | **rejected**, error 14 (rate limited) |
| Same cell with `since` = 3 relative blocks | [accepted once mature](https://testnet.explorer.nervos.org/transaction/0xe53e4ada7f76d847b7e1883115c9b31851d8962e195cc2eb1fdaeb53e6b07653) |
| Change split into two cells | **rejected**, error 16 (too many change cells) |
| Recipient-scoped cell, 50 CKB moved into the key cell | **rejected**, error 17 (key cell may not grow) |
| Change given a type script (a valid Type ID) | **rejected**, error 18 (no type scripts) |
| Owner sweeps everything back | [accepted](https://testnet.explorer.nervos.org/transaction/0x8019404b3708050660b921201ec534cc7f20ef68fa1e836012d33f531066bae5) |

Cycles, measured with [ckb-cycle-tools](https://github.com/luongthanhtung03/ckb-cycle-tools)
on the accepted session spend: the session lock 15,651, the key cell's
secp256k1 lock 1,652,327, matching the node's 1,667,978 exactly. On a token
payment from the /tokens page's flow: the session lock 29,031, xUDT 18,795, the
creator's anyone-can-pay lock 34,106, the key 1,642,571 (1,724,503 in all).

### v0.1 browser flow, verified on public testnet

`npm run smoke:testnet` funds a fresh session, spends inside its scope, and checks
that an over-limit spend is refused. Run on 8 Oct 2026:

| Step | Result |
|---|---|
| Fund the session (300 CKB) | [0x2acf…c45f](https://testnet.explorer.nervos.org/transaction/0x2acff2323c07cb36dd9d58343df83277cdab68725541020acbff4dc968d0c45f) |
| Spend 100 CKB, signed by the session key | [0x52a1…da50](https://testnet.explorer.nervos.org/transaction/0x52a1b3ba45a28614c30ddc52f0795c164141abbebd1558e6c69fb0ac45fada50) |
| Spend 150 CKB (limit 100) | refused before signing |

## Limits

What this does not do, in one place. Each is stated where it applies above.
What has and has not been shown on testnet is in
[`docs/SECURITY-EVIDENCE.md`](docs/SECURITY-EVIDENCE.md#5-not-covered-and-limits).

- **Testnet only, not audited.** The lock has had community and adversarial
  reviews, each finding fixed with a regression test, but no external audit.
  Do not put mainnet funds behind it.
- **Expiry is not on-chain.** A CKB script cannot prove that time has *not*
  passed, so `expiresAt` is checked in the browser. A leaked key stays valid
  until the owner sweeps; the session's balance is the most it can lose.
- **The rate limit is per cell.** `openSession` makes one cell and the lock
  forbids splitting, but anyone adding more cells under the same session lock
  gives the key more cells to spend from (with their own money, never the owner's).
- **The key cell is not recoverable without the key.** `recoverSessions` sweeps
  every session cell with the wallet alone; the 62–64 CKB key cell needs the
  lost key.
- **An owner sweep can be raced.** A key holder can replace a pending sweep by
  paying a higher fee. Sweep early and sweep again.
- **Paid access is checked at zero confirmations.** `verifyAccess` accepts a
  payment once it is committed in a block; a reorg could undo it after the
  content was released. Fine for articles and pixels, not for anything costly.
- **An access proof does not expire.** It is a bearer token for one article:
  whoever holds the signed proof can fetch that article again. It cannot be
  used for another article or by another payment.
- **Owner locks must need a signature.** An anyone-can-pay owner lock would give
  anyone owner mode; `openSession` refuses one.
- **Subscription periods are in blocks, and charges need the creator online.**
  The lock's rate limit is a block count, so a period is an estimate of time
  (`blocksForSeconds`). Nothing charges by itself: the creator's server must
  send each charge, one transaction per subscriber. Cancelling ends access at
  once, and the current period's price is not refunded.
- **Sessions are not cheap to open.** A session cell occupies 121 CKB (153 with a
  recipient), returned on close; small payments go to anyone-can-pay cells
  because a new cell needs 61 CKB.

## Why it is a separate repository

The session problem has nothing to do with any one application. Anything that wants
to act repeatedly on a user's behalf in a browser has it, so it should not be buried
inside one application's source tree.

## Related work

Other CKB projects work on nearby problems. This is what each one does, as
described in its own public post or repository, and where this kit differs.

- **CKAutomata** ([forum post](https://talk.nervos.org/t/introducing-ckautomata-payment-automation-and-nervos-dao-harvest-on-ckb/10813),
  [CKBuilder review issue](https://github.com/Nervos-Community-Catalyst/CKBuilder-projects/issues/43)):
  one-time, scheduled and recurring CKB payments, and Nervos DAO harvest. Each
  automation is a cell holding its rules, schedule and funds; the user signs once
  to set it up, and an executor submits each payment when it is due, without
  being able to change amount, recipient or schedule. The overlap is with
  subscriptions here: both let a payer sign once and be charged later while
  offline. The differences: here the subscription is one use of a general
  session lock, the creator's own server holds the key and pulls each charge,
  and `subscriptionStatus` lets that server gate content on-chain with no
  database. This kit does not schedule payments for third-party executors and
  does nothing with the Nervos DAO.
- **QuotaCell** ([forum post](https://talk.nervos.org/t/quotacell-let-your-team-spend-without-handing-over-the-treasury/11002),
  [repository](https://github.com/Ticoworld/QuotaCell)): a shared treasury
  allowance for a team. Several delegates, each with their own key, a personal
  limit and a per-payment ceiling, draw from one cumulative allowance that only
  the owner can renew, enforced by an on-chain policy cell; agent spending is a
  use it is exploring. The session lock also enforces spend limits on-chain, but
  for a different shape: one user, one short-lived key generated and held in that
  user's browser, a fixed recipient and a rate limit, so an app can act without
  wallet popups. It has no notion of several delegates sharing one allowance.
- **FiberLatch Access** ([forum post](https://talk.nervos.org/t/dis-fiberlatch-access-open-source-access-control-for-fiber-payments/10414))
  and Fiber's **Encrypted Data Payment** pattern
  ([docs](https://www.fiber.world/docs/build/encrypted-data-payment)): access to
  content paid for over Fiber. FiberLatch issues and verifies signed access
  receipts once an app has accepted a payment; in the Fiber pattern, the invoice
  preimage is the key that decrypts the data. Pay-per-read here runs on CKB L1
  instead: no channel to open, each payment is an ordinary transaction signed by
  the session key inside the on-chain scope, and the server checks the payment on
  chain (`verifyAccess`). The trade-off is that every L1 payment waits for a block
  and pays a fee, where a Fiber payment settles off-chain once a channel is open.
- **Wallet and login projects**: [JoyID](https://docs.joyid.dev/) (passkey
  wallet), [Corven Connect](https://corvanide.space/connect/docs/introduction)
  (Google and passkey sign-in with an embedded CKB wallet) and
  [CKB KeyWay](https://github.com/officialcmg/ckb-keyway) (email login with a
  recoverable CKB account, plus Fiber). These create or unlock the user's
  account. This kit does not: it starts from a wallet the user already has and
  removes the repeated signing after that, so it can sit on top of any of them.
  A JoyID owner works today (tested by hand); the other two have not been tested
  as session owners.

## Licence

MIT. See [LICENSE](LICENSE).

## Author

Luong Thanh Tung — [@luongthanhtung03](https://github.com/luongthanhtung03)
