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
├── blockchain_data.json      #   Persisted chain
├── wallet.json               #   Wallet keys and address
└── peers.json                #   Known peer addresses
```

## Architecture

The system is a single-process blockchain node with optional external miner. `Blockchain` is the central class managing chain state, UTXO tracking, pending transactions, and staking. `P2PServer` handles peer-to-peer WebSocket communication for chain sync, block/transaction broadcasting, and stake propagation. Mining uses `worker_threads` to offload PoW computation. The consensus transitions from PoW to PoS at block 100 (`POW_CUTOFF_BLOCK`).

## Key Decisions

- **UTXO model** — Transactions use unspent transaction outputs, not account balances
- **Hybrid PoW/PoS** — First 100 blocks are PoW, then transitions to PoS
- **Worker threads for mining** — `miningWorker.cjs` is CommonJS because `worker_threads` requires it
- **ES modules** — Project uses `"type": "module"` with explicit `.js` extensions in imports
- **Single config file** — All constants in `src/config.ts`, environment variables for ports/peers only
- **JSON persistence** — Chain and wallet stored as JSON in `data/` directory
- **Mutex for concurrency** — `async-mutex` protects chain replacement; other shared state needs protection (see tasks)

## Rules

Detailed conventions are in `.claude/rules/`:

| File                                       | Covers                                   |
| ------------------------------------------ | ---------------------------------------- |
| [rules/project.md](rules/project.md)      | Project structure and architecture        |
| [rules/code-style.md](rules/code-style.md)| Code style and formatting                 |
| [rules/testing.md](rules/testing.md)      | Testing conventions and requirements      |
| [rules/security.md](rules/security.md)    | Security requirements and practices       |

## Tasks

See [.agent/TASKS.md](../.agent/TASKS.md) for the project backlog and task details.
