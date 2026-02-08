# Project Tasks

> Define and track development tasks for the blockchain-ts project.
> Each task = 1 PR with clear acceptance criteria.

---

## Task Status Legend

| Status | Meaning                    |
| ------ | -------------------------- |
| `[ ]`  | not-started                |
| `[~]`  | in-progress                |
| `[x]`  | completed                  |
| `[!]`  | blocked (needs discussion) |

---

## Current Tasks

### Wave A — Critical Fixes (no dependencies, start in parallel)

_Security vulnerabilities and consensus-breaking bugs. The blockchain does not work correctly without these._

| Status | ID   | Task                                                                    | Priority | Dependencies |
| ------ | ---- | ----------------------------------------------------------------------- | -------- | ------------ |
| `[ ]`  | `A1` | [Fix Transaction Signing](tasks/A1-fix-transaction-signing.md)          | Critical | None         |
| `[ ]`  | `A2` | [Fix UTXO Double-Spend](tasks/A2-utxo-double-spend.md)                 | Critical | None         |
| `[ ]`  | `A3` | [Fix Concurrency / Race Conditions](tasks/A3-concurrency-locks.md)     | Critical | None         |
| `[ ]`  | `A4` | [Coinbase Transaction Validation](tasks/A4-coinbase-validation.md)     | High     | None         |

### Wave B — Consensus & Validation (depends on Wave A)

_Complete the consensus mechanism and add missing validation._

| Status | ID   | Task                                                                        | Priority | Dependencies |
| ------ | ---- | --------------------------------------------------------------------------- | -------- | ------------ |
| `[ ]`  | `B1` | [Implement PoS Validator Selection](tasks/B1-pos-validator-selection.md)    | Critical | A3           |
| `[ ]`  | `B2` | [Complete Transaction Validation](tasks/B2-transaction-validation.md)       | High     | A1, A2       |
| `[ ]`  | `B3` | [Fix Difficulty Adjustment](tasks/B3-difficulty-adjustment.md)              | High     | None         |
| `[ ]`  | `B4` | [Wallet Security Hardening](tasks/B4-wallet-security.md)                    | Medium   | None         |

### Wave C — Hardening (depends on Wave B)

_Fork handling, block validation, stake security, and test cleanup._

| Status | ID   | Task                                                                        | Priority | Dependencies |
| ------ | ---- | --------------------------------------------------------------------------- | -------- | ------------ |
| `[ ]`  | `C1` | [Implement Fork Resolution](tasks/C1-fork-resolution.md)                   | High     | B1           |
| `[ ]`  | `C2` | [Complete Block Validation](tasks/C2-block-validation.md)                   | High     | A4, B2       |
| `[ ]`  | `C3` | [Stake Security Improvements](tasks/C3-stake-security.md)                   | Medium   | B1           |
| `[ ]`  | `C4` | [Remove Test Environment Bypasses](tasks/C4-remove-test-bypasses.md)       | Medium   | B2, C2       |

### Wave D — Networking & API (after core is solid)

_P2P improvements, REST API, and external interaction._

| Status | ID   | Task                                                            | Priority | Dependencies |
| ------ | ---- | --------------------------------------------------------------- | -------- | ------------ |
| `[ ]`  | `D1` | [Peer Discovery Mechanism](tasks/D1-peer-discovery.md)          | High     | None         |
| `[ ]`  | `D2` | [Message Relaying](tasks/D2-message-relaying.md)                | High     | D1           |
| `[ ]`  | `D3` | [REST API for Blockchain](tasks/D3-api-blockchain.md)           | High     | None         |
| `[ ]`  | `D4` | [REST API for Transactions](tasks/D4-api-transactions.md)       | High     | D3           |

### Wave E — Features & Polish

_Mining improvements, fees, mempool, and remaining networking._

| Status | ID   | Task                                                            | Priority | Dependencies |
| ------ | ---- | --------------------------------------------------------------- | -------- | ------------ |
| `[ ]`  | `E1` | [Transaction Fee System](tasks/E1-transaction-fees.md)          | Medium   | None         |
| `[ ]`  | `E2` | [Transaction Mempool](tasks/E2-mempool.md)                      | Medium   | E1           |
| `[ ]`  | `E3` | [Improve Miner Integration](tasks/E3-miner-integration.md)     | Medium   | None         |
| `[ ]`  | `E4` | [Limit Peer Reconnection](tasks/E4-reconnect-limiting.md)       | Medium   | None         |
| `[ ]`  | `E5` | [Prevent Self-Connection](tasks/E5-self-connection.md)           | Medium   | D1           |
| `[ ]`  | `E6` | [Improve Test Coverage](tasks/E6-test-coverage.md)              | Medium   | None         |

### Wave F — Cleanup & Nice-to-Have

_Final cleanup, logging, data structures._

| Status | ID   | Task                                                            | Priority | Dependencies |
| ------ | ---- | --------------------------------------------------------------- | -------- | ------------ |
| `[ ]`  | `F1` | [Clean Up Dead Code and Config](tasks/F1-dead-code-config.md)  | Low      | C2, B3       |
| `[ ]`  | `F2` | [Logging Cleanup](tasks/F2-logging-cleanup.md)                  | Low      | None         |
| `[ ]`  | `F3` | [Merkle Tree](tasks/F3-merkle-tree.md)                          | Low      | None         |

---

## Dependency Graph

```
Wave A (all independent — start in parallel):
A1, A2, A3, A4

Wave B (depends on Wave A):
A3 ──> B1
A1, A2 ──> B2
B3, B4     (independent, can start with Wave A)

Wave C (depends on Wave B):
B1 ──> C1
B1 ──> C3
A4, B2 ──> C2
B2, C2 ──> C4

Wave D (after core is solid):
D1 ──> D2
D3 ──> D4

Wave E (features):
E1 ──> E2
D1 ──> E5
E3, E4, E6  (independent)

Wave F (cleanup):
C2, B3 ──> F1
F2, F3      (independent)
```

---

## Verification Commands Reference

```bash
npm run build               # Compile TypeScript
npm test                    # Run test suite
npm test -- --coverage      # Run tests with coverage report
npm run lint                # Check for lint errors
npm run lint:fix            # Auto-fix lint errors
npm run dev                 # Start dev node (watch mode)
npm run mine                # Start standalone miner
```

---

## Guardrails

| Rule                           | Value              | Action                  |
| ------------------------------ | ------------------ | ----------------------- |
| Max files changed per PR       | 8                  | Split into subtasks     |
| Max diff lines (added+removed) | 500                | Split into subtasks     |
| Compile check                  | `npm run build`    | Must pass before PR     |
| Test suite                     | `npm test`         | Must pass before PR     |
| Lint check                     | `npm run lint`     | Must pass before PR     |
| Code review required           | All PRs            | Required before merge   |
| Ambiguity detected             | Missing info       | **STOP and ask user**   |

---

## Notes

- **Start with Wave A** — these are independent and can all be worked on in parallel
- Each wave unlocks the next; don't skip ahead unless dependencies are met
- Update status as work progresses (`[ ]` → `[~]` → `[x]`)
- Archive completed waves to keep this file manageable
- See [../README.md](../README.md) for complete project documentation
- Each task should be completed on its own feature branch and merged via PR
