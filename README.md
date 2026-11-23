# Blockchain TypeScript

> A TypeScript blockchain implementation featuring hybrid PoW/PoS consensus, UTXO-based transactions, P2P networking, and wallet management.

---

## Contents

| Resource                                                     | Purpose                                     |
| ------------------------------------------------------------ | ------------------------------------------- |
| [AGENTS.md](AGENTS.md)                                       | Instructions for coding agents              |
| [tasks/BACKLOG.md](tasks/BACKLOG.md)                         | Prioritized backlog (`TASK-####`)           |
| [tasks/assessment-2026-11-23.md](tasks/assessment-2026-11-23.md) | Latest project assessment with evidence |
| [src/](src/)                                                 | TypeScript source code                      |

---

## Status

**Not functional end to end yet (assessed 2026-11-23).** The build and unit tests pass, but:

- the node crashes on first start and on restart (fixes: TASK-0001);
- nothing produces blocks the node accepts (TASK-0004);
- signatures are not verified, and block transactions are not checked against the UTXO set (TASK-0005, TASK-0006);
- stake state is node-local, so nodes disagree after restarts (TASK-0009, TASK-0011).

The feature list below describes the intended design. See the [assessment](tasks/assessment-2026-11-23.md) for what is actually enforced today, and the [backlog](tasks/BACKLOG.md) for the order of fixes.

---

## Quick Start

```
1. Install dependencies:     npm install
2. Start a node:             npm run dev
3. Start a second node:      P2P_PORT=5002 npm run dev -- --data-dir ./data/node2 --peers ws://localhost:5001
4. Run the miner:            npm run mine
5. Run tests:                npm test
6. Build for production:     npm run build
```

---

## Prerequisites

### Required Tools

| Tool         | Version | Purpose              | Install              |
| ------------ | ------- | -------------------- | -------------------- |
| **Node.js**  | 18+     | Runtime environment  | `brew install node`  |
| **npm**      | 9+      | Package manager      | Included with Node   |
| **Git**      | 2.30+   | Version control      | `brew install git`   |

### Verify Setup

```bash
node --version         # Should be 18+
npm --version          # Should be 9+
git --version          # Should be 2.30+
```

---

## Features

| Feature                  | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| **Hybrid Consensus**     | PoW transitions to PoS at block 100 with difficulty adjustment    |
| **UTXO Model**           | Unspent Transaction Output tracking with double-spend prevention  |
| **Coinbase Maturity**    | Coinbase outputs require 10 confirmations before spending         |
| **P2P Networking**       | WebSocket-based peer communication with chain synchronization     |
| **Fork Resolution**      | Chain weight comparison for fork selection (not longest chain)    |
| **Digital Signatures**   | secp256k1 ECDSA for transaction signing and verification         |
| **Wallet System**        | Key generation, Base58Check encoding, protobuf persistence       |
| **Worker Mining**        | Non-blocking PoW mining using Node.js worker threads             |
| **Staking**              | Stake-weighted validator lottery, age multiplier, coinstake txs  |
| **Stake Security**       | Delayed unstaking, double-sign slashing, age-capped weight      |
| **Difficulty Adjustment**| Proportional adjustment every 10 blocks (clamped 4x max change) |
| **Persistence**          | Chunked block storage with protobuf index, wallet as protobuf   |

---

## Architecture

```
src/
├── blockchain/
│   ├── Block.ts              # Block structure, hashing, PoW/PoS detection
│   ├── Blockchain.ts         # Chain management, UTXO set, validation, staking
│   ├── BlockStore.ts         # Chunked block storage with protobuf index
│   ├── Transaction.ts        # Transaction model, signing, verification
│   ├── Wallet.ts             # Key management, address encoding, persistence
│   ├── Miner.ts              # PoW mining via worker threads
│   ├── StakingService.ts     # Periodic PoS block generation
│   ├── miningWorker.cjs      # Worker thread for CPU-intensive hashing
│   └── __tests__/            # Unit tests
├── networking/
│   ├── P2PServer.ts          # WebSocket P2P server and message routing
│   └── __tests__/            # Unit tests
├── config.ts                 # All configuration constants
├── index.ts                  # Main entry point
├── mine.ts                   # Standalone miner entry point
└── test-consensus.ts         # Consensus transition demo
```

### Components

| Component          | File                  | Responsibility                                       |
| ------------------ | --------------------- | ---------------------------------------------------- |
| **Block**          | `Block.ts`            | Block structure, hash calculation, PoW/PoS detection |
| **Blockchain**     | `Blockchain.ts`       | Chain management, UTXO set, consensus, staking       |
| **BlockStore**     | `BlockStore.ts`       | Chunked block persistence with protobuf index        |
| **Transaction**    | `Transaction.ts`      | Inputs/outputs, signing, ECDSA verification          |
| **Wallet**         | `Wallet.ts`           | Key management, address encoding, protobuf storage   |
| **Miner**          | `Miner.ts`            | Worker thread PoW mining, job management             |
| **StakingService** | `StakingService.ts`   | Periodic PoS block generation                        |
| **P2P Server**     | `P2PServer.ts`        | WebSocket networking, message routing, sync          |

---

## Configuration

Key constants in `src/config.ts`:

