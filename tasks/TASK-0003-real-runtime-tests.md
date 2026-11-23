# TASK-0003: Add integration tests that use the real runtime

Status: done
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

- [x] Integration tests run with `npm test` and touch only temp dirs, never the user's default data dir.
- [x] The persistence round-trip test passes.
- [x] The four attack scenarios exist as tests that document current behavior.

## Validation

`npm test`. The ESM runtime is covered by `npm run smoke` from TASK-0001.

## Outcome

- `BlockchainOptions.blocksDir` makes the block directory injectable (default `BLOCKS_DIR`). `BlockStore` and `Wallet` already took paths.
- `src/__tests__/integration/Persistence.test.ts` (5 tests, real fs + protobuf, temp dirs) covers:
  - genesis written and reloaded;
  - 5 mined blocks reloaded with identical hashes and UTXO set;
  - a signed spend reloaded with its inputs;
  - mining continuing on a reopened chain;
  - the wallet key surviving a reopen.
- `src/__tests__/integration/ConsensusAttacks.test.ts` holds F-004, F-005, F-006 and F-007 as `test.failing`, each asserting the desired behaviour. Each was also run as a plain `test` to confirm it fails on its final assertion rather than in setup:
  - F-004 and F-005: the promise resolved instead of rejecting;
  - F-006: the restarted node reported stake 0 (expected 100);
  - F-007: `isProofOfStake()` returned true.
- `npm test`: 7 suites, 170 tests, about 36 s. The default data dir is untouched (its timestamp is unchanged).
