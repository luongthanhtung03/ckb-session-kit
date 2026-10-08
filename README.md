# ckb-session-kit

Browser-held self-custody sessions for CKB applications.

**Status: early development.** Built in the open during my CKBuilder programme.

| When | Milestone |
|---|---|
| w/c 5 Oct 2026 | Scaffold, tests, CI |
| w/c 12 Oct | Session key held in the browser signs a testnet transfer; live demo |
| w/c 19 Oct | Session lock script — scope and expiry enforced on-chain |
| w/c 26 Oct | Delegate, act repeatedly with no wallet dialog, revoke |
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
- It can sign within a **declared, enforced scope** — and nothing outside it.
- The session **survives a page reload**, and expires on terms the user set.
- Losing the device does not mean losing the funds.

Its first example application is pay-per-use API metering over Fiber, but the
problem is not specific to that application.

## Try it

```bash
npm install
npm test                 # 19 tests, no network needed
npm run demo             # the web demo at http://localhost:5173
```

The demo creates a session in the browser, shows its testnet address (fund it from
the [faucet](https://faucet.nervos.org/)), and sends within scope with no wallet
dialog. Ask for more than the limit and the session refuses.

**Current stage (v0.1):** the scope is enforced in the browser. The session lock
script that makes it binding on-chain is the next milestone.

### Verified on public testnet

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