| Setting                         | Default | Description                                    |
| ------------------------------- | ------- | ---------------------------------------------- |
| `P2P_PORT`                      | 5001    | WebSocket P2P port (env: `P2P_PORT`)           |
| `POW_CUTOFF_BLOCK`              | 100     | Block height where PoW ends and PoS begins     |
| `POW_BLOCK_REWARD`              | 10      | Mining reward per block (PoW)                  |
| `POS_BLOCK_REWARD`              | 10      | Staking reward per block (PoS)                 |
| `COIN_MATURITY`                 | 10      | Blocks before coinbase outputs are spendable   |
| `BLOCK_TIME`                    | 30      | Target seconds between blocks                  |
| `DIFFICULTY_ADJUSTMENT_INTERVAL`| 10      | Blocks between difficulty recalculations       |
| `MIN_DIFFICULTY`                | 4       | Minimum PoW difficulty                         |
| `MAX_DIFFICULTY_CHANGE_FACTOR`  | 4       | Max 4x change per difficulty adjustment        |
| `UNSTAKE_DELAY`                 | 100     | Blocks before unstaked funds are released       |
| `MAX_STAKE_AGE_MULTIPLIER`      | 4       | Maximum age multiplier for stake weight        |
| `MAX_BLOCK_FILE_SIZE`           | 128 MB  | Max size per chunked block data file           |
| `MAX_WALLET_BACKUPS`            | 3       | Maximum wallet backup files to keep            |

### Data Files

Runtime data stored in a platform-specific directory (configurable via `--data-dir`):
- **macOS:** `~/Library/Application Support/blockchain-ts/`
- **Linux:** `~/.blockchain-ts/`
- **Windows:** `%APPDATA%/blockchain-ts/`

| File                    | Content                                    |
| ----------------------- | ------------------------------------------ |
| `blocks/blk*.dat`       | Chunked block data files (append-only)     |
| `blocks/index.dat`      | Block index (hash/height → file + offset)  |
| `wallet.dat`            | Wallet keys and address (protobuf)         |
| `peers.json`            | Known peer addresses                       |

---

## Running the Blockchain

### Step 1: Start a Node

```bash
npm run dev
```

### Step 2: Start Additional Nodes (P2P)

Each node needs a unique P2P port, its own data directory, and at least one peer to connect to:

```bash
P2P_PORT=5002 npm run dev -- --data-dir ./data/node2 --peers ws://localhost:5001
P2P_PORT=5003 npm run dev -- --data-dir ./data/node3 --peers ws://localhost:5001,ws://localhost:5002
```

Peers can also come from the `SEED_NODES` env var (comma-separated) or from `peers.json` in the data directory.

### Step 3: Run the Miner

The standalone miner connects to a running node via WebSocket:

```bash
npm run mine
```

### Step 4: Verify

```bash
npm test                # Run test suite
npm run build           # Compile TypeScript
```

---

## Usage Example

```typescript
import { Blockchain } from './blockchain/Blockchain.js';
import { Wallet } from './blockchain/Wallet.js';

// Create a blockchain and wallet
const blockchain = new Blockchain();
const wallet = new Wallet();

// Create a transaction (uses UTXO model internally)
const tx = blockchain.createTransaction(fromAddress, toAddress, amount, wallet);
await blockchain.addTransaction(tx);

// Mine pending transactions (PoW phase)
await blockchain.minePendingTransactions(wallet.address, wallet);

// Check balance (UTXO-based)
const balance = blockchain.getBalance(wallet.address);

// Stake coins (PoS phase)
await blockchain.stake(wallet.address, 50, wallet);
```

---

## P2P Message Protocol

| Message              | Direction  | Purpose                      |
| -------------------- | ---------- | ---------------------------- |
| `CHAIN`              | Broadcast  | Full chain synchronization   |
| `BLOCK`              | Broadcast  | New block announcement       |
| `TRANSACTION`        | Broadcast  | Transaction broadcast        |
| `STAKE`              | Broadcast  | Stake registration           |
| `UNSTAKE`            | Broadcast  | Stake withdrawal             |
| `GET_LATEST_BLOCK`   | Request    | Request latest block         |
| `LATEST_BLOCK`       | Response   | Latest block response        |

---

## Development

### Workflow

```
1. Create a branch:    git checkout -b feature/<name>
2. Make changes
3. Run tests:          npm test
4. Lint code:          npm run lint:fix
5. Build:              npm run build
6. Commit and push
7. Create PR:          gh pr create --title "..." --body "..."
```

### Quick Reference

| Action            | Command                                                       |
| ----------------- | ------------------------------------------------------------- |
| Dev mode (watch)  | `npm run dev`                                                 |
| Run node          | `npm start`                                                   |
| Run miner         | `npm run mine`                                                |
| Run tests         | `npm test`                                                    |
| Build             | `npm run build`                                               |
| Lint              | `npm run lint`                                                |
| Lint + fix        | `npm run lint:fix`                                            |
| Start 2nd node    | `P2P_PORT=5002 npm run dev -- --data-dir ./data/node2 --peers ws://localhost:5001` |

---

## Troubleshooting

### Port Already in Use

```bash
# Find and kill the process using the port
lsof -i :5001
kill -9 <PID>
```

### Node Can't Connect to Peers

- Verify the peer node is running
- Check the `--peers` argument format: `ws://host:port`, comma-separated
- Ensure firewall allows WebSocket connections

### Tests Failing

```bash
npm test -- --verbose    # Run with detailed output
npm test -- --watch      # Run in watch mode for debugging
```

### Build Errors

```bash
npm run build 2>&1 | head -30    # Check first errors
npm run lint                      # Check for code issues
```

---

## Best Practices

**Do:**
- Keep PRs small and focused
- Run `npm test` and `npm run build` before committing
- Use feature branches, never commit directly to main
- Write tests for new functionality

**Don't:**
- Skip verification steps
- Merge with failing tests
- Commit secrets, private keys, or wallet files (`data/` is gitignored)
- Mix unrelated changes in one PR

---

## Project Tasks

See [tasks/BACKLOG.md](tasks/BACKLOG.md) for the prioritized backlog, grouped into milestones that each end in something runnable. Evidence for each task is in the [assessment](tasks/assessment-2026-11-23.md).

---

## License

CC0-1.0 - See the LICENSE file for details.
