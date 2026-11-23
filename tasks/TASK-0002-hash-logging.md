# TASK-0002: Remove per-hash logging from block hashing

Status: pending
Priority: P0
Size: small
Depends on: none
Source: F-014

## Why

`Block.calculateHash` logs the full block JSON and the hash on every call (`src/blockchain/Block.ts:43,45`), including every nonce attempt during mining. One `npm test` run printed 82,925 such pairs (829k log lines) and took 56 s. Mining speed is bounded by console output.

## Scope

Remove the debug logging from `calculateHash` and the hash dumps in `Blockchain.isChainValid`. Keep error logging. Excluded: the wider logging cleanup (TASK-0023).

## Acceptance criteria

- [ ] `npm test` output contains no "Block data for hashing" lines.
- [ ] Test duration before and after is recorded in the PR description.

## Validation

`npm test`, `npm run build`.
