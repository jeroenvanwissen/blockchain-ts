# Agent instructions for blockchain-ts

## Purpose and layout

A hybrid PoW/PoS blockchain node in TypeScript: UTXO transactions, secp256k1 signatures, WebSocket peers, protobuf block storage. **It doesn't work end to end yet.** See [tasks/assessment-2026-11-23.md](tasks/assessment-2026-11-23.md) for what is broken and [tasks/BACKLOG.md](tasks/BACKLOG.md) for the plan.

- `src/blockchain/`: chain state and consensus (`Blockchain.ts`), `Block.ts`, `Transaction.ts`, `Wallet.ts`, `BlockStore.ts` (append-only `blk*.dat` files plus `index.dat`), `Miner.ts` with `miningWorker.cjs`, `StakingService.ts`
- `src/networking/P2PServer.ts`: WebSocket peers, chain sync, peer discovery
- `src/config.ts`: all constants and the data-dir and port settings
- `src/index.ts`: node entry point; `src/mine.ts`: standalone miner
- `proto/`: protobuf schemas for blocks, the block index and the wallet
- Tests sit next to their sources in `__tests__/` folders (`*.test.ts`)

## Setup and commands

Run everything from the repository root (proto files are currently resolved from the working directory).

- Install: `npm install`
- Build: `npm run build` (tsc)
- Test: `npm test` (Jest + ts-jest; about 1 minute)
- Lint: `npm run lint` (currently fails with 41 errors, see TASK-0021)
- Run a node: `npm start -- --data-dir <dir>`; add `--peers ws://host:port` to connect to another node. Port comes from the `P2P_PORT` env var (default 5001). There is no `PEERS` env var.
- As of 2026-11-23 the node crashes on start (F-001) and on restart (F-002). TASK-0001 fixes both.

## Conventions

- ES modules (`"type": "module"`). Relative imports use explicit `.js` extensions; use `import type` for type-only imports.
- `src/blockchain/miningWorker.cjs` must stay CommonJS.
- Import CommonJS packages (for example `secp256k1`) by default import. ts-jest compiles to CommonJS and hides namespace-import failures that crash the real runtime.
- Put constants in `src/config.ts`. Use environment variables only for runtime settings (ports, peers, data dir).
- `Blockchain` mutations go through its `async-mutex` lock. Public async methods acquire it; `_`-prefixed internals assume it is held. Never call a public locking method while holding the lock.
- Formatting follows the editor Prettier settings in `.vscode/settings.json`: tabs, single quotes, trailing commas. Don't reformat code you aren't changing.
- Tests: use `jest.useFakeTimers()` with `jest.setSystemTime()`. `jest.spyOn(Date, 'now')` doesn't work under fake timers.

## Architecture and constraints

- Consensus code must be deterministic from chain data. No wall-clock reads except the future-timestamp limit, and no node-local state that peers can't rebuild from blocks.
- Every block, whether new, synced or loaded from disk, must pass the same validation path (TASK-0006).
- The target PoS model is Peercoin-style UTXO kernel staking (TASK-0009 to TASK-0011). Don't extend the current stake-registry code (`_stakes`, `stake()`, `unstake()`, slashing). It is scheduled for removal.
- Format changes (transactions, headers) need a new genesis. That is acceptable while no persistent network exists.

## Work tracking

- Work items live in [tasks/BACKLOG.md](tasks/BACKLOG.md) with permanent `TASK-####` IDs. Detailed tasks have their own file in `tasks/`.
- Set a task to `in-progress` when you start it and `done` when its acceptance criteria are met. Don't renumber tasks.
- Branches so far follow `feature/<task-id>-<slug>`.

## Change verification

- Run `npm run build` and `npm test` for every change. Also run `npm run lint` on the files you touched.
- Unit tests mock `fs`, `protobufjs` and time, so they don't prove the node runs. For anything touching startup, storage, wallet, mining or networking, also start a real node against a temporary `--data-dir`, restart it, and check the output (`npm run smoke` once TASK-0001 adds it).
- When an attack scenario from the assessment is fixed, turn its regression test from `test.failing` into `test`.

## Safety

- Never log or commit private keys or wallet files. `data/` is gitignored; `wallet.dat` is written with `0600` permissions.
- Tests must use temp directories, never the default data dir (`~/Library/Application Support/blockchain-ts` on macOS, `~/.blockchain-ts` on Linux).
- Treat all peer data as untrusted: type-guard every message before use.
