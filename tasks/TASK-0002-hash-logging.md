# TASK-0002: Remove per-hash logging from block hashing

Status: done
Priority: P0
Size: small
Depends on: none
Source: F-014

## Why

`Block.calculateHash` logs the full block JSON and the hash on every call (`src/blockchain/Block.ts:43,45`), including every nonce attempt during mining. One `npm test` run printed 82,925 such pairs (829k log lines) and took 56 s. Mining speed is bounded by console output.

## Scope

Remove the debug logging from `calculateHash` and the hash dumps in `Blockchain.isChainValid`. Keep error logging. Excluded: the wider logging cleanup (TASK-0023).

## Acceptance criteria

- [x] `npm test` output contains no "Block data for hashing" lines.
- [x] Test duration before and after is recorded (see Outcome).

## Validation

`npm test`, `npm run build`.

## Outcome

- Removed the two logs in `Block.calculateHash` and the hash dumps in `Blockchain.isChainValid`. The two debug lines before `Invalid block index` moved into the error message (expected vs got). Two commented-out logs were deleted.
- `npm test` output went from 829,326 lines to 71. Test time didn't change (50.6 s before, 52.1 s after), so console output wasn't what made the suite slow.
- Hashing benchmark (50,000 `calculateHash` calls, stdout to `/dev/null`): 217k hashes/s before, 1.07M after (≈4.9×). With a real terminal the old number is lower still.
