# TASK-0023: Leveled logging

Status: done
Priority: P3
Size: small
Depends on: TASK-0002
Source: old F2

## Why

The node logged through bare `console.log` and `console.error` with ad-hoc prefixes. Nothing could be filtered, per-connection noise sat next to real problems, routine conditions such as unreachable peers were logged as errors, and lines carried no timestamps.

## Scope

- A small leveled logger, with debug output off by default and the level set by an environment variable.
- Every node module logs through it at a deliberate level. The CLI and the smoke/e2e scripts keep plain console output.
- Never log key material.

## Acceptance criteria

- [x] Node log lines are `<ISO time> LEVEL [scope] message`; debug and info go to stdout, warn and error to stderr.
- [x] `LOG_LEVEL` selects debug, info (default), warn or error.
- [x] Lines the smoke and e2e scripts match on keep their wording; smoke fails on any WARN or ERROR line.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**Logger (`src/logger.ts`)**
- `logger(scope)` returns debug/info/warn/error functions. `setLogLevel` and `getLogLevel` exist for tests and tooling. No dependency; `winston` was removed in TASK-0022.
- An unknown `LOG_LEVEL` falls back to info.

**Converted modules**
- `index.ts` (`Node`), `P2PServer` (`P2P`), `Blockchain`, `Wallet`, `BlockStore`, `Miner`, `StakingService` (`Staking`) and `ApiServer` (`API`). Message prefixes like `[Blockchain]` now come from the scope.
- Levels:
  - **debug:** per-connection noise (inbound connections, dial attempts, failed reconnect attempts, blocks and transactions we didn't accept for benign reasons)
  - **info:** startup, connections, sync, accepted and staked blocks, reorgs, socket errors (message only, no stack)
  - **warn:** misbehavior and bans, invalid blocks, malformed peer messages, rejected local blocks, wallet recovery, invalid stored blocks
  - **error:** load failures, server and file I/O errors
- The API startup failure now reads `API could not listen on ...` (README updated).

**Checks**
- Smoke fails on any ` WARN [` or `ERROR [` line, plus the old text patterns.
- e2e still matches `[Blockchain] reorganized`, `[Staking] staked block`, `Chain loaded`, `API listening on` and the wallet address line.
- Tests that asserted exact console arguments now match the leveled line. `logger.test.ts` covers the format, the streams and level filtering.

**Runs**
- `npm run check`: 24 suites, 277 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 94 s (height 26, 6 PoS blocks), with no WARN or ERROR lines from the harness peer.
