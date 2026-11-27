# TASK-0066: One node per data dir; regtest in its own directory

Status: pending
Priority: P2
Size: small
Depends on: none
Source: F-047 (reassessment 3, 2026-11-27)

## Why

Nothing stops two node processes from using one data dir (all reproduced):
- A second process rewrites `api.cookie`, so the running node's wallet routes refuse the token on disk until it restarts, and rewrites `mempool.json`, before it fails on the taken port.
- Two running on different ports append to the same block files. One loops on `UNIQUE constraint failed: blocks.height`, and the next start rebuilds the database.
- `--regtest` uses the same default data dir as the main network (`config.ts:20-29`). Started on a main data dir, it dropped and rebuilt the live database under regtest rules. Each later switch rebuilds again, regtest blocks stay in the main block files, and the two networks share `wallet.dat` and `peers.json`.

## Scope

- Take an exclusive lock on the data dir before anything is read or written (a lock file held open, refused while another process holds it), and exit with a clear error if it is taken.
- Give regtest its own default subdirectory (for example `<default data dir>/regtest`). An explicit `--data-dir` is used as given.

## Acceptance criteria

- [ ] A second node on the same data dir exits with code 1 before it touches any file; the first node is unaffected (smoke).
- [ ] The lock is released on exit, including after SIGKILL (no stale-lock problem).
- [ ] `--regtest` without `--data-dir` doesn't use the main network's directory.

## Validation

`npm run check`, `npm run smoke`, `npm run docker:check`.

## Notes

Node has no built-in `flock`. Options: an exclusive `open(..., 'wx')` lock file with the PID and a staleness check, or a SQLite exclusive lock on a small lock database, which the OS releases when the process dies.
