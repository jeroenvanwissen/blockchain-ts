# blockchain-ts

> Hybrid PoW/PoS blockchain with UTXO transactions, P2P networking, and wallet management.

## Quick Reference

| Action         | Command                                                          |
| -------------- | ---------------------------------------------------------------- |
| Build          | `npm run build`                                                  |
| Test           | `npm test`                                                       |
| Lint           | `npm run lint`                                                   |
| Lint + fix     | `npm run lint:fix`                                               |
| Run node       | `npm run dev`                                                    |
| Run 2nd node   | `P2P_PORT=5002 PEERS=ws://localhost:5001 npm run dev`            |
| Run miner      | `npm run mine`                                                   |

## Project Structure

```
src/
├── blockchain/               # Core consensus and data structures
│   ├── Block.ts              #   Block creation, hashing, PoW/PoS detection
│   ├── Blockchain.ts         #   Chain management, UTXO set, validation, staking
│   ├── BlockStore.ts         #   Chunked block storage with index
│   ├── Transaction.ts        #   Transaction model, signing, verification
│   ├── Wallet.ts             #   Key management, address encoding, persistence
│   ├── Miner.ts              #   PoW mining via worker threads
│   ├── StakingService.ts     #   PoS block generation at intervals
│   ├── miningWorker.cjs      #   Worker thread for CPU-intensive hashing
│   └── __tests__/            #   Unit tests
├── networking/               # P2P communication
│   ├── P2PServer.ts          #   WebSocket server/client, chain sync
│   └── __tests__/            #   Unit tests
├── config.ts                 # All configuration constants
├── index.ts                  # Node entry point
└── mine.ts                   # Standalone miner entry point
data/                         # Runtime data (gitignored)
├── blocks/                   #   Chunked block storage
│   ├── blk00000.dat          #     Block data files (append-only)
│   └── index.dat             #     Block index (hash/height → file + offset)
├── wallet.dat                #   Wallet keys and address (protobuf)
└── peers.json                #   Known peer addresses
```

## Architecture

The system is a single-process blockchain node with optional external miner. `Blockchain` is the central class managing chain state, UTXO tracking, pending transactions, staking, and consensus validation. All mutations are mutex-protected via `async-mutex`. `P2PServer` handles peer-to-peer WebSocket communication for chain sync, block/transaction broadcasting, and stake propagation. `BlockStore` provides chunked block persistence using append-only files with protobuf serialization and an in-memory index. Mining uses `worker_threads` to offload PoW computation. The consensus transitions from PoW to PoS at block 100 (`POW_CUTOFF_BLOCK`), using a stake-weighted deterministic lottery for validator selection.

## Key Decisions

- **UTXO model** — Transactions use unspent transaction outputs, not account balances
- **Hybrid PoW/PoS** — First 100 blocks are PoW, then transitions to PoS with stake-weighted validator lottery
- **ECDSA signatures** — secp256k1 ECDSA for all transaction signing and verification
- **Coinbase maturity** — Coinbase outputs require `COIN_MATURITY` (10) blocks before spending
- **Chain weight** — Fork resolution uses cumulative chain weight, not longest chain
- **Stake security** — Delayed unstaking (`UNSTAKE_DELAY` blocks), double-sign slashing, age-capped weight (4x max)
- **Difficulty adjustment** — Proportional adjustment every 10 blocks with 4x max change factor
- **Worker threads for mining** — `miningWorker.cjs` is CommonJS because `worker_threads` requires it
- **ES modules** — Project uses `"type": "module"` with explicit `.js` extensions in imports
- **Single config file** — All constants in `src/config.ts`, environment variables for ports/peers only
- **Chunked block storage** — Blocks in append-only `blk*.dat` files with protobuf index; wallet as protobuf
- **Mutex for concurrency** — `async-mutex` Mutex protects all blockchain mutations; internal methods assume lock held
- **Cross-platform paths** — Platform-aware default data directory (macOS/Linux/Windows)

## Rules

Detailed conventions are in `.claude/rules/`:

| File                                       | Covers                                   |
| ------------------------------------------ | ---------------------------------------- |
| [rules/project.md](rules/project.md)      | Project structure and architecture        |
| [rules/code-style.md](rules/code-style.md)| Code style and formatting                 |
| [rules/testing.md](rules/testing.md)      | Testing conventions and requirements      |
| [rules/security.md](rules/security.md)    | Security requirements and practices       |

## Documentation Maintenance

When making changes to the codebase, update all affected documentation files to stay in sync:

| File                                         | Update when...                                     |
| -------------------------------------------- | -------------------------------------------------- |
| [README.md](../README.md)                   | Features, architecture, config, or usage changes   |
| [.agent/TASKS.md](../.agent/TASKS.md)       | Task status changes (started, completed, blocked)  |
| [.agent/README.md](../.agent/README.md)     | Workflow or tooling changes                        |
| [.claude/CLAUDE.md](./)                      | Architecture, key decisions, or structure changes  |
| [rules/code-style.md](rules/code-style.md)  | New patterns, naming conventions, or style changes |
| [rules/project.md](rules/project.md)        | New files, directories, or dependency changes      |
| [rules/security.md](rules/security.md)      | Security-relevant changes or new validations       |
| [rules/testing.md](rules/testing.md)        | New test files, patterns, or framework changes     |

## Tasks

See [.agent/TASKS.md](../.agent/TASKS.md) for the project backlog and task details.
