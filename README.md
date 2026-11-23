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

**Works end to end on a local network of nodes.** Nodes mine PoW blocks (`--mine`), stake PoS blocks after block 100 (`--stake`), verify signatures, validate every block against the UTXO set, sync and relay over a handshake-based protocol, and resolve forks by chain work. `npm run e2e` runs three real nodes on the regression-test network (`--regtest`: 20 PoW blocks, no minimum stake age) through payment, PoW→PoS, a partition with a reorg, and a restart. With default settings a fresh chain pauses after block 100 until its first coinbases are 8 hours old (`STAKE_MIN_AGE`). Still open:

- no way yet to send coins from a node's wallet (TASK-0017). The [HTTP API](#http-api) is read-only.

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
   End-to-end scenario:      npm run e2e
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
| **Fork Resolution**      | Block tree; the branch with the most work wins; reorgs with undo data |
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
│   ├── Block.ts              # Block header (merkle root, bits), hashing, JSON wire form
│   ├── Blockchain.ts         # Block tree, fork choice, reorgs, validation (_connectBlock), mempool
│   ├── BlockStore.ts         # Append-only chunked block storage with protobuf index
│   ├── Transaction.ts        # Transaction format, txid/witness hash, signing, verification
│   ├── UtxoSet.ts            # Unspent outputs by outpoint, per-address index
│   ├── Wallet.ts             # Key management, persistence
│   ├── address.ts            # Base58Check addresses
│   ├── kernel.ts             # PoS kernel hash, kernel target, stake modifier
│   ├── retarget.ts           # Per-block retarget (PoW and PoS)
│   ├── target.ts             # Compact targets (bits), block work
│   ├── protoSchemas.ts       # Protobuf schemas for blocks, index, wallet
│   ├── secp256k1.ts          # ESM/CommonJS-safe secp256k1 import
│   ├── Miner.ts              # In-node PoW miner (--mine)
│   ├── StakingService.ts     # In-node staking loop (--stake)
│   ├── miningWorker.cjs      # Worker thread for PoW hashing
│   └── __tests__/            # Unit tests
├── networking/
│   ├── P2PServer.ts          # Handshake, block sync, relay, peer discovery
│   └── __tests__/            # Unit tests
├── api/
│   └── ApiServer.ts          # Read-only HTTP API (loopback by default)
├── __tests__/integration/    # Real-filesystem / real-WebSocket integration tests
├── config.ts                 # All configuration constants
├── index.ts                  # Node entry point
├── smoke.ts                  # npm run smoke: two real nodes
├── e2e.ts                    # npm run e2e: three regtest nodes, partition, reorg
└── nodeHarness.ts            # Helpers for driving node processes
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
| **P2P Server**     | `P2PServer.ts`        | WebSocket networking, message routing, sync          |
| **API Server**     | `ApiServer.ts`        | Read-only HTTP API over chain state, mempool, peers  |

---

## Configuration

Key constants in `src/config.ts`:

| Setting                         | Default | Description                                    |
| ------------------------------- | ------- | ---------------------------------------------- |
| `P2P_PORT`                      | 5001    | WebSocket P2P port (env: `P2P_PORT`)           |
| `API_PORT`                      | P2P port + 1000 | HTTP API port (env: `API_PORT`; `0` picks a free port) |
| `API_HOST`                      | 127.0.0.1 | HTTP API bind address (env: `API_HOST`)      |
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
npm run check           # Build, test suite and lint
npm run smoke           # Real nodes: mine, sync, relay, restart (~10 s)
npm run e2e             # 3 regtest nodes: pay, PoW→PoS, partition + reorg, restart (~2 min)
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

## HTTP API

Every node serves a read-only JSON API, on `127.0.0.1` at the P2P port + 1000 (6001 by default, 6002 for a node with `P2P_PORT=5002`). Set `API_HOST` to expose it on other interfaces; it has no authentication. Amounts are decimal strings in base units (`COIN` = 10^8).

| Endpoint | Returns |
| -------- | ------- |
| `GET /status` | Network id, height, tip hash, chain work, phase (`pow`/`pos`), median time past, mempool size, peer count |
| `GET /blocks/:heightOrHash` | The block (header, signature, transactions), whether it is on the active chain, confirmations. Side-branch blocks are found by hash |
| `GET /transactions/:txid` | The transaction plus its block hash, height and confirmations; `block: null` while in the mempool. Scans the chain (no transaction index yet) |
| `GET /addresses/:address` | Balance, spendable balance (mature and not claimed by the mempool), number of outputs |
| `GET /addresses/:address/utxos` | Each unspent output: txid, index, amount, height, confirmations, coinbase/coinstake, spendable |
| `GET /mempool` | Pending txids |
| `GET /peers` | Connected peers that completed the handshake: address, direction, height at handshake |

```bash
curl -s localhost:6001/status
curl -s localhost:6001/blocks/1
```

Malformed parameters return 400, unknown items 404 and other methods 405, each with an `error` field.

---

## P2P Message Protocol

JSON over WebSocket. Every connection starts with a handshake; other messages are ignored until it completes.

| Message       | Direction | Purpose |
| ------------- | --------- | ------- |
| `VERSION`     | Both, first | Network id, protocol version, genesis hash, height, tip, node nonce, listen port. Mismatches (or our own nonce) close the connection |
| `VERACK`      | Reply     | Acknowledges a valid `VERSION`; the peer is ready after both |
| `GET_BLOCKS`  | Request   | Block locator (tip-dense, then exponentially sparse hashes) |
| `BLOCKS`      | Reply     | Up to 200 blocks after the highest common block, plus `more` |
| `BLOCK`       | Broadcast | New or newly synced tip block; relayed once accepted, never back to the sender. An unknown parent triggers `GET_BLOCKS` to that peer |
| `TRANSACTION` | Broadcast | New transaction; relayed once accepted to the mempool, never back to the sender |
| `PEERS`       | Broadcast | Known peer addresses (discovery) |

---

## Development

### Workflow

```
1. Create a branch:    git checkout -b feature/<name>
2. Make changes
3. Check:              npm run check   (build, test, lint; npm run lint:fix for fixable issues)
4. Real runtime:       npm run smoke   (and npm run e2e for consensus, P2P or staking)
5. Commit and push
6. Create PR:          gh pr create --title "..." --body "..."
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
| End-to-end        | `npm run e2e`                                                 |
| Regtest node      | `npm start -- --regtest --data-dir <dir> --mine --stake`      |
| Build             | `npm run build`                                               |
| Build, test, lint | `npm run check`                                               |
| Lint              | `npm run lint`                                                |
| Lint + fix        | `npm run lint:fix`                                            |
| Start 2nd node    | `P2P_PORT=5002 npm run dev -- --data-dir ./data/node2 --peers ws://localhost:5001` |
| Node status       | `curl -s localhost:6001/status`                               |

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

If only the API port (P2P port + 1000) is taken, the node keeps running without the API and logs `[API] could not listen on ...`. Set `API_PORT` to another port.

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
- Run `npm run check` before committing
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
