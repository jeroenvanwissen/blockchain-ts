# TASK-0022: Remove dead code and stale files

Status: done
Priority: P2
Size: small
Depends on: none
Source: F-018, old F1

## Why

The repository root still holds files from the original JavaScript prototype: `index.js` (entirely commented out), `lib/logger.js` and `lib/networking.js` (CommonJS, never imported), an empty `tsc.out`, and `jest.config.js`, a duplicate of `jest.config.cjs` without the secp256k1 preload. Because two Jest configs exist, a plain `npx jest` refuses to run. `package.json` still names the package `blockchain-js` with `main: index.js`, lists build-time packages as runtime dependencies, and keeps `winston` and `ts-node`, which nothing uses.

## Scope

- Delete `index.js`, `lib/`, `jest.config.js` and `tsc.out`.
- `package.json`: name `blockchain-ts`, repository URLs matching the remote, no `main`. Move `@types/ws` to devDependencies. Drop `winston` (TASK-0023 decides on logging) and `ts-node` (scripts use tsx) along with the `ts-node` block in `tsconfig.json`.
- `@fastone/eslint-config` is not referenced by `.eslintrc.cjs`; it's only there because it pulls in `eslint`. Replace it with a direct `eslint` devDependency at the version in use, so lint results don't change.
- Remove source code with no callers.
- Out of scope: the wallet's manual transaction and UTXO bookkeeping (`Wallet.getSpendableOutputs`, `getTransactionHistory`, `addTransaction`). TASK-0017 replaces it with chain-derived state.

## Acceptance criteria

- [x] The stale files are gone and nothing references them.
- [x] `npx jest` works without `--config`.
- [x] Runtime dependencies are only what the node imports at runtime.
- [x] `npm run build`, `npm test` and `npm run smoke` pass; `npm run lint` reports the same errors as before.

## Validation

`npm run build`, `npm test`, `npm run smoke`, `npm run lint` (error count compared with before).

## Outcome

- Deleted `index.js`, `lib/logger.js`, `lib/networking.js`, `jest.config.js` and `tsc.out`. `npm test` is plain `jest` again, and `npx jest` picks up `jest.config.cjs` with the secp256k1 preload.
- `package.json`:
  - Named `blockchain-ts`, with repository URLs matching the remote. `main` is removed.
  - Runtime dependencies are now `async-mutex`, `protobufjs`, `secp256k1` and `ws`. `@types/ws` moved to devDependencies.
  - `winston`, `ts-node` and `@fastone/eslint-config` are gone; `eslint` 8.57.1, the version already in use, is now a direct devDependency. The lockfile lost 276 packages, mostly the Airbnb, React, Tailwind and Prettier plugins that came with the unused config.
- `tsconfig.json`: removed the `ts-node` block.
- `Blockchain.getTotalBalance` had no callers (it rescanned the chain; `getBalance` reads the UTXO set) and is removed.
- Checked for other dead code: every exported symbol and config constant has a caller. Methods used only by tests (`minePendingTransactions`, `replaceChain`, `getStakeModifier`, the BlockStore readers) stay as documented tooling.
- `npm run build`, `npm test` (17 suites, 232 tests) and `npm run smoke` pass. `npm run lint` dropped from 53 to 49 errors: the four from the deleted files. 42 of the remaining 49 come from linting the generated `dist/` and `coverage/` folders, so TASK-0021 is smaller than the earlier note suggested.
