# TASK-0032: Change the wallet passphrase

Status: done
Priority: P3
Size: small
Depends on: TASK-0024
Source: F-029 (reassessment 2026-11-23)

## Why

An encrypted wallet's passphrase couldn't be changed. If it leaked, or was simply weak, the only way out was a new wallet and moving every coin to it.

## Scope

- Re-encrypt the key under a new passphrase through the wallet, the API and the CLI.
- Old backups must not keep the old passphrase useful.

## Acceptance criteria

- [x] After a change only the new passphrase unlocks; a wrong current passphrase or a weak new one is refused.
- [x] Backups made under the old passphrase are deleted, and the lock state is unchanged.
- [x] `cli change-passphrase` works against a running node, including with piped input.

## Validation

`npm run check`, `npm run smoke`.

## Outcome

**Wallet**
- `Wallet.changePassphrase(current, new)` decrypts with the current passphrase, then re-encrypts with a fresh salt and nonce through the same `encryptKey` helper that `encrypt` now uses. That helper checks length and verifies the result decrypts.
- It writes the file atomically, deletes every backup (they open with the old passphrase), and leaves a locked wallet locked and an unlocked one unlocked.
- The temporary copy of the key is zeroed. Errors: `wrong-passphrase`, `weak-passphrase`, `not-encrypted`.

**API and CLI**
- `POST /wallet/passphrase { passphrase, newPassphrase }` is token-protected and loopback-only. It returns 403, 400 or 409 for those errors.
- `cli change-passphrase` asks for the current passphrase, then the new one twice, in a terminal. With piped input it reads the current and new passphrases from the first two lines; the stdin reader now hands out one line per prompt.

**Tests**
- `WalletEncryption.test.ts`: wrong current and weak new are refused; a backup is deleted; the unlocked state is kept; after reopening, the old passphrase fails and the new one unlocks; a plain wallet is refused.
- `Api.test.ts`: 403, 400 (weak or missing new passphrase), 200, then the old passphrase gets 403 on unlock and the new one 200.
- Smoke: `cli change-passphrase` with two piped lines, then `cli unlock` with the new passphrase.

**Runs**
- `npm run check`: 27 suites, 298 tests, lint clean.
- `npm run smoke`: PASS. e2e isn't affected (wallet and API only).
