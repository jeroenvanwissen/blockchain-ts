# Backlog

Status values: `pending`, `in-progress`, `done`, `blocked`. Priority: P0 now, P1 next, P2 planned, P3 later.
Task IDs are permanent. Don't renumber when priorities change. Findings (`F-0xx`) refer to [assessment-2026-11-23.md](assessment-2026-11-23.md).

The goal of the ordering is a node that actually works end to end: it starts, mines, restarts, enforces consensus, moves to PoS, and syncs with peers. Each milestone ends in something you can run.

## Milestone 1: the node runs and mines

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0001](TASK-0001-node-start-restart.md) | Make the node start and restart from disk | pending | P0 | small | none | F-001, F-002, F-015 |
| [TASK-0002](TASK-0002-hash-logging.md) | Remove per-hash logging from block hashing | pending | P0 | small | none | F-014 |
| [TASK-0003](TASK-0003-real-runtime-tests.md) | Add integration tests that use the real runtime | pending | P0 | medium | TASK-0001 | F-016 |
| [TASK-0004](TASK-0004-in-node-mining.md) | Mine PoW blocks inside the node | pending | P0 | medium | TASK-0001, TASK-0002 | F-003, old E3 |

## Milestone 2: consensus is enforced

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0005](TASK-0005-transaction-format.md) | Canonical transaction format with verified signatures | pending | P0 | large | TASK-0003 | F-004, F-011, F-012, F-020 |
| [TASK-0006](TASK-0006-block-validation.md) | One block-validation path against a UTXO view | pending | P0 | large | TASK-0005 | F-005, F-010 |

## Milestone 3: PoW header and difficulty

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0007](TASK-0007-block-header.md) | Block header with merkle root and compact target | pending | P1 | large | TASK-0005 | F-008, F-011, old F3 |
| [TASK-0008](TASK-0008-retarget.md) | Per-block retarget and timestamp rules | pending | P1 | medium | TASK-0007 | F-008 |

## Milestone 4: UTXO proof of stake

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0011](TASK-0011-remove-stake-registry.md) | Remove the registered-stake model | pending | P1 | medium | owner decision | F-006 |
| [TASK-0009](TASK-0009-kernel-pos.md) | Kernel-based proof of stake | pending | P1 | large | TASK-0006, TASK-0007, TASK-0008, TASK-0011 | F-006, F-007, F-009, F-010 |
| [TASK-0010](TASK-0010-staking-loop.md) | Staking loop in the node | pending | P1 | medium | TASK-0009 | F-003 |

## Milestone 5: the network syncs

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| [TASK-0012](TASK-0012-block-tree-reorg.md) | Block tree, chain-work selection and reorganizations | pending | P1 | large | TASK-0006, TASK-0007 | F-010, old C1 |
| [TASK-0013](TASK-0013-handshake-sync.md) | Version handshake and incremental block sync | pending | P1 | large | TASK-0012 | F-013, old E5 |
| [TASK-0014](TASK-0014-relay.md) | Relay validated transactions and blocks | pending | P1 | medium | TASK-0005, TASK-0013 | F-011, F-013, old D2 |
| [TASK-0015](TASK-0015-multi-node-e2e.md) | Multi-node end-to-end test | pending | P1 | medium | TASK-0004, TASK-0010, TASK-0013, TASK-0014 | F-016 |

## Later

| ID | Task | Status | Priority | Size | Depends on | Source |
| --- | --- | --- | --- | --- | --- | --- |
| TASK-0016 | Local HTTP API for chain queries | pending | P2 | medium | TASK-0006 | old D3 |
| TASK-0017 | Wallet send and balance from chain state | pending | P2 | medium | TASK-0005, TASK-0016 | old D4 |
| TASK-0018 | Transaction fees | pending | P2 | medium | TASK-0006 | old E1 |
| TASK-0019 | Mempool with conflict handling and revalidation | pending | P2 | medium | TASK-0006, TASK-0012 | old E2, F-007 |
| TASK-0020 | Peer limits and reconnect policy | pending | P2 | small | TASK-0013 | old E4 |
| TASK-0021 | Fix lint errors and gate changes on build, test and lint | pending | P2 | small | none | F-017 |
| TASK-0022 | Remove dead code and stale files | pending | P2 | small | none | F-018, old F1 |
| TASK-0023 | Leveled logging | pending | P3 | small | TASK-0002 | old F2 |
| TASK-0024 | Encrypt wallet keys at rest | pending | P3 | medium | TASK-0005 | — |

Scope notes for the later tasks (expand into task files when they're picked up):

- **TASK-0016:** read-only HTTP API bound to `127.0.0.1` by default: tip, block by hash or height, transaction, address UTXOs and balance, peers.
- **TASK-0017:** the wallet derives its UTXOs from the chain; drop the manual `Wallet.addTransaction` bookkeeping. Add coin selection, change, and submission through the API or a CLI.
- **TASK-0018:** fee = inputs − outputs, claimed in the coinbase or coinstake, with a minimum relay fee.
- **TASK-0019:** replace the pending array with a mempool: conflict detection, size limit with fee-rate eviction, revalidation on a new tip or reorg. A rejected block must never wedge block production (F-007 symptom).
- **TASK-0020:** caps on inbound and outbound connections, capped backoff, and a misbehavior score that leads to a temporary ban.
- **TASK-0021:** fix the 41 lint errors. Make `npm run build && npm test && npm run lint` the standard check. CI is recommended; adding it is the owner's call.
- **TASK-0022:** delete `index.js`, `lib/`, `jest.config.js`, `tsc.out` and `src/test-consensus.ts`. Move `@types/ws` and `@fastone/eslint-config` to devDependencies. Drop `winston` unless TASK-0023 adopts it. Rename the package to `blockchain-ts`.
- **TASK-0023:** replace `console.*` with a small leveled logger (debug output off by default). Never log key material.
- **TASK-0024:** passphrase-based key encryption (scrypt + AES-256-GCM) with an unlock step for staking.

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
| D2 Message relaying | pending | TASK-0014 |
| D3 REST API for blockchain | pending | TASK-0016 |
| D4 REST API for transactions | pending | TASK-0017 |
| E1 Transaction fees | pending | TASK-0018 |
| E2 Mempool | pending | TASK-0019 |
| E3 Miner integration | pending | TASK-0004 |
| E4 Reconnect limiting | pending | TASK-0020 |
| E5 Self-connection | pending | TASK-0013 |
| E6 Test coverage | pending | Replaced by TASK-0003 and TASK-0015 (targeted runtime tests rather than a coverage number). |
| F1 Dead code and config | pending | TASK-0022 |
| F2 Logging cleanup | pending | TASK-0023 |
| F3 Merkle tree | pending | TASK-0007 |
