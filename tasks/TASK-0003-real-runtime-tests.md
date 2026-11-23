# TASK-0003: Add integration tests that use the real runtime

Status: pending
Priority: P0
Size: medium
Depends on: TASK-0001
Source: F-016

## Why

`src/blockchain/__tests__/Blockchain.test.ts` mocks `fs` and `protobufjs`, and ts-jest compiles to CommonJS. 161 tests pass while the node can't start (F-001) or restart (F-002). The attack scenarios in the assessment (F-004 to F-007) have no regression tests.

## Scope

- Make the data directory injectable. `Blockchain`, `BlockStore` and `Wallet` should take a path instead of reading the import-time `BLOCKS_DIR` and `DATA_DIR` constants.
- Add integration tests (for example `src/__tests__/integration/`) that use real files in a temp dir, with no `fs` or `protobufjs` mocks.
- Persistence test: mine N blocks, create a new instance on the same dir, and check that the chain and UTXO set are identical.
- Attack regression tests for F-004 (forged signature), F-005 (block spends a non-existent output), F-006 (stake lost on restart) and F-007 (PoS block before the cutoff). Mark them `test.failing` until the fixing task lands. The fixing task flips them to `test`.

Excluded: fixing the attacks themselves.

## Acceptance criteria

- [ ] Integration tests run with `npm test` and touch only temp dirs, never the user's default data dir.
- [ ] The persistence round-trip test passes.
- [ ] The four attack scenarios exist as tests that document current behavior.

## Validation

`npm test`. The ESM runtime is covered by `npm run smoke` from TASK-0001.
