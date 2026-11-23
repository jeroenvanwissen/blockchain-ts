# TASK-0024: Encrypt wallet keys at rest

Status: done
Priority: P3
Size: medium
Depends on: TASK-0005
Source: none (follow-up to old B4 wallet security)

## Why

`wallet.dat` holds the private key unencrypted; file permissions (0600) are the only protection. Anyone who gets a copy of the file or a backup (disk image, synced folder, another account with read access) can spend the coins.

## Scope

- Passphrase-based encryption of the private key: scrypt key derivation, AES-256-GCM.
- An encrypted wallet starts locked. Unlocking goes through the authenticated API (owner decision, 2026-11-23): optionally for a limited time, optionally for staking only (stake blocks but no payments), following the BlackCoin model.
- CLI commands to encrypt, unlock and lock. Unencrypted wallets keep working unchanged.
- Out of scope: changing the passphrase, decrypting a wallet back to plaintext.

## Acceptance criteria

- [x] After encryption the wallet file and its backups contain no unencrypted key, and the wallet is locked.
- [x] A locked wallet can't sign: staking pauses, sends get 423. A staking-only unlock stakes but can't send. Timed unlocks lock again.
- [x] A wrong passphrase or a tampered file fails to unlock; neither the passphrase nor the key is logged.
- [x] `cli encrypt-wallet`, `cli unlock [--timeout s] [--staking-only]` and `cli lock` work against a running node.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**Wallet (`src/blockchain/Wallet.ts`)**
- `encrypt(passphrase)`:
  - Derives a key with scrypt (`WALLET_SCRYPT`: log2 N = 15, r = 8, p = 1, about 32 MiB and 0.1 s per attempt). The passphrase is NFKC-normalized and must be at least `MIN_PASSPHRASE_LENGTH` (8) characters.
  - Encrypts the private key with AES-256-GCM (random 16-byte salt and 12-byte nonce) using the public key as associated data, then checks that it decrypts.
  - Writes the file without the plaintext key, deletes every `wallet.dat.*.backup` (they hold the old plaintext key), and locks.
- `unlock(passphrase, { timeoutMs, stakingOnly })` decrypts into memory; a failed GCM tag check means a wrong passphrase or a tampered file. `lock()` zeroes the key buffer.
- Signing takes a purpose: `signTransaction(tx, 'spend' | 'stake')`, and `signDigest` (block signatures) counts as stake. Errors are typed `WalletError` codes (`locked`, `staking-only`, `wrong-passphrase`, ...).
- Wallet files are now written atomically (temporary file, then rename). Scrypt parameters read from a file are bounded before use, and encrypted wallets can be imported (structure is checked; the key can't be without the passphrase).
- Schema: new `EncryptedKey` message as `WalletData` field 6; `private_key` stays empty when encrypted. No migration: existing wallets load unchanged.

**Node**
- `createStakeBlock` returns null for a locked wallet and signs coinstakes for staking. `StakingService` logs once that staking waits for an unlock.
- The startup line says when the wallet is encrypted and locked.

**API and CLI**
- Token-protected routes:
  - `POST /wallet/encrypt { passphrase }`
  - `POST /wallet/unlock { passphrase, timeout?, stakingOnly? }`
  - `POST /wallet/lock`
  - `GET /wallet` adds `encrypted`, `locked`, `stakingOnly` and `unlockedUntil`
- Wallet errors map to 400 (weak passphrase), 403 (wrong passphrase), 409 (not or already encrypted) and 423 (send while locked or staking-only).
- `cli encrypt-wallet`, `cli unlock` and `cli lock` read the passphrase without echo from a terminal (asked twice for encryption), or from the first line of stdin otherwise. `cli balance` shows the wallet state.

**Tests**
- `integration/WalletEncryption.test.ts` (real files and protobuf) covers:
  - no plaintext key in the file, backups removed, 0600, and locked after reload
  - wrong and right passphrases, signing, and lock
  - timed relock
  - weak passphrases, double encryption, a tampered ciphertext, and lock on a plain wallet
  - importing an encrypted wallet
  - staking: none while locked, staking-only stakes but can't pay, a full unlock pays
- `Api.test.ts` covers the route status codes and payments refused while locked or staking-only.
- Smoke encrypts node A's wallet through the CLI, checks the plaintext key and backups are gone, restarts A, then checks:
  - the wallet is locked
  - a wrong passphrase fails
  - staking-only unlock and lock work
  - the passphrase never appears in output

**Runs**
- `npm run check`: 25 suites, 284 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 78 s (height 25, 5 PoS blocks); unencrypted wallets stake and pay as before.
