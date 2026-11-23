# Agent instructions for blockchain-ts

## Purpose and layout

A hybrid PoW/PoS blockchain node in TypeScript: UTXO transactions, secp256k1 signatures, WebSocket peers, protobuf block storage. **It doesn't work end to end yet.** See [tasks/assessment-2026-11-23.md](tasks/assessment-2026-11-23.md) for what is broken and [tasks/BACKLOG.md](tasks/BACKLOG.md) for the plan.

- `src/blockchain/`: chain state and consensus (`Blockchain.ts`), `Block.ts`, `Transaction.ts`, `Wallet.ts` (HD wallet: BIP32 addresses m/0'/0/i from one seed via `hd.ts`, a primary address for rewards and change, a watched lookahead; keys only, balances come from the chain's UTXO set), `amount.ts` (`parseCoins`, `formatCoins`), `BlockStore.ts` (append-only `blk*.dat` files plus `index.dat`), `Miner.ts` (in-node PoW miner, enabled with `--mine`) with `miningWorker.cjs`, `StakingService.ts` (in-node staking loop, enabled with `--stake`)
- `src/api/ApiServer.ts`: HTTP API. Public read-only chain routes (`/status`, `/blocks`, `/blocks/:heightOrHash`, `/transactions/:txid`, `/addresses/:address[/utxos]`, `/mempool`, `/peers`) and wallet routes (`GET /wallet`, `GET`/`POST /wallet/addresses`, `POST /wallet/send`, encrypt, unlock, lock, passphrase, `GET /wallet/staking`) that answer only loopback clients and need the bearer token from `<data dir>/api.cookie` (`src/api/cookie.ts`, rewritten at every start); `listen()`/`close()`, port 0 supported
- `src/api/explorer/`: the block explorer the API serves at `/` (`index.html`, `style.css`, and `app.js`, a browser ES module). `tsc` excludes it, `npm run build` copies it to `dist/`, and ESLint lints `app.js` with browser globals. It uses only public chain routes and inserts API data as text (`h()`), never as HTML. Keep the Content-Security-Policy in `ApiServer` strict: no inline script or style
- `src/cli.ts`: `npm run cli -- [--data-dir <dir>] [--api <url>] status|balance|new-address|addresses|send <address> <coins> ...|staking|encrypt-wallet|unlock|lock|change-passphrase` against a running node's API
- `src/networking/P2PServer.ts`: WebSocket peers: VERSION/VERACK handshake, locator-based sync (`GET_BLOCKS`/`BLOCKS`), block and transaction broadcast, peer discovery. `listen()` resolves when listening; `close()` stops everything (integration tests run real nodes in-process, see `Sync.test.ts`)
- `src/config.ts`: all constants and the data-dir and port settings
- `src/index.ts`: node entry point (`--data-dir`, `--peers`, `--mine`, `--stake`); `src/smoke.ts`: runtime smoke check
- `src/blockchain/protoSchemas.ts`: protobuf schemas for blocks, the block index and the wallet (embedded strings, no `.proto` files)
- `src/blockchain/secp256k1.ts`: ESM/CommonJS-safe `secp256k1` import; import the library through this module
- `src/blockchain/address.ts`: Base58Check addresses (`addressFromPublicKey`, `isValidAddress`)
- `src/blockchain/UtxoSet.ts`: unspent outputs by outpoint, with a per-address index
- `src/blockchain/Mempool.ts`: pending transactions (confirmed inputs only): conflict detection, byte limit with fee-rate eviction, fee-rate selection for blocks; `fees.ts`: `minRelayFee`
- `src/blockchain/target.ts` (compact `bits` ↔ target, block work) and `src/blockchain/retarget.ts` (`requiredBits`: per-block retarget, separate for PoW and PoS)
- `src/blockchain/kernel.ts`: PoS kernel hash, kernel target check, stake modifier chaining
- Tests sit next to their sources in `__tests__/` folders (`*.test.ts`). Unit tests mock `fs` and `protobufjs`.
- `src/__tests__/integration/`: tests with real files in temp dirs (`helpers.ts`: `openChain`, `openWallet`, `mineBlocks`, `solve`). `ConsensusAttacks.test.ts` holds the open attack scenarios as `test.failing`

## Setup and commands

Run npm scripts from the repository root.

