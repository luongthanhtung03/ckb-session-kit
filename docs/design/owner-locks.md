# Owner locks: how each accepted lock can be unlocked

The session lock lets any transaction that spends a cell under the owner's lock act as
the owner. That is safe only if every way of unlocking the owner's lock needs the
owner's signature over the whole transaction. This page lists each unlocking path of
every owner lock `assertSigningLock` accepts, from the deployed code, as of 5 Nov 2026.

"Whole transaction" means the CKB sighash_all message: the transaction hash, which
commits to every input and output, plus the witnesses of the lock's own inputs.

| Lock | Unlocking path | What is signed | Accepted |
|---|---|---|---|
| secp256k1-blake160 | one secp256k1 signature | whole transaction | yes (20-byte args) |
| secp256k1 multisig v1, v2 | M of N signatures; optional since in args | whole transaction; the since only adds a time condition | yes (20 or 28-byte args) |
| Omnilock, auth 0x00 CKB, 0x01 Ethereum, 0x02 EOS, 0x03 Tron, 0x04 Bitcoin, 0x05 Dogecoin, 0x06 multisig, 0x12 Ethereum (displayed) | one signature (or M of N) of that kind | whole transaction | yes |
| Omnilock time-lock (0x04) or supply (0x08) mode | adds a check before the signature | whole transaction | yes |
| Omnilock administrator mode (0x01) | a whitelisted administrator signs | whole transaction, but not by the owner | no |
| Omnilock anyone-can-pay mode (0x02) | no signature, payment only | nothing | no |
| Omnilock auth 0xFC, 0xFD, 0xFE | another lock or other code decides | depends on it | only with `allowUnreviewedOwnerLock` |
| Nostr lock, signing mode | Schnorr signature over an event that carries the sighash_all | whole transaction | yes |
| Nostr lock, proof of work mode | proof of work, no key | nothing | no |
| JoyID | passkey signature with the main key, or a sub key registered in the account's CoTA cell | whole transaction, per JoyID's documentation | yes, documentation-reviewed only |

Open transactions and CoBuild. The CoBuild protocol defines an "Otx" mode in which a
signature covers only part of a transaction. None of the accepted locks, as deployed on
mainnet, implements it: the deployed Omnilock is the build from commit `cd764d7` of
nervosnetwork/omnilock (its data hash `0x768f306681da232ceb0b94f436c5f813377179762a831c5ad8797bd4fd2d118d` matches the hash pinned in that
commit's tests), which has no CoBuild or open-transaction code. An experimental Omnilock
with an open-transaction mode bit (0x10) exists on a branch; that bit is refused here.
Never sign an open or partial transaction with a lock that owns sessions: anyone holding
that piece could spend your sessions with it.

Upgrades. Omnilock, JoyID and the Nostr lock are deployed under type ids that their
deployers can upgrade. This review covers the code deployed on 5 Nov 2026. A future
upgrade that added a partial-signing mode would apply to existing sessions too.

JoyID. Its contract is not open source, so the rows above come from its documentation.
Its deployed binary also contains sub-key and social-recovery structures whose rules we
could not read. If you need source-reviewed owners only, do not accept JoyID owners in
your app.

Sources: nervosnetwork/omnilock `cd764d7` (c/omni_lock.c, c/ckb_identity.h); RFC 0042;
nervosnetwork/ckb-system-scripts (c/secp256k1_blake160_sighash_all.c,
c/secp256k1_blake160_multisig_all.c); cryptape/nostr-binding `eef134e`
(contracts/nostr-lock); JoyID docs (nervina-labs/joyid-docs, guide/ckb/smart-contract);
CKB Transaction CoBuild Protocol Overview (talk.nervos.org/t/7702).
