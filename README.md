# Blockchain TypeScript

[![check](https://github.com/jeroenvanwissen/blockchain-ts/actions/workflows/check.yml/badge.svg)](https://github.com/jeroenvanwissen/blockchain-ts/actions/workflows/check.yml)

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

**Works end to end on a local network of nodes.** Nodes mine PoW blocks (`--mine`), stake PoS blocks after block 1200 (`--stake`), verify signatures, validate every block against the UTXO set, sync and relay over a handshake-based protocol, and resolve forks by chain work. `npm run e2e` runs three real nodes on the regression-test network (`--regtest`: 20 PoW blocks, no minimum stake age) through payment, PoW→PoS, a partition with a reorg, and a restart. With default settings the PoW phase lasts about 10 hours, longer than the 8-hour stake age (`STAKE_MIN_AGE`), so staking takes over from mining without a pause.

Send coins from a node's wallet with the [CLI](#sending-coins) or the [HTTP API](#http-api), with fees going to block producers. The wallet hands out [as many addresses](#wallet-addresses) as you need from one seed, lists its [transaction history](#wallet-history), can be [encrypted](#wallet-encryption), and is backed up as a [24-word seed phrase](#seed-phrase-backup). Every task in the [backlog](tasks/BACKLOG.md) is done. The [assessment](tasks/assessment-2026-11-23.md) records the findings it started from, and each task file records what changed.

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
8. Or run it in Docker:      docker compose up -d   (see Running in Docker)
```

---

## Prerequisites

### Required Tools

| Tool         | Version | Purpose              | Install              |
| ------------ | ------- | -------------------- | -------------------- |
| **Node.js**  | 22.13+ or 24+ | Runtime environment (CI tests 22 and 26); the chain database uses its built-in SQLite (`node:sqlite`), which Node 22 calls experimental and announces with one `ExperimentalWarning` at startup | `brew install node`  |
| **npm**      | 10+     | Package manager      | Included with Node   |
| **Git**      | 2.30+   | Version control      | `brew install git`   |

### Verify Setup

```bash
node --version         # Should be 22.13+ or 24+
npm --version          # Should be 10+
git --version          # Should be 2.30+
```

---

## Features

| Feature                  | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| **Hybrid Consensus**     | PoW transitions to PoS after block 1200 (about 10 hours)          |
| **UTXO Model**           | Unspent Transaction Output tracking with double-spend prevention  |
| **Coinbase Maturity**    | Coinbase outputs require 10 confirmations before spending         |
| **P2P Networking**       | WebSocket-based peer communication with chain synchronization     |
| **Fork Resolution**      | Block tree; the branch with the most work wins (equal work: a tie-break block contents can't influence); reorgs with undo data |
| **Digital Signatures**   | secp256k1 ECDSA per input (low-S), txid excludes signatures      |
| **Integer Amounts**      | `bigint` base units, 1 coin = 100,000,000 (`COIN`)               |
| **Wallet System**        | HD wallet (BIP32): any number of addresses from one seed, a BIP39 seed phrase for backup and restore, Base58Check, protobuf persistence |
| **Worker Mining**        | Non-blocking PoW mining using Node.js worker threads             |
| **Staking**              | Kernel PoS: any mature UTXO can stake; PoS blocks signed by the staker; fixed 10-coin reward |
| **Difficulty Adjustment**| Per-block retarget toward 30 s spacing, separate for PoW and PoS |
| **Block Header**         | Merkle root of full transactions, compact target (`bits`), sha256d |
| **Persistence**          | Append-only block files and block index, wallet as protobuf     |

---

## Architecture

```
src/
├── blockchain/
│   ├── Block.ts              # Block header (merkle root, bits), hashing, JSON wire form
│   ├── Blockchain.ts         # Block tree, fork choice, reorgs, validation (_connectBlock), mempool
│   ├── BlockStore.ts         # Append-only block files and block index
│   ├── Transaction.ts        # Transaction format, txid/witness hash, signing, verification
│   ├── UtxoSet.ts            # Unspent outputs by outpoint, per-address index
│   ├── Wallet.ts             # HD keys, addresses, encryption, persistence (keys only)
│   ├── hd.ts                 # BIP32 key derivation
│   ├── amount.ts             # Coin amounts: parse "1.5", format base units
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
│   ├── ApiServer.ts          # HTTP API: chain queries, token-protected wallet routes, explorer
│   ├── cookie.ts             # api.cookie token file
│   └── explorer/             # Block explorer page (HTML, CSS, browser JS; copied to dist/ by the build)
├── __tests__/integration/    # Real-filesystem / real-WebSocket integration tests
├── config.ts                 # All configuration constants
├── index.ts                  # Node entry point
├── cli.ts                    # npm run cli: status, balance, addresses, history, send via the API
├── smoke.ts                  # npm run smoke: two real nodes
├── e2e.ts                    # npm run e2e: three regtest nodes, partition, reorg
├── scale.ts                  # npm run scale: costs as the chain grows
└── nodeHarness.ts            # Helpers for driving node processes
```

### Components

| Component          | File                  | Responsibility                                       |
| ------------------ | --------------------- | ---------------------------------------------------- |
| **Block**          | `Block.ts`            | Block structure, hash calculation, PoW/PoS detection |
| **Blockchain**     | `Blockchain.ts`       | Chain management, UTXO set, consensus, staking       |
| **BlockStore**     | `BlockStore.ts`       | Append-only block files and block index              |
| **Transaction**    | `Transaction.ts`      | Inputs/outputs, signing, ECDSA verification          |
| **Wallet**         | `Wallet.ts`           | HD keys and addresses, encryption, protobuf storage  |
| **Miner**          | `Miner.ts`            | In-node PoW mining in a worker thread (`--mine`)     |
| **StakingService** | `StakingService.ts`   | In-node PoS staking, one attempt per 16 s slot (`--stake`) |
| **P2P Server**     | `P2PServer.ts`        | WebSocket networking, message routing, sync          |
| **API Server**     | `ApiServer.ts`        | HTTP API over chain state, mempool, peers; wallet send; block explorer |

---

## Configuration

Key constants in `src/config.ts`:

| Setting                         | Default | Description                                    |
| ------------------------------- | ------- | ---------------------------------------------- |
| `P2P_PORT`                      | 5001    | WebSocket P2P port (env: `P2P_PORT`)           |
| `P2P_EXTERNAL_PORT`             | P2P port | The port peers should dial, when they reach the node under another one (env: `P2P_EXTERNAL_PORT`) |
| `SEED_NODES`                    | none    | Peers to dial at startup, comma-separated `ws://host:port` (env: `SEED_NODES`) |
| `DATA_DIR`                      | platform default | Data directory when `--data-dir` isn't given (env: `DATA_DIR`) |
| `API_PORT`                      | P2P port + 1000 | HTTP API port (env: `API_PORT`; `0` picks a free port) |
| `API_HOST`                      | 127.0.0.1 | HTTP API bind address (env: `API_HOST`)      |
| `LOG_LEVEL`                     | info    | Node log level: debug, info, warn or error (env: `LOG_LEVEL`) |
| `POW_CUTOFF_BLOCK`              | 1200    | Last PoW height; PoS from the next block       |
| `STAKE_MIN_AGE`                 | 8 h     | Age a UTXO needs before it can stake, counted from the block that created it |
| `STAKE_MIN_CONFIRMATIONS`       | 10      | Confirmations a UTXO needs before it can stake |
| `STAKE_TIMESTAMP_GRANULARITY`   | 16 s    | PoS block timestamps are multiples of this     |
| `COIN`                          | 10^8    | Base units per coin (amounts are `bigint`)     |
| `POW_BLOCK_REWARD`              | 10 coins | Mining reward per block (PoW)                 |
| `POS_BLOCK_REWARD`              | 10 coins | Staking reward per block (PoS)                |
| `COIN_MATURITY`                 | 10      | Blocks before coinbase/coinstake outputs are spendable |
| `MIN_RELAY_FEE_PER_KB`          | 0.0001 coin | Minimum fee per 1000 bytes the mempool accepts and the wallet pays |
| `MAX_BLOCK_SIZE`                | 1 MB    | Largest valid block (header, signature, transactions) |
| `MAX_BLOCK_TRANSACTIONS`        | 1000    | Most transactions per block, coinbase included |
| `MAX_MEMPOOL_BYTES`             | 8 MB    | Pending transactions beyond this evict the lowest fee rates |
| `MAX_INBOUND_PEERS` / `MAX_OUTBOUND_PEERS` | 32 / 8 | Connection caps; extra known peers wait for a free slot |
| `BAN_SCORE` / `BAN_DURATION`    | 100 / 24 h | Misbehavior points that get a peer banned, and for how long |
| `BLOCK_TIME`                    | 30      | Target seconds between blocks                  |
| `RETARGET_WINDOW`               | 16      | Smoothing N of the per-block retarget          |
| `MAX_RETARGET_SPACING`          | 300 s   | Longer gaps count as this much in the retarget |
| `POW_LIMIT`                     | 2^240−1 | Easiest PoW target (~65k hashes per block)     |
| `POS_LIMIT`                     | 2^236−1 | Easiest PoS target                             |
| `MAX_BLOCK_FILE_SIZE`           | 128 MB  | Max size per chunked block data file           |
| `MAX_WALLET_BACKUPS`            | 3       | Maximum wallet backup files to keep            |
| `WALLET_ADDRESS_LOOKAHEAD`      | 20      | Addresses watched past the last one handed out |
| `MAX_WALLET_ADDRESSES`          | 100,000 | Receiving addresses a wallet can hand out      |
| `WALLET_DISCOVERY_GAP`          | 100     | Unused addresses in a row a restored wallet looks past for ones in use |

### Data Files

Runtime data stored in a platform-specific directory (configurable via `--data-dir` or the `DATA_DIR` env var; the flag wins):
- **macOS:** `~/Library/Application Support/blockchain-ts/`
- **Linux:** `~/.blockchain-ts/`
- **Windows:** `%APPDATA%/blockchain-ts/`

| File                    | Content                                    |
| ----------------------- | ------------------------------------------ |
| `blocks/blk*.dat`       | Chunked block data files (append-only)     |
| `blocks/index.dat`      | Block index (hash/height → file + offset): one record appended per stored block; rebuilt from the `blk*.dat` files if it's missing or damaged |
| `blocks/chain.db`       | Chain database (SQLite, with `chain.db-wal` and `chain.db-shm` next to it): the block tree, and for the active chain the unspent outputs, undo data, stake modifiers, the transaction index and every address's history. Written as each block connects, so a start reads no blocks and validates only blocks stored after it; the node keeps block headers and the unspent outputs in memory and reads blocks from the block files when it needs them. Rebuilt from the block files with `--reindex`, or when it was built under other consensus rules or by another version |
| `blocks/mempool.json`   | Pending transactions, saved after each payment from the wallet and at shutdown; startup re-admits them and drops those that are no longer valid |
| `wallet.dat`            | Wallet seed (the entropy of its seed phrase), account public key and address count (protobuf, 0600; the seed encrypted once you run `cli encrypt-wallet`) |
| `api.cookie`            | Token for the API's wallet routes, rewritten at every start (0600) |
| `peers.json`            | Known peer addresses                       |
| `banned.json`           | Banned peers and when their bans expire    |

---

## Running the Blockchain

### Step 1: Start a Node

```bash
npm run dev
```

Stop it with Ctrl+C or SIGTERM (what systemd and Docker send). Either way it stops producing blocks, saves its pending transactions, closes its connections and then the chain database before exiting; a second signal exits at once.

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

After block 1200 (about 10 hours of mining) blocks are proof of stake. Start a node with `--stake` to stake with its wallet: every 16-second slot it checks whether one of its outputs (at least 10 confirmations and 8 hours old) has a kernel that meets the target, and if so signs and broadcasts a PoS block paying the fixed 10-coin reward to the address that staked. Outputs on any of the wallet's addresses can stake:

```bash
npm run dev -- --stake
```

Check on it with `npm run cli -- staking`: whether staking is enabled, how many outputs are eligible, the chance per slot of finding a kernel (with the expected wait), and the last block the wallet staked.

### Sending Coins

The CLI talks to a running node's API. `send` pays from the node's wallet (largest outputs first, from any of its addresses, change back to its primary address) plus the minimum relay fee for the transaction's size, admits the payment to the mempool, relays it, and prints the txid (the fee goes to stderr). The fee goes to whoever produces the block. Amounts are in coins with up to 8 decimals:

```bash
npm run cli -- status
npm run cli -- balance
npm run cli -- send <address> 1.5
npm run cli -- send <address1> 1 <address2> 2.25     # several recipients in one transaction
```

For another node, pass its data dir (for its `api.cookie`) and API URL: `npm run cli -- --data-dir ./data/node2 --api http://127.0.0.1:6002 balance`.

The node saves its pending transactions in `blocks/mempool.json` right after each payment from its wallet and again when it stops (Ctrl+C, SIGTERM, `docker stop`), so a payment that hasn't confirmed yet is pending again after a restart, even after a crash. Peers that connect later get it through the [`MEMPOOL` exchange](#p2p-message-protocol), so it confirms even if it was sent while the node had no peers. Transactions the node only relayed for others are saved at shutdown; after a crash, peers that still have them pass them on again.

### Wallet Addresses

The wallet is an HD wallet (BIP32): every address comes from one seed, at m/0'/0/i. Mining rewards and payment change go to its primary address; hand out a new address for each payer or purpose:

```bash
npm run cli -- new-address     # prints a new receiving address
npm run cli -- addresses       # addresses with their balances, primary first
npm run cli -- balance         # the primary address and the balance over all addresses
```

`new-address` needs no passphrase: the wallet keeps its account public key unencrypted, so a locked wallet can still hand out addresses. The wallet also watches the next 20 addresses after the last one it handed out (`WALLET_ADDRESS_LOOKAHEAD`), so a backup of `wallet.dat` still sees coins sent to up to 20 addresses created after it. Payments spend from any address and staking uses outputs on any address.

A wallet made by an older version has one key. It keeps that key as its primary address and gets a seed for further addresses: at the next start if unencrypted, or at the first `unlock` if encrypted (until then `new-address` asks you to unlock once).

### Wallet History

`history` lists the wallet's transactions over all its addresses, newest first, with pending ones on top. A payment that also sends change back to the wallet is one line, showing the net change:

```bash
npm run cli -- history                  # the newest 25
npm run cli -- history --limit 100      # up to 100
npm run cli -- history --before 24      # the page before position 24 (the command prints the next one)
```

```text
 height  time                 type               amount           balance  txid
     24  2026-11-24 09:24:00  self           -0.0000242             227.5  5b21…3c62  to 16TV…a6ib +1 more, fee 0.0000242
     24  2026-11-24 09:24:00  send          -12.5000377       227.5000242  f6d5…e21c  to 1BmH…Mdba, fee 0.0000377
     24  2026-11-24 09:24:00  stake                   0       240.0000619  8465…c60d  to 1Z4s…1YLn, immature
     24  2026-11-24 09:24:00  reward        +10.0000619       240.0000619  3fd9…8589  to 1Z4s…1YLn, immature
     20  2026-11-24 09:22:44  mined                 +10               200  9f66…00ca  to 1Z4s…1YLn, immature
```

The CLI prints full txids and addresses; they are shortened here. The amount is the change to the wallet's balance, fee included, and the balance is the wallet's balance after the transaction. The types are:

| Type      | Meaning |
| --------- | ------- |
| `receive` | Coins paid to one of the wallet's addresses |
| `send`    | A payment to someone else; the line shows the recipients and the fee |
| `self`    | A payment between the wallet's own addresses: only the fee leaves the wallet |
| `mined`   | The reward of a PoW block the wallet mined, plus its fees |
| `reward`  | The reward of a PoS block the wallet staked, plus its fees |
| `stake`   | The coinstake: the staked output goes back to its owner, so the change is 0 |

Mined and staked coins are marked `immature` until they can be spent (10 confirmations). `history` needs no passphrase: it reads only the chain and the wallet's addresses.

### Wallet Encryption

`wallet.dat` holds the seed unencrypted (mode 0600) until you encrypt it. Encryption uses a passphrase (scrypt, AES-256-GCM), deletes the old unencrypted backups, and locks the wallet:

```bash
npm run cli -- encrypt-wallet                    # asks for the passphrase twice
npm run cli -- unlock --staking-only             # stake, but no payments
npm run cli -- unlock --timeout 300              # full unlock for 5 minutes
npm run cli -- lock
npm run cli -- change-passphrase                 # re-encrypts; old backups are deleted
```

An encrypted wallet is locked whenever the node starts. While locked the node doesn't stake and `send` is refused; mining rewards still arrive. Without a terminal the CLI reads the passphrase from the first line of stdin. There's no passphrase recovery: losing the passphrase means restoring from the [seed phrase](#seed-phrase-backup).

### Seed Phrase Backup

A new wallet has a 24-word seed phrase (BIP39). Write it down and keep it offline: it recreates every address of the wallet on any node, and anyone who has it can spend the coins.

```bash
npm run cli -- seed-phrase                       # an encrypted wallet asks for its passphrase
npm run cli -- balance                           # "backup:" says whether the wallet has a phrase
```

`seed-phrase` prints the words numbered. An encrypted wallet asks for its passphrase every time, even while unlocked, and stays locked. The node never logs the phrase.

To restore, stop the node and run `restore-wallet` on its data dir. It never replaces an existing `wallet.dat`; move that away first, since it may hold the keys to coins:

```bash
npm run cli -- --data-dir ./data/restored restore-wallet --encrypt   # asks for the words, then a new passphrase
npm start -- --data-dir ./data/restored --peers ws://host:5001
```

- **Entering the words:** type them on one line or several, plain or numbered as `seed-phrase` prints them. Without a terminal they're read from stdin, followed by the passphrase line for `--encrypt`. A wrong word count, a word that isn't in the BIP39 list, or a checksum that doesn't match is refused before anything is written.
- **`--encrypt`:** the wallet is encrypted before the file is written, so the seed never reaches the disk unencrypted. Without it the restored wallet is unencrypted, like a new one.
- **Finding the addresses:** as the node syncs, it finds the addresses that were in use and watches them again (it checks every minute). This includes addresses handed out after up to 100 unused ones in a row (`WALLET_DISCOVERY_GAP`).
- **Compatibility:** the phrase is standard BIP39 (English words, no BIP39 passphrase) and addresses are m/0'/0/i, so other BIP39 tools derive the same keys.

Wallets created before seed phrases have a raw seed that no phrase can express, and a wallet whose primary address is an older single key can't be restored from a phrase either. For those, `seed-phrase` says so: back up `wallet.dat`, or create a new wallet and send the coins to it.

### Step 4: Verify

```bash
npm run check           # Build, test suite and lint
npm run smoke           # Real nodes: mine, sync, relay, restart (~10 s)
npm run e2e             # 3 regtest nodes: pay, PoW→PoS, partition + reorg, restart (~2 min)
npm run docker:check    # Build the image and check a running container (needs Docker)
npm run scale           # Cost per block, memory and startup on a 16,000-block chain (~1 min)
```

### Running in Docker

The `Dockerfile` builds the node in one stage and runs the compiled `dist/` in a slim Node.js image:
- the node runs as the unprivileged `node` user, with production dependencies only
- the native `secp256k1` addon is compiled when there's no prebuilt one (linux-arm64), and the build fails if it's missing
- the data dir is the `/data` volume

```bash
docker compose up -d                       # one node: compose.yaml
docker compose exec node cli balance       # the CLI runs inside the container
docker compose exec node cli new-address
docker compose logs -f node
docker compose down                        # docker stop: the node stops cleanly first
```

Add `--mine`, `--stake` or `--peers ws://host:5001` to `command` in `compose.yaml`. Without compose:

```bash
docker build -t blockchain-ts .
docker run -d --name node -v node-data:/data -p 5001:5001 -p 127.0.0.1:6001:6001 blockchain-ts --stake
docker exec node cli staking
```

The image sets `DATA_DIR=/data`, `P2P_PORT=5001`, `API_PORT=6001` and `API_HOST=0.0.0.0`, so a published API port reaches the chain routes and the [block explorer](#block-explorer). Publish it on `127.0.0.1` as above unless others should see it. The wallet routes still answer only requests from inside the container, which is why the CLI runs there with `docker exec`. The health check polls `/status`.

A local regtest network of two nodes, with explorers on ports 6001 and 6002:

```bash
docker compose -f compose.regtest.yaml up -d
docker compose -f compose.regtest.yaml exec a cli send "$(docker compose -f compose.regtest.yaml exec b cli new-address)" 100
docker compose -f compose.regtest.yaml down -v   # -v also deletes both chains
```

Back up the wallet with `docker compose exec node cli seed-phrase`, or copy the file with `docker compose cp node:/data/wallet.dat ./wallet-backup.dat`. To restore a seed phrase into the volume, with the node stopped:

```bash
docker compose stop node
docker compose run --rm --no-deps --entrypoint mv node /data/wallet.dat /data/wallet.dat.old   # keep the old one
docker compose run --rm --no-deps --entrypoint cli node restore-wallet --encrypt
docker compose start node
```

### Running a Network Across Machines

All nodes of a network must run the same version: the same genesis block and network id (`cli status` shows the network).

1. **First node.** Start it on a machine whose P2P port (5001) the others can reach. Open the port in the firewall; on a home network, forward it on the router. `compose.yaml` publishes 5001.
2. **Joining nodes.** Give them the address of any node that is already running. They learn the other nodes from it:

   ```bash
   SEED_NODES=ws://node1.example.com:5001 npm start -- --stake   # or: npm start -- --peers ws://node1.example.com:5001 --stake
   ```

   With Docker, set it in a `compose.override.yaml` next to `compose.yaml` (compose reads both):

   ```yaml
   services:
     node:
       environment:
         SEED_NODES: ws://node1.example.com:5001
       command: ["--stake"]
   ```

   A node passes on only addresses it has connected to itself or was given, saves the ones that work in `peers.json`, and keeps up to 8 outbound connections. After a restart it rejoins from that file, without seed nodes.
3. **Ports.** If others reach a node under a different port than the one it listens on (Docker publishing `7001:5001`, a router forwarding 7001), set `P2P_EXTERNAL_PORT=7001`. The node then announces the port they can dial. A node that can't be reached from outside still works: it dials out, others just can't dial it.
4. **Clocks.** Keep every machine's clock synchronized (NTP, on by default on most systems). Proof of stake works in 16-second slots and refuses blocks more than 2 hours ahead. A clock that is off by minutes makes a node's blocks lose races or be refused.
5. **Phases.** Someone mines the first 1200 blocks (`--mine`), which takes about 10 hours. After that only staked blocks are valid, and a coin can stake once it is 8 hours old and 10 blocks deep. Because mining lasts longer than that, the coins mined in the first hours can stake by the time it ends, so run `--stake` on the mining node (or on a node that received coins early) for the network to continue.
6. **Check it.** `cli status` on each machine shows its peers and height, `GET /peers` lists the connections, and every node should report the same tip. The [block explorer](#block-explorer) shows the same chain on each.

Peers talk plain WebSocket (`ws://`) and exchange only blocks, transactions and peer addresses, which are public anyway. The HTTP API stays on loopback unless `API_HOST` exposes it, and the wallet routes never answer another machine.

`npm run network:check` tests this setup with three containers that act as separate machines, each with its own IP address and hostname:
- C is configured with only B, finds A through B and connects to it.
- A payment from A confirms at C.
- C, recreated without seed nodes, rejoins from its `peers.json`.

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

Every node serves a JSON API on `127.0.0.1` at the P2P port + 1000 (6001 by default, 6002 for a node with `P2P_PORT=5002`). Amounts are decimal strings in base units (`COIN` = 10^8). The chain routes are public and read-only. Set `API_HOST` to expose them on other interfaces. The wallet routes always answer only requests from the same machine (403 otherwise), because the API is plain HTTP.

| Endpoint | Returns |
| -------- | ------- |
| `GET /` | The [block explorer](#block-explorer) page |
| `GET /status` | Network id, height, tip hash, chain work, phase (`pow`/`pos`), median time past, mempool size, peer count |
| `GET /blocks?before=<height>&limit=<n>` | Summaries of active-chain blocks below `before` (default: from the tip), newest first, `limit` 1 to 100 (default 20): height, hash, time, PoS or not, transaction count, size, producer (the staker, or the PoW coinbase's payee) |
| `GET /blocks/:heightOrHash` | The block (header, signature, transactions with their txids), merkle root, size, producer, whether it is on the active chain, confirmations, and the next block's hash. Side-branch blocks are found by hash |
| `GET /transactions/:txid` | The transaction plus its block hash, height and confirmations (`block: null` while in the mempool; indexed lookup on the active chain). Each input carries the output it spends (`spent: {address, amount}`), each confirmed output whether it is still `unspent`, plus `fee`, `size`, `coinbase` and `coinstake` |
| `GET /addresses/:address` | Balance, spendable balance (mature and not claimed by the mempool), number of outputs, number of transactions, total received and total sent |
| `GET /addresses/:address/transactions?before=<n>&limit=<n>` | The address's transactions on the active chain, newest first, `limit` 1 to 100 (default 25): position, txid, height, time, confirmations, what it received and sent, and the balance after it. Positions count from 0, oldest first, and don't shift, so `before=<position>` pages stay valid as blocks arrive. `pending` lists mempool transactions that pay or spend the address |
| `GET /addresses/:address/utxos` | Each unspent output: txid, index, amount, height, confirmations, coinbase/coinstake, spendable |
| `GET /mempool` | Number and total size of pending transactions, and their txids |
| `GET /peers` | Connected peers that completed the handshake: address, direction, height at handshake |
| `GET /wallet` | The wallet's primary address, the number of addresses handed out, the balance, spendable balance and number of outputs over all its addresses, its encryption state, and whether it has a seed phrase (token required) |
| `GET /wallet/addresses` | The addresses handed out (plus watched ones holding coins), each with its receiving index, balance and outputs; the primary first (token required) |
| `POST /wallet/addresses` | Body `{}`: hands out a new receiving address, also while locked; returns `{"address": "..."}` (token required) |
| `GET /wallet/transactions?before=<n>&limit=<n>` | The wallet's transactions over all its addresses, one entry per transaction, newest first and paged like an address's: position, txid, height, time, confirmations, type (`receive`, `send`, `self`, `mined`, `reward`, `stake`), `amount` (the net change to the wallet, negative for a payment, fee included), the fee when the wallet paid it, the addresses paid (a payment's recipients, otherwise the wallet's own), the balance after it, and whether mined or staked coins are still immature. `pending` lists mempool transactions (token required) |
| `POST /wallet/send` | Body `{"outputs": [{"address": "...", "amount": "<base units>"}]}` (1 to 255 outputs). Pays from the node's wallet plus the minimum fee and returns `{"txid": "...", "fee": "<base units>"}`; 423 while the wallet is locked or unlocked for staking only (token required) |
| `POST /wallet/encrypt` | Body `{"passphrase": "..."}` (at least 8 characters): encrypts the seed at rest and locks the wallet (token required) |
| `POST /wallet/unlock` | Body `{"passphrase": "...", "timeout": <seconds, 0 = no limit>, "stakingOnly": <bool>}`; 403 for a wrong passphrase (token required) |
| `POST /wallet/lock` | Wipes the keys from memory (token required) |
| `GET /wallet/staking` | Whether the node stakes, whether its wallet can sign, eligible outputs and value, the chance per 16 s slot of finding a kernel and the expected wait, blocks staked since start, and the last block it staked (token required) |
| `POST /wallet/passphrase` | Body `{"passphrase": "...", "newPassphrase": "..."}`: re-encrypts the seed under the new passphrase and deletes backups (token required) |
| `POST /wallet/seed-phrase` | Body `{}`, or `{"passphrase": "..."}` for an encrypted wallet (needed every time; the wallet isn't unlocked): returns `{"phrase": "<24 words>"}`. 409 for a wallet without a phrase (token required) |

### Block Explorer

Open the API's root in a browser, `http://127.0.0.1:6001/` by default, to browse the node's chain:
- the latest blocks, the mempool and the connected peers
- each block with its transactions, each transaction with what its inputs spend and its fee
- each address with its balance, totals, every transaction that touched it (with the balance after each, pending ones first) and its unspent outputs

The search box takes a height, a block hash, a txid or an address. The page refreshes when a new block arrives.

The explorer is a static page (`src/api/explorer/`) that reads only the public chain routes. It inserts data as text, never as HTML. A strict Content-Security-Policy lets it load only its own script and style and call only this API. Like the chain routes it is local unless `API_HOST` exposes it.

The wallet routes require `Authorization: Bearer <token>`, where the token is the content of `<data dir>/api.cookie`. The node writes a new random token there (mode 0600) at every start, so only users who can read the data dir can spend, and the API sends no CORS headers, so web pages can't add the header.

```bash
curl -s localhost:6001/status
curl -s localhost:6001/blocks/1
curl -s -H "Authorization: Bearer $(cat <data dir>/api.cookie)" localhost:6001/wallet
```

Malformed input returns 400, a missing or wrong token 401, unknown items 404, other methods 405, a non-JSON body 415, and a payment the chain rejects (for example insufficient funds) 422, each with an `error` field.

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
| `TRANSACTION` | Broadcast | New transaction; relayed once accepted to the mempool, never back to the sender. Also the reply to `GET_TRANSACTIONS` |
| `PEERS`       | Broadcast | Known peer addresses (discovery) |
| `MEMPOOL`     | Both, after the handshake | The txids of up to 5,000 pending transactions, highest fee rates first. The receiver requests the ones it lacks once it has the sender's chain: right away if it has the sender's tip, otherwise after syncing from it |
| `GET_TRANSACTIONS` | Request | Txids from the peer's `MEMPOOL`; each announced transaction is sent once, as `TRANSACTION` |

The `MEMPOOL` exchange gets a payment to peers that weren't connected when it was made: a node that sent a payment while it had no peers, or a node that just started. Nodes from before the exchange ignore these two messages.

A node accepts up to 32 inbound connections and dials up to 8 peers, topping outbound connections up every minute from its address book: addresses that worked first, at random. Peers' `PEERS` messages add at most 32 addresses each and never decide whom the node dials. Addresses that fail 5 times in a row are dropped, unless you configured them (`--peers`, `SEED_NODES`), and only configured or verified addresses are passed on. Lost peers are redialed with doubling delays capped at 60 s; the delay starts over only after a completed handshake, so a peer that keeps refusing it (another protocol version, a ban) is redialed less and less often. A node keeps one connection per peer node, recognized by the nonce in `VERSION`, even when it is reachable under several addresses (a Docker service name and its IP) or both nodes dial each other: the dialing side closes the extra one (for two nodes that dialed each other, the one with the higher nonce) and doesn't redial that address while the node stays connected. Malformed messages and invalid blocks add misbehavior points; at 100 the peer is disconnected and banned for 24 hours (by IP; by IP and listen port on loopback). Bans are kept in `banned.json`, so they survive restarts. Block requests from one peer are served one at a time, 100 ms apart; more than 4 waiting counts as misbehavior.

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
| Node status       | `npm run cli -- status`                                       |
| Wallet balance    | `npm run cli -- balance`                                      |
| New address       | `npm run cli -- new-address`                                  |
| Wallet addresses  | `npm run cli -- addresses`                                    |
| Wallet history    | `npm run cli -- history`                                      |
| Seed phrase       | `npm run cli -- seed-phrase`                                  |
| Restore wallet    | `npm run cli -- --data-dir <dir> restore-wallet --encrypt` (node stopped) |
| Send coins        | `npm run cli -- send <address> <coins>`                       |
| Staking status    | `npm run cli -- staking`                                      |
| Block explorer    | open `http://127.0.0.1:6001/`                                 |
| Docker node       | `docker compose up -d`, then `docker compose exec node cli status` |
| Docker check      | `npm run docker:check`                                        |

---

## Troubleshooting

### `invalid stored chain: genesis block hash mismatch` on Start

Block and transaction formats change while the project is pre-release, and each change creates a new genesis block. Data written by an older version won't load. Delete the data directory (or point `--data-dir` somewhere new) and start again.

### `Disconnecting peer: protocol version ...` or `invalid stored block` after an upgrade

Consensus rules also change while the project is pre-release. When they do, the protocol version goes up, and nodes on different versions refuse to peer. Stored blocks that break a new rule are dropped at startup, and the node continues from the last valid block: the chain database records the rules it was built under, so after a rule change the node rebuilds it and validates every stored block again. Upgrade every node, and delete old data directories if the chain shrinks unexpectedly.

### Port Already in Use

If the P2P port is taken, the node logs `P2P server could not listen on port ...` and exits with code 1. Free the port or choose another with `P2P_PORT`:

```bash
# Find and kill the process using the port
lsof -i :5001
kill -9 <PID>
```

If only the API port (P2P port + 1000) is taken, the node keeps running without the API and logs `API could not listen on ...`. Set `API_PORT` to another port.

### Suspect chain state

Start once with `--reindex`: the node rebuilds `blocks/chain.db` from the block files, validating every stored block from genesis. It does the same by itself when the database is missing or unreadable. On a long chain this takes a while (about 0.7 ms per block).

### Node Can't Connect to Peers

- Verify the peer node is running, and that `cli status` on both shows the same `network`
- Check the `--peers` and `SEED_NODES` format: `ws://host:port`, comma-separated
- Ensure the peer's firewall (and router, at home) lets connections reach its P2P port
- A node reached under another port than it listens on needs `P2P_EXTERNAL_PORT` (see [Running a Network Across Machines](#running-a-network-across-machines))
- `Disconnecting peer: banned` means the other node misbehaved earlier; bans are in `banned.json` and expire after 24 hours

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
