# Agent instructions for blockchain-ts

## Purpose and layout

A hybrid PoW/PoS blockchain node in TypeScript: UTXO transactions, secp256k1 signatures, WebSocket peers, protobuf block storage. **It doesn't work end to end yet.** See [tasks/assessment-2026-11-23.md](tasks/assessment-2026-11-23.md) for what is broken and [tasks/BACKLOG.md](tasks/BACKLOG.md) for the plan.

- `src/blockchain/`: chain state and consensus (`Blockchain.ts`), `Block.ts`, `Transaction.ts`, `Wallet.ts`, `BlockStore.ts` (append-only `blk*.dat` files plus `index.dat`), `Miner.ts` with `miningWorker.cjs`, `StakingService.ts`
- `src/networking/P2PServer.ts`: WebSocket peers, chain sync, peer discovery
- `src/config.ts`: all constants and the data-dir and port settings
- `src/index.ts`: node entry point; `src/mine.ts`: standalone miner; `src/smoke.ts`: runtime smoke check
- `src/blockchain/protoSchemas.ts`: protobuf schemas for blocks, the block index and the wallet (embedded strings, no `.proto` files)
- `src/blockchain/secp256k1.ts`: ESM/CommonJS-safe `secp256k1` import; import the library through this module
- Tests sit next to their sources in `__tests__/` folders (`*.test.ts`). Unit tests mock `fs` and `protobufjs`.
- `src/__tests__/integration/`: tests with real files in temp dirs (`helpers.ts`: `openChain`, `openWallet`, `mineBlocks`, `solve`). `ConsensusAttacks.test.ts` holds the open attack scenarios as `test.failing`

## Setup and commands

Run npm scripts from the repository root.

- Install: `npm install`
- Build: `npm run build` (tsc)
- Test: `npm test` (Jest + ts-jest; about 1 minute)
- Smoke: `npm run smoke` (real node processes in a temp dir: start, restart, second node connects; about 10 s; `-- --keep` keeps the temp dir)
- Lint: `npm run lint` (currently fails on pre-existing errors, see TASK-0021); lint touched files with `npx eslint <files>`
- Run a node: `npm start -- --data-dir <dir>`; add `--peers ws://host:port` to connect to another node. Port comes from the `P2P_PORT` env var (default 5001). There is no `PEERS` env var. The wallet lives at `<data dir>/wallet.dat`.

## Conventions

- ES modules (`"type": "module"`). Relative imports use explicit `.js` extensions; use `import type` for type-only imports.
- `src/blockchain/miningWorker.cjs` must stay CommonJS.
- CommonJS packages behave differently under ts-jest (compiled to CommonJS) and the real runtime (native ESM): a namespace import can work in tests and crash the node. Verify new CommonJS imports with `npm run smoke`.
- Don't use `import.meta` in modules that tests import; ts-jest rejects it (TS1343). Entry points such as `src/smoke.ts` may use it.
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
- Unit tests mock `fs`, `protobufjs` and time, so they don't prove the node runs. For anything touching startup, storage, wallet, mining, networking or imports, also run `npm run smoke`.
- When an attack scenario from the assessment is fixed, turn its regression test from `test.failing` into `test`.

## Safety

- Never log or commit private keys or wallet files. `data/` is gitignored; `wallet.dat` is written with `0600` permissions.
- Tests must use temp directories, never the default data dir (`~/Library/Application Support/blockchain-ts` on macOS, `~/.blockchain-ts` on Linux).
- Treat all peer data as untrusted: type-guard every message before use.
