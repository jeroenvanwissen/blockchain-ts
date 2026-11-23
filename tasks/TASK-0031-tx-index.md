# TASK-0031: Transaction index

Status: done
Priority: P3
Size: small
Depends on: TASK-0016
Source: F-028 (reassessment 2026-11-23)

## Why

`Blockchain.findTransaction`, behind `GET /transactions/:txid` and the e2e payment check, scanned the active chain from the tip and hashed every transaction it passed. Lookups of older or unknown transactions got slower as the chain grew.

## Scope

- A txid → block index for the active chain, kept correct across connects, disconnects (reorgs) and restarts.

## Acceptance criteria

- [x] Confirmed lookups use the index; transactions on abandoned branches aren't found; a reorged-out payment is reported as pending again.
- [x] The index matches the active chain after a restart.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

- `Blockchain._txIndex` (txid → active block hash) is kept in step with the active chain:
  - filled for genesis, in `_connectTip`, and after startup branch activation in `loadBlockchain`
  - cleared in `_disconnectTip`, removing a txid only if it points at the disconnected block
- `findTransaction` checks the mempool, then the index, then finds the transaction within that one block.
- Memory is one map entry per confirmed transaction. The index is rebuilt at startup alongside the UTXO set; a persisted chainstate (TASK-0029) would extend to it.

**Tests**
- `Reorg.test.ts` "should keep the transaction index on the active chain through reorgs and restarts":
  - a payment is found in branch A's block, reported as pending after a reorg to B, and found in the same block again after A returns
  - B's coinbase is found while B is active and not after
  - a reopened chain gives the same answers
- The Api tests for `/transactions/:txid` pass unchanged.

**Runs**
- `npm run check`: 27 suites, 299 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 75 s (height 25, 5 PoS blocks). The harness confirmed the payment and checked the converged chain through the index.
