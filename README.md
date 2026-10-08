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
| w/c 2 Nov | Survives reload; device-loss recovery |
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

Its first example application is pay-per-use API metering over Fiber, but the
problem is not specific to that application.

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
import { createSession, openSession, spendInSession, closeSession } from "ckb-session-kit";

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
a session spend. 20 tests run it in the real CKB-VM, most asserting a specific
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
