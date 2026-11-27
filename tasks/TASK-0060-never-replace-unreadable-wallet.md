# TASK-0060: Never replace an unreadable wallet file

Status: pending
Priority: P1
Size: small
Depends on: none
Source: F-039, F-054 (wallet fsync), F-055 (`importWallet`) (reassessment 3, 2026-11-27)

## Why

When `wallet.dat` can't be read or parsed, `loadWallet` logs an error, generates a new wallet and saves it. The old file survives only as `wallet.dat.<ms>.backup` (`Wallet.ts:713-722`, `:771-775`). `encrypt()` and `changePassphrase()` delete every backup (`:483`, `:501`). If the lost wallet was encrypted, the new one reports "not encrypted", and the natural fix, `encrypt-wallet`, deletes the only copy. Reproduced with a file from a newer version (unknown seed format) and with a truncated file.

The wallet is written to a temp file and renamed with no fsync of the file or the directory (`:777-779`), so a power loss could plausibly leave an empty file behind (inferred). The unused `Wallet.importWallet` copies over `wallet.dat` without checking (`:829-846`), against the rule that a restore never replaces an existing `wallet.dat`.

## Scope

- If `wallet.dat` exists but can't be read or parsed, stop with a clear error and exit code. Leave the file alone. The error says how to recover: restore from the seed phrase into a new data dir, or move the file aside.
- Fsync the temp file before the rename, and the directory after it.
- Remove `importWallet` and `exportWallet` (used only by tests), or make import refuse an existing file.
- Backups: never delete one the running wallet didn't write itself under the same seed. Or simply stop deleting backups of a different wallet; decide which in the task.

## Acceptance criteria

- [ ] A truncated, empty or newer-format `wallet.dat` stops the node with an error naming the file. The file is unchanged and no new wallet is written.
- [ ] Wallet writes are fsynced (file and directory).
- [ ] No code path overwrites an existing `wallet.dat` except the wallet's own atomic save.
- [ ] smoke covers the refusal (a damaged `wallet.dat`, exit code 1, the file unchanged).

## Validation

`npm run check`, `npm run smoke`, `npm run docker:check` (startup change).
