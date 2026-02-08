# Blockchain TypeScript

> A TypeScript blockchain implementation featuring hybrid PoW/PoS consensus, UTXO-based transactions, P2P networking, and wallet management.

---

## Contents

| Resource                       | Purpose                                   |
| ------------------------------ | ----------------------------------------- |
| [.claude/CLAUDE.md](.claude/CLAUDE.md) | Project instructions and conventions |
| [.agent/TASKS.md](.agent/TASKS.md) | Project backlog with detailed task files |
| [src/](src/)                   | TypeScript source code                    |
| [data/](data/)                 | Runtime data (chain, wallet, peers)       |

---

## Quick Start

```
1. Install dependencies:     npm install
2. Start a node:             npm run dev
3. Start a second node:      P2P_PORT=5002 PEERS=ws://localhost:5001 npm run dev
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

| Feature                | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| **Hybrid Consensus**   | Proof of Work transitions to Proof of Stake at block 100        |
| **UTXO Model**         | Unspent Transaction Output tracking with double-spend prevention |
| **P2P Networking**     | WebSocket-based peer communication with chain synchronization   |
| **Digital Signatures** | secp256k1 elliptic curve cryptography for transaction signing   |
| **Wallet System**      | Key generation, Base58Check address encoding, persistent storage |
| **Worker Mining**      | Non-blocking PoW mining using Node.js worker threads            |
| **Staking**            | Stake registration, weight calculation, PoS block generation    |
| **Persistence**        | Chain state, wallet, and peer data persisted to JSON files      |

---

## Architecture

```
src/
├── blockchain/
│   ├── Block.ts            # Block structure with PoW/PoS support
│   ├── Blockchain.ts       # Chain management, UTXO tracking, consensus
│   ├── Transaction.ts      # Transaction inputs/outputs, signing, verification
│   ├── Wallet.ts           # Key generation, address encoding, persistence
│   ├── Miner.ts            # Worker thread PoW mining
│   ├── StakingService.ts   # Periodic PoS block generation
│   └── miningWorker.cjs    # Hash computation worker thread
├── networking/
│   └── P2PServer.ts        # WebSocket P2P server and message routing
├── config.ts               # Configuration constants
├── index.ts                # Main entry point
├── mine.ts                 # Standalone miner entry point
└── test-consensus.ts       # Consensus transition demo
```

### Components

| Component          | File                  | Responsibility                                       |
| ------------------ | --------------------- | ---------------------------------------------------- |
| **Block**          | `Block.ts`            | Block structure, hash calculation, PoW/PoS detection |
| **Blockchain**     | `Blockchain.ts`       | Chain management, UTXO tracking, consensus, mining   |
| **Transaction**    | `Transaction.ts`      | Inputs/outputs, signing, verification                |
| **Wallet**         | `Wallet.ts`           | Key generation, address encoding, persistence        |
| **Miner**          | `Miner.ts`            | Worker thread PoW mining, job management             |
| **StakingService** | `StakingService.ts`   | Periodic PoS block generation                        |
| **P2P Server**     | `P2PServer.ts`        | WebSocket networking, message routing, sync          |

---

## Configuration

Key constants in `src/config.ts`:

| Setting              | Default | Description                                  |
| -------------------- | ------- | -------------------------------------------- |
| `P2P_PORT`           | 5001    | WebSocket P2P port (env: `P2P_PORT`)         |
| `POW_CUTOFF_BLOCK`   | 100     | Block height where PoW ends                  |
| `POS_START_BLOCK`    | 90      | Block height where PoS preparation begins    |
| `MIXED_MODE_START`   | 80      | Block height where mixed PoW/PoS begins      |
| `POW_BLOCK_REWARD`   | 10      | Mining reward per block (PoW)                |
| `POS_BLOCK_REWARD`   | 10      | Staking reward per block (PoS)               |
| `COIN_MATURITY`      | 10      | Blocks before coins are spendable            |

### Data Files

Runtime data is stored in `./data/` (configurable via `--data-dir`):

| File                    | Content                              |
| ----------------------- | ------------------------------------ |
| `blockchain_data.json`  | Persisted chain state                |
| `wallet.json`           | Wallet keys and transaction history  |
| `peers.json`            | Known peer addresses                 |

---

## Running the Blockchain

### Step 1: Start a Node

```bash
npm run dev
```

### Step 2: Start Additional Nodes (P2P)

Each node needs a unique P2P port and at least one peer to connect to:

```bash
P2P_PORT=5002 PEERS=ws://localhost:5001 npm run dev
P2P_PORT=5003 PEERS=ws://localhost:5001,ws://localhost:5002 npm run dev
```

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
import { Transaction } from './blockchain/Transaction.js';
import { Wallet } from './blockchain/Wallet.js';

// Create a blockchain and wallet
const blockchain = new Blockchain();
const wallet = new Wallet();

// Create and sign a transaction
const tx = new Transaction(fromAddress, toAddress, amount);
tx.signTransaction(wallet.privateKey);
blockchain.addTransaction(tx);

// Mine pending transactions
blockchain.minePendingTransactions(wallet.address);

// Check balance
const balance = blockchain.getBalance(wallet.address);
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
| Start 2nd node    | `P2P_PORT=5002 PEERS=ws://localhost:5001 npm run dev`         |

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
- Check the `PEERS` environment variable format: `ws://host:port`
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
- Commit secrets, private keys, or wallet files
- Mix unrelated changes in one PR

---

## Project Tasks

See [.agent/TASKS.md](.agent/TASKS.md) for the full project backlog organized by phase, with dependency graphs and guardrails.

---

## License

CC0-1.0 - See the LICENSE file for details.
