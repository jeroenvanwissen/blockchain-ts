# TASK-0071: Keep pending transactions whose inputs a reorganization unconfirms

Status: pending
Priority: P3
Size: medium
Depends on: none
Source: F-051 (reassessment 3, 2026-11-27)

## Why

The mempool takes transactions with confirmed inputs only. When a reorganization puts a confirmed transaction back in the mempool, a pending transaction that spends its outputs fails readmission (`Blockchain._readmitTransactions`, `:887-898`) and is dropped. Nothing retries it once the parent confirms again. This includes the node's own wallet payments. Reproduced: Alice pays Bob in block N, Bob pays Carol from that output while it is pending; after a one-block reorganization Bob's payment is gone. One-block reorganizations are routine with same-slot PoS siblings.

## Scope

Either:
- **Chained transactions:** allow pending transactions to spend outputs of other pending transactions (a mempool package model: ancestors, eviction, block selection in order). A larger change.
- **A small waiting pool:** keep transactions that failed readmission only because a parent is pending, and retry them when a block confirms that parent. Bounded in size and age.

## Acceptance criteria

- [ ] After a one-block reorganization, a pending transaction spending an output of a disconnected block is confirmed once its parent is (integration test).
- [ ] The waiting pool, if chosen, is bounded and expires entries.

## Validation

`npm run check`, `npm run e2e`.
