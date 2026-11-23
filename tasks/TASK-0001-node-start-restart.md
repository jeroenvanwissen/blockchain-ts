# TASK-0001: Make the node start and restart from disk

Status: done
Priority: P0
Size: small
Depends on: none
Source: F-001, F-002, F-015

## Why

A fresh node crashes before listening (`secp256k1.privateKeyVerify is not a function`). Under native ESM, `import * as secp256k1` only exposes `default` (`src/blockchain/Wallet.ts:2`, `src/blockchain/Transaction.ts:1`). A node restarted on an existing data dir crashes in `Transaction.isCoinbase`, because protobufjs drops empty repeated fields on decode (`src/blockchain/BlockStore.ts:228,285`). Proto files are resolved from `process.cwd()` (`src/config.ts:80-82`). The wallet ignores `--data-dir` (`src/blockchain/Wallet.ts:53`).

## Scope

- Default-import `secp256k1` (or another ESM-safe import) everywhere, and move it from devDependencies to dependencies.
- Pass `arrays: true` to every protobuf `toObject` call (`BlockStore.ts`, `Wallet.ts`).
- Resolve proto paths relative to the package (from `import.meta.url`), not the working directory.
- Default the wallet path to `<data dir>/wallet.dat`.
- Add `npm run smoke`. It starts the real entry point with a temporary data dir, waits for the listening message, stops the node, starts it again, and checks it loads.
- README: document `--peers` and `--data-dir` for a second local node (the `PEERS` env var doesn't exist).

Excluded: consensus or format changes.

## Acceptance criteria

- [x] `npx tsx src/index.ts --data-dir <tmp>` reaches "P2P Server listening" on a fresh dir.
- [x] The same command on the same dir starts again without errors and keeps the stored chain.
- [x] Starting from a directory other than the repo root works.
- [x] `wallet.dat` is created inside the data dir.
- [x] A second node with its own `--data-dir` and `--peers ws://localhost:5001` connects to the first.

## Validation

`npm run build`, `npm test`, `npm run smoke` (new).

## Outcome

- `secp256k1` is imported through `src/blockchain/secp256k1.ts`. That module reads the CommonJS `default` export when it exists, so the import works under native ESM and under ts-jest. A plain default import fails type-checking, because `@types/secp256k1` declares named exports. `secp256k1` is now a runtime dependency (^5.0.2).
- Proto paths: ts-jest compiles to CommonJS and rejects `import.meta` (TS1343). So instead of resolving file paths, the schemas are embedded in `src/blockchain/protoSchemas.ts` and loaded with `protobuf.parse()`. The `proto/` directory and the `*_PROTO_PATH` config values are gone. This also fixes running from `dist/`, which never contained the `.proto` files.
- `npm run smoke` (`src/smoke.ts`) covers every acceptance criterion. It runs two real node processes in a temp dir with an unrelated working directory: start, restart (same wallet address, no load errors), then a second node connects with `--peers`.
- The smoke check fails against the pre-fix code (proto ENOENT). It also fails when the `arrays: true` fix or the import shim is reverted alone, at restart and at first start respectively.
- The "keeps the stored chain" criterion is checked at genesis only, because no component can mine yet (TASK-0004). Round trips of longer chains belong to TASK-0003.
