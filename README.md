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

**Consensus works end to end; networking is not yet hardened.** Nodes start, restart, mine PoW blocks (`--mine`), stake PoS blocks after block 100 (`--stake`), verify signatures, and validate every block (new, synced, or loaded from disk) against the UTXO set. `npm run smoke` covers two real nodes; the PoW→PoS transition is covered by integration tests with a shortened PoW phase. With default settings a fresh chain pauses after block 100 until its first coinbases are 8 hours old (`STAKE_MIN_AGE`). Still open:

- a node that misses a block only resyncs when it reconnects, and forks are resolved by swapping whole chains (TASK-0012, TASK-0013);
- no API or CLI yet to send coins or inspect the chain (TASK-0016, TASK-0017).

The feature list below describes the intended design. See the [assessment](tasks/assessment-2026-11-23.md) for what is actually enforced today, and the [backlog](tasks/BACKLOG.md) for the order of fixes.

---

## Quick Start

```
1. Install dependencies:     npm install
2. Start a node:             npm run dev
3. Start a second node:      P2P_PORT=5002 npm run dev -- --data-dir ./data/node2 --peers ws://localhost:5001
4. Start a mining node:      npm run dev -- --mine
5. Run tests:                npm test
6. Run the smoke check:      npm run smoke
7. Build for production:     npm run build
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
| **Digital Signatures**   | secp256k1 ECDSA per input (low-S), txid excludes signatures      |
| **Integer Amounts**      | `bigint` base units, 1 coin = 100,000,000 (`COIN`)               |
| **Wallet System**        | Key generation, Base58Check encoding, protobuf persistence       |
| **Worker Mining**        | Non-blocking PoW mining using Node.js worker threads             |
| **Staking**              | Kernel PoS: any mature UTXO can stake; PoS blocks signed by the staker; fixed 10-coin reward |
| **Difficulty Adjustment**| Per-block retarget toward 30 s spacing, separate for PoW and PoS |
| **Block Header**         | Merkle root of full transactions, compact target (`bits`), sha256d |
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
│   ├── StakingService.ts     # PoS staking loop (--stake)
│   ├── miningWorker.cjs      # Worker thread for CPU-intensive hashing
│   └── __tests__/            # Unit tests
├── networking/
│   ├── P2PServer.ts          # WebSocket P2P server and message routing
│   └── __tests__/            # Unit tests
├── config.ts                 # All configuration constants
├── index.ts                  # Main entry point
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
| **Miner**          | `Miner.ts`            | In-node PoW mining in a worker thread (`--mine`)     |
| **StakingService** | `StakingService.ts`   | In-node PoS staking, one attempt per 16 s slot (`--stake`) |
| **StakingService** | `StakingService.ts`   | Periodic PoS block generation                        |
| **P2P Server**     | `P2PServer.ts`        | WebSocket networking, message routing, sync          |

---

## Configuration

Key constants in `src/config.ts`:

| Setting                         | Default | Description                                    |
| ------------------------------- | ------- | ---------------------------------------------- |
| `P2P_PORT`                      | 5001    | WebSocket P2P port (env: `P2P_PORT`)           |
| `POW_CUTOFF_BLOCK`              | 100     | Last PoW height; PoS from the next block       |
| `STAKE_MIN_AGE`                 | 8 h     | Age a UTXO needs before it can stake           |
| `STAKE_MIN_CONFIRMATIONS`       | 10      | Confirmations a UTXO needs before it can stake |
| `STAKE_TIMESTAMP_GRANULARITY`   | 16 s    | PoS block timestamps are multiples of this     |
| `COIN`                          | 10^8    | Base units per coin (amounts are `bigint`)     |
| `POW_BLOCK_REWARD`              | 10 coins | Mining reward per block (PoW)                 |
| `POS_BLOCK_REWARD`              | 10 coins | Staking reward per block (PoS)                |
| `COIN_MATURITY`                 | 10      | Blocks before coinbase/coinstake outputs are spendable |
| `BLOCK_TIME`                    | 30      | Target seconds between blocks                  |
| `RETARGET_WINDOW`               | 16      | Smoothing N of the per-block retarget          |
| `MAX_RETARGET_SPACING`          | 300 s   | Longer gaps count as this much in the retarget |
| `POW_LIMIT`                     | 2^240−1 | Easiest PoW target (~65k hashes per block)     |
| `POS_LIMIT`                     | 2^236−1 | Easiest PoS target                             |
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

### Step 3: Mine Blocks

Start a node with `--mine` to mine PoW blocks inside the node. Rewards go to the node's wallet, and mined blocks are broadcast to connected peers:

```bash
npm run dev -- --mine
```

The target is retargeted every block toward one block per `BLOCK_TIME` (30 s): a new chain mines its first blocks quickly until the target catches up with the miner's hash rate. Mining stops after the PoW phase (`POW_CUTOFF_BLOCK`).

After block 100 blocks are proof of stake. Start a node with `--stake` to stake with its wallet: every 16-second slot it checks whether one of its outputs (at least 10 confirmations and 8 hours old) has a kernel that meets the target, and if so signs and broadcasts a PoS block paying the fixed 10-coin reward to the wallet:

```bash
npm run dev -- --stake
```

### Step 4: Verify

```bash
npm test                # Run test suite
npm run smoke           # Real nodes: mine, sync, relay, restart (~10 s)
npm run build           # Compile TypeScript
```

---

## Usage Example

```typescript
import { Blockchain } from './blockchain/Blockchain.js';
import { Wallet } from './blockchain/Wallet.js';
import { COIN } from './config.js';

// Create a blockchain and wallet
const blockchain = new Blockchain();
const wallet = new Wallet();

// Create a transaction (UTXO model; amounts are bigint base units)
const tx = blockchain.createTransaction(fromAddress, toAddress, 5n * COIN, wallet);
await blockchain.addTransaction(tx);

// Mine pending transactions (PoW phase)
await blockchain.minePendingTransactions(wallet.address);

// Check balance (UTXO-based, bigint base units)
const balance = blockchain.getBalance(wallet.address);

```

---

## P2P Message Protocol

| Message              | Direction  | Purpose                      |
| -------------------- | ---------- | ---------------------------- |
| `CHAIN`              | Broadcast  | Full chain synchronization   |
| `BLOCK`              | Broadcast  | New block announcement       |
| `TRANSACTION`        | Broadcast  | Transaction broadcast        |
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
| Mining node       | `npm start -- --mine`                                         |
| Staking node      | `npm start -- --stake`                                        |
| Run tests         | `npm test`                                                    |
| Smoke check       | `npm run smoke`                                               |
| Build             | `npm run build`                                               |
| Lint              | `npm run lint`                                                |
| Lint + fix        | `npm run lint:fix`                                            |
| Start 2nd node    | `P2P_PORT=5002 npm run dev -- --data-dir ./data/node2 --peers ws://localhost:5001` |

---

## Troubleshooting

### `invalid stored chain: genesis block hash mismatch` on Start

Block and transaction formats change while the project is pre-release, and each change creates a new genesis block. Data written by an older version won't load. Delete the data directory (or point `--data-dir` somewhere new) and start again.

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
