# Backlog

Status values: `pending`, `in-progress`, `done`, `blocked`. Priority: P0 now, P1 next, P2 planned, P3 later.
Task IDs are permanent. Don't renumber when priorities change. Findings F-001 to F-020 refer to [assessment-2026-11-23.md](assessment-2026-11-23.md), F-021 to F-030 to [reassessment-2026-11-23.md](reassessment-2026-11-23.md), F-031 and later to [reassessment-2026-11-23-2.md](reassessment-2026-11-23-2.md).

The goal of the ordering is a node that actually works end to end: it starts, mines, restarts, enforces consensus, moves to PoS, and syncs with peers. Each milestone ends in something you can run.

## Milestone 1: the node runs and mines

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0001](TASK-0001-node-start-restart.md) | Make the node start and restart from disk | done | P0 | small | none | F-001, F-002, F-015 |
| [TASK-0002](TASK-0002-hash-logging.md) | Remove per-hash logging from block hashing | done | P0 | small | none | F-014 |
| [TASK-0003](TASK-0003-real-runtime-tests.md) | Add integration tests that use the real runtime | done | P0 | medium | TASK-0001 | F-016 |
| [TASK-0004](TASK-0004-in-node-mining.md) | Mine PoW blocks inside the node | done | P0 | medium | TASK-0001, TASK-0002 | F-003, old E3 |

## Milestone 2: consensus is enforced

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0005](TASK-0005-transaction-format.md) | Canonical transaction format with verified signatures | done | P0 | large | TASK-0003 | F-004, F-011, F-012, F-020 |
| [TASK-0006](TASK-0006-block-validation.md) | One block-validation path against a UTXO view | done | P0 | large | TASK-0005 | F-005, F-010 |

## Milestone 3: PoW header and difficulty

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0007](TASK-0007-block-header.md) | Block header with merkle root and compact target | done | P1 | large | TASK-0005 | F-008, F-011, old F3 |
| [TASK-0008](TASK-0008-retarget.md) | Per-block retarget and timestamp rules | done | P1 | medium | TASK-0007 | F-008 |

## Milestone 4: UTXO proof of stake

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0011](TASK-0011-remove-stake-registry.md) | Remove the registered-stake model | done | P1 | medium | owner decision (approved 2026-11-23) | F-006 |
| [TASK-0009](TASK-0009-kernel-pos.md) | Kernel-based proof of stake | done | P1 | large | TASK-0006, TASK-0007, TASK-0008, TASK-0011 | F-006, F-007, F-009, F-010 |
| [TASK-0010](TASK-0010-staking-loop.md) | Staking loop in the node | done | P1 | medium | TASK-0009 | F-003 |

## Milestone 5: the network syncs

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0012](TASK-0012-block-tree-reorg.md) | Block tree, chain-work selection and reorganizations | done | P1 | large | TASK-0006, TASK-0007 | F-010, old C1 |
| [TASK-0013](TASK-0013-handshake-sync.md) | Version handshake and incremental block sync | done | P1 | large | TASK-0012 | F-013, old E5 |
| [TASK-0014](TASK-0014-relay.md) | Relay validated transactions and blocks | done | P1 | medium | TASK-0005, TASK-0013 | F-011, F-013, old D2 |
| [TASK-0015](TASK-0015-multi-node-e2e.md) | Multi-node end-to-end test | done | P1 | medium | TASK-0004, TASK-0010, TASK-0013, TASK-0014 | F-016 |

## Later

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0016](TASK-0016-http-api.md) | Local HTTP API for chain queries | done | P2 | medium | TASK-0006 | old D3 |
| [TASK-0017](TASK-0017-wallet-send.md) | Wallet send and balance from chain state | done | P2 | medium | TASK-0005, TASK-0016 | old D4 |
| [TASK-0018](TASK-0018-fees.md) | Transaction fees | done | P2 | medium | TASK-0006 | old E1 |
| [TASK-0019](TASK-0019-mempool.md) | Mempool with conflict handling and revalidation | done | P2 | medium | TASK-0006, TASK-0012 | old E2, F-007 |
| [TASK-0020](TASK-0020-peer-limits.md) | Peer limits and reconnect policy | done | P2 | small | TASK-0013 | old E4 |
| [TASK-0021](TASK-0021-lint.md) | Fix lint errors and gate changes on build, test and lint | done | P2 | small | none | F-017 |
| [TASK-0022](TASK-0022-dead-code.md) | Remove dead code and stale files | done | P2 | small | none | F-018, old F1 |
| [TASK-0023](TASK-0023-logging.md) | Leveled logging | done | P3 | small | TASK-0002 | old F2 |
| [TASK-0024](TASK-0024-wallet-encryption.md) | Encrypt wallet keys at rest | done | P3 | medium | TASK-0005 | — |

