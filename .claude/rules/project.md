# Project Guidelines

## Directory Structure

```
src/
├── blockchain/               # Core consensus, data structures, and wallet
│   ├── *.ts                  #   One class per file
│   ├── miningWorker.cjs      #   Worker thread (CommonJS required)
│   └── __tests__/            #   Colocated unit tests
├── networking/               # P2P communication layer
│   ├── *.ts                  #   One class per file
│   └── __tests__/            #   Colocated unit tests
├── config.ts                 # All configuration constants (single source of truth)
├── index.ts                  # Node entry point
└── mine.ts                   # Miner entry point
data/                         # Runtime data (gitignored, created at startup)
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
- Runtime crypto: use Node.js built-in `crypto` module, not `crypto-js`
- `secp256k1` for elliptic curve operations
- `async-mutex` for concurrency control
- `ws` for WebSocket communication
- `winston` for logging (configured in `lib/logger/`)

## Entry Points

- `src/index.ts` — Main node process (blockchain + P2P server + optional staking)
- `src/mine.ts` — Standalone miner (connects to node via WebSocket)
- Both parse CLI arguments for `--datadir` and `--peers`

## Data Persistence

- All runtime data in `data/` directory (configurable via `--datadir`)
- Chain: `blockchain_data.json` (array of serialized blocks)
- Wallet: `wallet.json` (keys and address)
- Peers: `peers.json` (known peer addresses)
- Create backup before overwriting wallet: `wallet.json.{timestamp}.backup`
