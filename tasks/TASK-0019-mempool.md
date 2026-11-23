# TASK-0019: Mempool with conflict handling and revalidation

Status: done
Priority: P2
Size: medium
Depends on: TASK-0006, TASK-0012
Source: old E2, F-007

## Why

Pending transactions lived in an unbounded array, and every template took all of them. With more than 999 pending transactions, every PoW template and stake block exceeded `MAX_BLOCK_TRANSACTIONS`, was rejected, and was rebuilt the same way: block production stalled. This is the "rejected block wedges production" symptom from F-007. Nothing limited memory use, and nothing preferred better-paying transactions. A block could also be valid yet too large to relay: 1000 maximum-size transactions exceed the 16 MB P2P message limit.

## Scope

- A `Mempool` replacing the array: conflict detection, a byte limit with fee-rate eviction, fee-rate selection for blocks.
- Revalidation against the new tip after every connect and reorg (already done by `_readmitTransactions`; keep it).
- Templates and stake blocks must always fit the block limits.
- A consensus block size limit so every valid block can be relayed.

## Acceptance criteria

- [x] Conflicting spends are rejected; a block confirming a conflict removes the pending one.
- [x] The mempool stays under its byte limit, evicting the lowest fee rates only for a better-paying newcomer.
- [x] With more pending transactions than fit in a block, templates take the highest fee rates, stay valid, and leave the rest pending.
- [x] Blocks over `MAX_BLOCK_SIZE` are rejected.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**`src/blockchain/Mempool.ts`**
- Entries hold `{ transaction, txid, fee, size }` in arrival order, plus an outpoint → txid map.
- Pending transactions spend confirmed outputs only, so any subset is a valid block body; no dependency tracking is needed.
- `add`:
  - Rejects duplicates and conflicts (the first spend stays).
  - Keeps the total under `MAX_MEMPOOL_BYTES` (8 MB; `BlockchainOptions.maxMempoolBytes`) by evicting the lowest fee rates, but only entries paying a strictly lower rate than the newcomer. Otherwise the newcomer is refused. Fee rates are compared exactly by cross-multiplication.
- `select(maxCount, maxBytes)` takes the highest rates first, ties in arrival order, and skips entries that don't fit so smaller ones can.

**`Blockchain`**
- `_mempool` replaces `pendingTransactions` and `_pendingUTXOSpends`. Admission stores the fee and size it already computed. Evictions are logged as `[Mempool] evicted N ...`.
- `createBlockTemplate` and `createStakeBlock` take `_selectForBlock(slots)`: at most `MAX_BLOCK_TRANSACTIONS` minus the coinbase (and coinstake), and at most `MAX_BLOCK_SIZE` minus `BLOCK_RESERVED_BYTES` (2,000) for the header, coinbase and coinstake. The coinbase claims exactly the selected fees.
- `getSpendableUTXOs`, `findTransaction` (now O(1) for pending), `getPendingTransactions` and `_readmitTransactions` (run after every connect and reorg) use the mempool. New `getMempoolBytes`; `GET /mempool` reports `bytes`.

**Consensus**
- `MAX_BLOCK_SIZE` = 1,000,000 bytes (`Block.size()`: header + PoS signature + serialized transactions).
- Checked first in full validation and in side-branch checks. A 1 MB binary block is well under the 16 MB JSON message limit.
- Existing chains are far below the limit, so no new genesis is needed.

**Tests**
- `Mempool.test.ts` (unit): conflicts and duplicates, eviction (single and multiple victims, refusal, oversize), selection order and limits.
- `integration/MempoolPolicy.test.ts`:
  - 1004 pending payments leave the 5 lowest-fee ones pending after a valid 1000-transaction block whose coinbase claims exactly the selected fees. Before this task that template had 1005 transactions and was rejected every time.
  - Eviction and refusal with a 600-byte mempool; the evicted output becomes spendable again.
  - A confirmed conflicting spend removes the pending one.
  - An oversized block is rejected.

**Runs**
- `npm run check`: 22 suites, 270 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 125 s (height 26, 6 PoS blocks).

**Note:** the open edge case from TASK-0017 is handled the same way. A payment spending an output that a concurrent stake block also spends is dropped by the revalidation when that block connects. It isn't reported back to the sender; there's no wallet history to show it.
