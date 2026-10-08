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

## Why it is a separate repository

The session problem has nothing to do with any one application. Anything that wants
to act repeatedly on a user's behalf in a browser has it, so it should not be buried
inside one application's source tree.

## Licence

MIT. See [LICENSE](LICENSE).

## Author

Luong Thanh Tung — [@luongthanhtung03](https://github.com/luongthanhtung03)