- Install: `npm install`
- Build: `npm run build` (tsc)
- Test: `npm test` (Jest + ts-jest; about 1 minute)
- Smoke: `npm run smoke` (real node processes in temp dirs: node A mines, node B syncs and accepts A's next block, A restarts with its chain; fails on any logged error; about 10 s; `-- --keep` keeps the temp dir)
- End-to-end: `npm run e2e` (three `--regtest` node processes plus an in-process harness peer: payment, PoW→PoS, both A and C staking, partition and reorg, restart, convergence; about 2 minutes; prints each node's tip and last log lines on failure). Run it for changes to consensus, P2P or staking
- Lint: `npm run lint` (must pass). ESLint 10 flat config in `eslint.config.js`: type-aware typescript-eslint rules on `.ts`, Jest rules on tests, base rules on `.cjs`; ignores the generated `dist/` and `coverage/`
- Standard check: `npm run check` (build, test, lint)
- Run a node: `npm start -- --data-dir <dir>` (stops cleanly on SIGINT and SIGTERM; exits with code 1 if its P2P port is taken); add `--peers ws://host:port` to connect to another node, `--mine` to mine PoW blocks and `--stake` to stake PoS blocks. `--regtest` selects the regression-test network (own network id, 20 PoW blocks, no minimum stake age). `--reindex` ignores the saved chainstate and validates every stored block. Port comes from the `P2P_PORT` env var (default 5001). The HTTP API listens on `API_HOST` (default `127.0.0.1`) and `API_PORT` (default P2P port + 1000; `0` picks a free port and logs it). There is no `PEERS` env var. The wallet lives at `<data dir>/wallet.dat`.

## Conventions

- ES modules (`"type": "module"`). Relative imports use explicit `.js` extensions; use `import type` for type-only imports.
- `src/blockchain/miningWorker.cjs` must stay CommonJS.
- TypeScript stays on 6.0.x (`~6.0.3`; Dependabot ignores 6.1+). typescript-eslint (<6.1) and ts-jest (<7) load its JavaScript compiler API, which TypeScript 7 doesn't have. TS 6 doesn't include `@types` packages automatically, so `tsconfig.json` lists `types` (`node`, `jest`); add new global type packages there.
- CommonJS packages behave differently under ts-jest (compiled to CommonJS) and the real runtime (native ESM): a namespace import can work in tests and crash the node. Verify new CommonJS imports with `npm run smoke`.
- Don't use `import.meta` in modules that tests import; ts-jest rejects it (TS1343). Entry points such as `src/smoke.ts` may use it.
- Node modules log through `logger(scope)` from `src/logger.ts` (`<time> LEVEL [scope] message`; `LOG_LEVEL` env, default info), not `console`. Use debug for per-connection noise, warn for anything an operator should look at. The CLI and the smoke/e2e scripts use plain console output. Smoke fails on any WARN or ERROR line, and the scripts match some log wording (`P2P Server listening`, `API listening on`, `Chain loaded`, `[Staking] staked block`, `[Blockchain] reorganized`), so keep those messages.
- Put constants in `src/config.ts`. Use environment variables only for runtime settings (ports, peers, data dir).
- Amounts are `bigint` base units (`COIN` = 10^8 per coin); never use `number` for money. On the JSON wire amounts are decimal strings: send with `JSON.stringify` (`Transaction.toJSON`), parse with `Transaction.fromJSON`, which validates strictly.
- Build coinbases with `Transaction.coinbase(address, amount, height)`; its null input carries the block height.
- Fees: fee = inputs − outputs. A block's coinbase must pay exactly the block reward plus its transactions' fees (consensus). `MIN_RELAY_FEE_PER_KB` (`minRelayFee(size)` in `fees.ts`) is mempool and wallet policy, not a block rule. Hand-built test transactions that go through `addTransaction` must leave at least that fee.
- Build payments with `Blockchain.createPayment(wallet, outputs)`. It takes the largest spendable outputs of all the wallet's addresses first, pays the minimum fee for the signed size and sends change to the wallet's primary address, returning `{ transaction, fee }`. It doesn't admit the payment, so call `addTransaction` next.
- A wallet has many addresses: pass `wallet.addresses()` (handed out plus the watched lookahead) to chain queries such as `getStakeableUTXOs`, and sign with `wallet.signTransaction(tx, purpose, owners)`, where `owners[i]` is the address that owns input i's output.
- The txid (`calculateHash`) excludes public keys and signatures; blocks commit to `witnessHash`. Inputs carry a compressed public key and a compact low-S signature over `sighash(i)`.
- Block hash = sha256d of the header (version, previous hash, merkle root of witness hashes, timestamp in ms, `bits`, nonce); PoW means hash ≤ target. Chain work (`cumulativeWeight`, bigint) sums `2^256 / (target + 1)` per block. Build templates with `Blockchain.createBlockTemplate`; it sets `bits` for the block's type.
- `Blockchain` mutations go through its `async-mutex` lock. Public async methods acquire it; `_`-prefixed internals assume it is held. Never call a public locking method while holding the lock.
- Formatting follows the editor Prettier settings in `.vscode/settings.json`: tabs, single quotes, trailing commas. Don't reformat code you aren't changing.
- Tests: use `jest.useFakeTimers()` with `jest.setSystemTime()`. `jest.spyOn(Date, 'now')` doesn't work under fake timers.
- `jest.setup.cjs` preloads `secp256k1`: under `jest.mock('fs')` it can't find its native addon and falls back to a pure-JS implementation that made the suite ~40x slower. Keep it.

## Architecture and constraints

- Consensus code must be deterministic from chain data. No wall-clock reads except the future-timestamp limit, and no node-local state that peers can't rebuild from blocks.
- Fork choice: more chain work wins. Equal work goes to the lower tie-break value of the tip (deterministic, so simultaneous stakers converge): the block hash for PoW, and for PoS `stakeTieBreak` (parent hash ‖ kernel outpoint), which block contents can't influence. Never break ties on something the producer can vary for free.
- Blocks enter through `Blockchain.addMinedBlock` (or `replaceChain`, which feeds the same `_acceptBlock`). Every known block is in a block index; a block extending the tip connects, others are stored as side branches and activated by a reorg when their branch has more work. Every block that becomes active, whether new, reorged-in, or loaded from disk, goes through `Blockchain._connectBlock` (via `_connectTip` or `_replayChain`). It validates against a block-local UTXO view and changes state only if every check passes. Add consensus rules there, not in callers; mempool admission shares `_checkInputs`, and both validate transactions through `_validateTransaction` (a signature cache keyed by witness hash). Startup takes the state at the saved chainstate's tip (`blocks/chainstate.json`, `chainstate.ts`) when that tip is on the branch being activated, and validates only newer blocks; `isChainValid` always replays from genesis. Any new piece of chain state (UTXO fields, per-block data) must be saved and loaded there too, with `CHAINSTATE_VERSION` bumped, or a node starting from a chainstate would lack it. Templates and stake blocks take transactions only through `_selectForBlock`, which keeps them within `MAX_BLOCK_TRANSACTIONS` and `MAX_BLOCK_SIZE`, so a template is never invalid because of the mempool.
- The PoS model is Peercoin-style UTXO kernel staking: any UTXO with `STAKE_MIN_CONFIRMATIONS` and `minStakeAge` can stake when sha256d(modifier ‖ prevTxTime ‖ outpoint ‖ blockTime) ≤ target × value. Stake age counts from the timestamp of the block that created the output (`UTXO.blockTimestamp`), never from a transaction timestamp, because creators choose those. Transaction timestamps are bounded by consensus: never after their block, never before an output they spend. A PoS block has the coinstake at tx[1] (marker output, then the kernel value back to its owner), a timestamp on the 16 s grid and later than its parent's (one PoS block per slot), and a signature over its hash by the kernel input's key. The stake modifier is derived per block during validation. Don't reintroduce node-local stake state (registries, unstake queues, slashing lists).
- Tests can shorten the PoW phase with `BlockchainOptions.powCutoffBlock` (see `openPosChain` in the integration helpers).
- Format changes (transactions, headers) need a new genesis. That is acceptable while no persistent network exists; tell users to delete old data dirs (README troubleshooting).

## Work tracking

- Work items live in [tasks/BACKLOG.md](tasks/BACKLOG.md) with permanent `TASK-####` IDs. Detailed tasks have their own file in `tasks/`.
- Set a task to `in-progress` when you start it and `done` when its acceptance criteria are met. Don't renumber tasks.
- Branches so far follow `feature/<task-id>-<slug>`.

## Change verification

- Run `npm run check` (build, test and lint) for every change; all three must pass.
- CI (`.github/workflows/check.yml`) runs `npm ci`, `npm run check` and `npm run smoke` on every push to `main` and every pull request, then `npm run e2e`. Keep it green; a red run on `main` is the next thing to fix.
- Unit tests mock `fs`, `protobufjs` and time, so they don't prove the node runs. For anything touching startup, storage, wallet, mining, networking or imports, also run `npm run smoke`.
- When an attack scenario from the assessment is fixed, turn its regression test from `test.failing` into `test`.

## Safety

- Never log or commit private keys, wallet files or the API token. `data/` is gitignored; `wallet.dat` and `api.cookie` are written with `0600` permissions (smoke checks the cookie's mode and that the token never appears in output).
- Anything that spends from the node's wallet goes behind the API token (`route.wallet` in `ApiServer`).
- An encrypted wallet starts locked. Sign through `Wallet.signTransaction(tx, purpose, owners)` (`'spend'` or `'stake'`) and `signDigest(digest, owner)`, never with raw key access; they throw a `WalletError` while locked or staking-only. Never log passphrases (smoke checks the smoke passphrase never appears in output). Writing the wallet file must not put an encrypted wallet's seed or key back on disk unencrypted.
- Tests must use temp directories, never the default data dir (`~/Library/Application Support/blockchain-ts` on macOS, `~/.blockchain-ts` on Linux).
- Treat all peer data as untrusted: type-guard every message before use. Malformed or invalid peer data scores misbehavior (`P2PServer._misbehaving`; bans at `BAN_SCORE`). Rejections an honest peer can cause (races, clock skew, transaction policy) must not score; extend `BENIGN_BLOCK_ERRORS` if you add one. Outbound connections go through `_dial`/`_canDial` so the caps hold, and peer addresses live in `AddressBook` (`src/networking/AddressBook.ts`): never dial addresses straight from a peer's message, use `fillOutbound`.
