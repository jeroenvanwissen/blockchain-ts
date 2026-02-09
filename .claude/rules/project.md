# Project Guidelines

## Directory Structure

```
src/
├── blockchain/               # Core consensus, data structures, and wallet
│   ├── Block.ts              #   Block structure, hashing, PoW/PoS detection
│   ├── Blockchain.ts         #   Chain management, UTXO set, validation, staking
│   ├── BlockStore.ts         #   Chunked block storage with protobuf index
│   ├── Transaction.ts        #   Transaction model, signing, verification
│   ├── Wallet.ts             #   Key management, address encoding, persistence
│   ├── Miner.ts              #   PoW mining via worker threads
│   ├── StakingService.ts     #   PoS block generation at intervals
│   ├── miningWorker.cjs      #   Worker thread (CommonJS required)
│   └── __tests__/            #   Colocated unit tests
├── networking/               # P2P communication layer
│   ├── P2PServer.ts          #   WebSocket server/client, chain sync
│   └── __tests__/            #   Colocated unit tests
├── __tests__/                # Root-level tests (config, etc.)
├── config.ts                 # All configuration constants (single source of truth)
├── index.ts                  # Node entry point
└── mine.ts                   # Miner entry point
proto/                        # Protobuf schema definitions
├── blockchain.proto          #   Block serialization schema
├── blockindex.proto          #   Block index schema
└── wallet.proto              #   Wallet data schema
data/                         # Runtime data (gitignored, platform-specific default path)
dist/                         # Compiled output (gitignored)
```

## Module Organization

- Place new blockchain/consensus classes in `src/blockchain/`
- Place new networking classes in `src/networking/`
- Place new entry points in `src/` root
- One class per file — file name matches class name in PascalCase (e.g., `StakingService.ts`)
- Import from sibling modules using relative paths with explicit `.js` extension

## Naming Conventions

### Files

- Source files: `PascalCase.ts` (e.g., `Blockchain.ts`, `P2PServer.ts`)
- Worker files: `camelCase.cjs` (CommonJS required for `worker_threads`)
- Test files: `PascalCase.test.ts` inside `__tests__/` directory
- Config files: `lowercase.ts` (e.g., `config.ts`, `index.ts`)

### Directories

- Module directories: lowercase (e.g., `blockchain/`, `networking/`)
- Test directories: `__tests__/` inside each module directory

## Configuration

- All constants live in `src/config.ts` — never define constants inline in other files
- Add new constants as named exports: `export const NEW_CONSTANT = value;`
- Environment variables for runtime configuration only (ports, peers, data directory)
- Environment variable pattern: `process.env.VAR_NAME ? parse(process.env.VAR_NAME) : DEFAULT`
- Configuration constants use `UPPER_SNAKE_CASE`

## Dependencies

- Use `npm install` to add dependencies
- Use caret ranges (`^`) for version pinning
- Runtime crypto: use Node.js built-in `crypto` module for SHA256
- `secp256k1` for ECDSA elliptic curve operations
- `crypto-js` for RIPEMD160 (not available in Node.js built-in crypto)
- `async-mutex` for concurrency control (Mutex)
- `ws` for WebSocket communication
- `protobufjs` for binary serialization (blocks, index, wallet)
- `winston` for logging (configured but not yet migrated from console — see task F2)

## Entry Points

- `src/index.ts` — Main node process (blockchain + P2P server + optional staking)
- `src/mine.ts` — Standalone miner (connects to node via WebSocket)
- Both parse CLI arguments for `--datadir` and `--peers`

## Data Persistence

- Default data directory is platform-specific (macOS: `~/Library/Application Support/blockchain-ts/`, Linux: `~/.blockchain-ts/`, Windows: `%APPDATA%/blockchain-ts/`)
- Configurable via `--data-dir` CLI argument
- Chain: `blocks/` subdirectory with chunked `blk*.dat` files (append-only, 128 MB max) and `index.dat` (protobuf)
- Wallet: `wallet.dat` (protobuf, keys and address, `0600` permissions)
- Peers: `peers.json` (known peer addresses)
- Create backup before overwriting wallet: `wallet.dat.{timestamp}.backup` (max 3 backups kept)