## Milestone 6: hardening (from the reassessment)

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0025](TASK-0025-stake-age.md) | Bound transaction timestamps; measure stake age from block time | done | P1 | medium | TASK-0009 | F-021 |
| [TASK-0026](TASK-0026-tie-break.md) | Equal-work tie-break that block contents can't influence | done | P2 | small | TASK-0012 | F-022 |
| [TASK-0027](TASK-0027-wallet-loopback.md) | Keep wallet routes on loopback | done | P2 | small | TASK-0017 | F-023 |
| [TASK-0028](TASK-0028-signature-cache.md) | Mempool revalidation without re-verifying signatures | done | P3 | small | TASK-0019 | F-024 |
| [TASK-0029](TASK-0029-chainstate.md) | Chainstate snapshot for fast startup | done | P3 | medium | TASK-0012 | F-025 |
| [TASK-0033](TASK-0033-ci.md) | CI: check, smoke and e2e on every push and pull request | done | P2 | small | TASK-0021 | F-030 |
| [TASK-0034](TASK-0034-dependency-security.md) | Security updates for runtime dependencies (protobufjs, ws) | done | P1 | small | none | npm audit, GitHub Dependabot alerts |
| [TASK-0035](TASK-0035-typescript-6.md) | TypeScript 6.0; hold back TypeScript 7 (Dependabot PR #113) | done | P2 | small | none | Dependabot PR #113 |
| [TASK-0036](TASK-0036-eslint-10.md) | ESLint 10 with a flat config (ESLint 8 is unsupported) | done | P2 | small | TASK-0021 | Dependabot PR #119 |
| [TASK-0030](TASK-0030-request-limits.md) | Throttle block requests; persist bans | done | P3 | small | TASK-0020 | F-026, F-027 |
| [TASK-0031](TASK-0031-tx-index.md) | Transaction index | done | P3 | small | TASK-0016 | F-028 |
| [TASK-0032](TASK-0032-change-passphrase.md) | Change the wallet passphrase | done | P3 | small | TASK-0024 | F-029 |

## Milestone 7: running the node as a service (from reassessment 2)

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0037](TASK-0037-process-lifecycle.md) | Graceful shutdown on SIGTERM; fail fast when the P2P port is taken | done | P2 | small | none | F-031, F-032 |
| [TASK-0038](TASK-0038-node-versions.md) | Declare and test the supported Node versions | done | P2 | small | TASK-0033 | F-033 |
| [TASK-0039](TASK-0039-address-book.md) | Peer address book: evict failing addresses, choose outbound peers at random | done | P2 | medium | TASK-0020 | F-034 |
| [TASK-0040](TASK-0040-staking-status.md) | Staking status in the API and CLI | done | P3 | small | TASK-0016 | F-035 |

## Milestone 8: features (owner requests, 2026-11-23)

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0041](TASK-0041-wallet-addresses.md) | HD wallet: any number of addresses from one seed | done | P2 | large | TASK-0024 | owner request |
| [TASK-0042](TASK-0042-block-explorer.md) | Block explorer page served by the node | done | P2 | medium | TASK-0016 | owner request |
| [TASK-0043](TASK-0043-docker.md) | Docker image and compose file | done | P2 | medium | TASK-0037 | owner request |
| [TASK-0044](TASK-0044-one-connection-per-node.md) | One connection per peer node, whatever address reaches it | done | P2 | small | TASK-0039 | found in TASK-0043 |
| [TASK-0045](TASK-0045-address-history.md) | Address history index: every transaction per address, in the API and explorer | done | P2 | medium | TASK-0042 | owner request |
| [TASK-0046](TASK-0046-wallet-history.md) | Wallet transaction history over all addresses, in the API and CLI | done | P2 | small | TASK-0045 | owner request |
| [TASK-0047](TASK-0047-keep-unconfirmed-payments.md) | Keep the wallet's unconfirmed payments across restarts | done | P2 | small | TASK-0019 | found in TASK-0046 |

## History: migrated from `.agent/TASKS.md` (2026-11-23)

The old backlog used wave IDs (A1 to F3). Its task files lived in `.agent/tasks/` and are still in git history before this change.

| Old ID | Old status | Now |
| --- | --- | --- |
| A1 Fix transaction signing | done | Signing exists; verification was never wired up (F-004). Reopened as TASK-0005. |
| A2 UTXO double-spend | done | Only enforced in the mempool; blocks are unchecked (F-005). Reopened as TASK-0006. |
| A3 Concurrency locks | done | Kept. |
| A4 Coinbase validation | done | Kept; reward check folds into TASK-0006 (subsidy + fees). |
| B1 PoS validator selection | done | Superseded by TASK-0009 and TASK-0011 (F-006). |
| B2 Transaction validation | done | Structural checks kept; ownership checks added in TASK-0005. |
| B3 Difficulty adjustment | done | Superseded by TASK-0007 and TASK-0008 (F-008). |
| B4 Wallet security | done | Kept; encryption at rest is TASK-0024. |
| B5 Binary persistence | done | Decode bug F-002 fixed in TASK-0001. |
| B6 Chunked block storage | done | Kept; `replaceAll` goes away in TASK-0012. |
| B7 Cross-platform paths | done | Wallet ignores the data dir (F-015), fixed in TASK-0001. |
| C1 Fork resolution | done | Full-chain swap only. Superseded by TASK-0012. |
| C2 Block validation | done | Transaction checks inside blocks are missing (F-005). Reopened as TASK-0006. |
| C3 Stake security | done | Superseded by TASK-0011 (unstake delay and slashing removed with the stake registry). |
| C4 Remove test bypasses | done | Kept. |
| D1 Peer discovery | done | Kept. |
| D2 Message relaying | done | TASK-0014 |
| D3 REST API for blockchain | done | TASK-0016 |
| D4 REST API for transactions | done | TASK-0017 |
| E1 Transaction fees | done | TASK-0018 |
| E2 Mempool | done | TASK-0019 |
| E3 Miner integration | done | TASK-0004 |
| E4 Reconnect limiting | done | TASK-0020 |
| E5 Self-connection | done | TASK-0013 |
| E6 Test coverage | done | Replaced by TASK-0003 and TASK-0015 (targeted runtime tests rather than a coverage number). |
| F1 Dead code and config | done | TASK-0022 |
| F2 Logging cleanup | done | TASK-0023 |
| F3 Merkle tree | done | TASK-0007 |
