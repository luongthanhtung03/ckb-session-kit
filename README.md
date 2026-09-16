# ckb-session-kit

Browser-held self-custody sessions for CKB applications.

**Status: not started.** This repository exists so the work has somewhere to land.
There is no implementation here yet — the first real commit is due in Week 9 of my
CKBuilder programme (w/c 9 November 2026).

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

Extracted from a pay-per-use API metering application, because the problem is not
specific to that application.

## Why it is a separate repository

The session problem has nothing to do with API metering. Anything that wants to act
repeatedly on a user's behalf in a browser has it, so it should not be buried inside
one application's source tree.

## Licence

MIT. See [LICENSE](LICENSE).

## Author

Luong Thanh Tung — [@luongthanhtung03](https://github.com/luongthanhtung03)
