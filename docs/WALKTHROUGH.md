# Demo walkthrough

A guided tour of both projects on CKB testnet, in about fifteen minutes, with one
wallet. Each step says what to do, what you should see, and what the network
(not the page) is enforcing. It doubles as the script for a recorded demo.

## Before you start

- A CKB wallet that CCC supports: JoyID is the quickest (passkey, no extension).
  MetaMask, OKX and UniSat work through Omnilock.
- About **300 testnet CKB**, from [faucet.nervos.org](https://faucet.nervos.org/).
  Each page puts ~265 CKB into a session (a 200 CKB budget for read and place,
  plus a 62–64 CKB key cell), and closing gives back everything not spent, so
  the same coins serve every page in turn.
- A second tab with the [testnet explorer](https://testnet.explorer.nervos.org/).

Every page has the same shape: **one wallet signature to open**, any number of
payments with **no wallet popup**, **one signature to close**. Between the two
signatures, the key in the browser can only do what the session lock allows.

## 1. Pay-per-read — `/read`

[ckb-session-kit.vercel.app/read](https://ckb-session-kit.vercel.app/read)

1. **connect wallet**, then **open reading session**. The wallet asks once. The
   page shows the session: 200 CKB budget, max 5 CKB per payment, recipient = the
   creator's anyone-can-pay cell. Of the 200, 153 CKB stay as the session cell's
   own storage, so 47 reads are possible.
2. Unlock an article. No popup. The status line shows the payment hash and
   "to confirm…", then the text appears once the server has found the payment
   on-chain.
3. Open the payment in the explorer. Its inputs are the session cell and the key
   cell; nothing from your wallet. The creator's cell grew by exactly 1 CKB. The
   memo `read:<article>` is in the key cell's witness.
4. Unlock two more. Each one is a payment the key signed alone.

What the network enforces here (lock errors 12 and 17, see the README): the key
cannot send more than 5 CKB per transaction, cannot pay anyone but the creator,
and cannot move session funds into its own key cell. What the server enforces:
an article is released only to the key that paid for **that** article.

5. **close** (`session close --return-to reader`). One signature. The rest of the
   budget and the key cell come back to the wallet.

## 2. CKB Place — `/place`

[ckb-session-kit.vercel.app/place](https://ckb-session-kit.vercel.app/place)

1. **open painting session** (one signature; recipient = the board).
2. Pick colours and click up to 32 pixels, then send the batch: one payment of
   0.1 CKB per pixel, no popup.
3. Reload the page. The board is rebuilt from the chain: every pixel comes from a
   payment memo (`px1` + x, y, colour). No server or database holds the board.
4. Close the session.

## 3. Pay-per-minute — `/listen`

[ckb-session-kit.vercel.app/listen](https://ckb-session-kit.vercel.app/listen)

1. **open listening session**, pick a track, play.
2. Watch **next payment**: 30 s before each minute ends, the key pays 0.5 CKB for
   the next minute (memo `listen:<track>:<minute>`). The server releases a
   minute only to the key that paid for it.
3. **pause**. The payments stop ("none while paused"). Play again and they
   resume.
4. Close. If a minute is paid but the server has not released it yet, the page
   refuses to close (only this session's key can claim that minute) and offers
   **close anyway, forfeit the unreleased minute** instead.

## 4. Token sessions — `/tokens`

[ckb-session-kit.vercel.app/tokens](https://ckb-session-kit.vercel.app/tokens)

1. Mint some demo tokens from the page (anyone can; the token is worth nothing).
2. **open token session**: the session holds tokens as well as CKB, with a
   per-payment cap in token units.
3. Unlock an article for 2 tokens. No popup; no CKB leaves the session, only
   tokens, into the creator's anyone-can-pay token cell.
4. Close: the tokens come back as tokens.

The lock caps token units per spend (error 20) the same way it caps shannons,
and allows exactly one type script on session cells: this session's token.

## 5. Subscriptions — `/subscribe`

[ckb-session-kit.vercel.app/subscribe](https://ckb-session-kit.vercel.app/subscribe)

1. **subscribe (1 signature)**: the opening pays the first period (2 CKB) and puts
   163 CKB in a cell you own, under the session lock with the creator's charger
   key as the session key. The members' notes appear: the server checked on-chain
   that this subscription is paid up and bound to this browser's account id.
2. Watch **paid through**: about 60 blocks later the period ends; the page asks
   the creator's server to charge the next one, and a 2 CKB charge appears in the
   log with no wallet popup. (Needs `CHARGER_KEY` in the deployment.)
3. **cancel subscription**: one signature sweeps everything left back to you; the
   creator is not asked. The notes lock again.
4. Switch **pay in** to **demo token**, mint 12 tokens from the page, and
   subscribe again: the price is now 2 tokens a period, and no CKB ever leaves the
   cell (its CKB limit per payment is 0).

## 6. Lost device — recover

On the [home page](https://ckb-session-kit.vercel.app/), **recover**
(`session recover --owner wallet`) finds every session
your wallet ever opened, using only the wallet, and sweeps it back in one
signature. To try it: open a session, clear the site's storage (the key is
gone), reload, recover. Only the key cell (the fee budget, ~62 CKB) cannot come
back, since only the lost key can spend it.

## 7. Measure what you just did — ckb-cycle-tools

[ckb-cycle-tools.vercel.app](https://ckb-cycle-tools.vercel.app/)

1. Paste the hash of any payment from step 1. The page shows the node's total
   cycles and the script groups that ran.
2. Press **per-group cycles**. ckb-debugger runs in the page (WebAssembly, ~1 MB
   download) and splits the total by script: the session lock costs about
   15.7k cycles, under 1% of the transaction; the key cell's secp256k1 lock is the
   rest. The sum matches the node's total exactly.
3. Click the session lock's row and name it; the page prints the CLI command
   (`npm run cycles -- <hash> --name …`) for the same breakdown in a terminal.

For a token payment from step 4, the breakdown shows four groups: the session
lock, xUDT, the creator's anyone-can-pay lock and the key.

## If something goes wrong

- **"payment is pending"** — testnet blocks take ~8–10 s. The page retries the
  claim; nothing is lost.
- **A payment is rejected** — the message names the lock's error code; the codes
  are listed in [API.md](API.md). On /place, the pixels go back into the batch to retry.
- **Wallet closed mid-open** — the key was saved before the funding transaction
  was sent, so reloading finds the session; if not, **recover** does.
