# TASK-0068: Memory bounded by a cache, not by the UTXO set or the chain

Status: pending
Priority: P2
Size: large
Depends on: none
Source: F-050 (reassessment 3, 2026-11-27); TASK-0053 and TASK-0055 measurements

## Why

Milestone 9 moved blocks and undo data to disk. What still grows in memory:
- **The UTXO set.** It is loaded whole at startup (`Blockchain._takeDbState`), at about 300 B per output (measured). There is no dust limit (only zero amounts are refused, `Transaction.ts:283`), so 10 million one-unit outputs cost about 44 coins in fees and several GB of heap, at run time and at every start.
- **The startup peak.** `ChainDb.loadBlocks` holds every row and every record at once (`ChainDb.ts:290-327`): about 2.35 KB per block, roughly 2.4 GB at 1,000,000 blocks (measured on a 200,000-block synthetic database), with a temporary sort over all blocks. `activeModifiers()` and `loadUtxos()` also load everything, and run again after a storage rollback.
- **The block index.** About 280 B per block in steady state (TASK-0055), with hashes as 64-character strings.

## Scope

- UTXOs read from the chain database through a bounded cache. Validation, staking and the wallet's balance queries go through it.
- Startup streams block records (iterate, don't `.all()`) and builds the index without a second full copy.
- A dust limit as mempool and wallet policy (not consensus), in `config.ts`.
- Optionally, compact block-index entries (binary hashes, the parent as a reference).

## Acceptance criteria

- [ ] Heap after startup and while running is bounded by the cache size, not by the number of UTXOs (measured at two UTXO-set sizes).
- [ ] The startup peak is close to the steady state (measured at two chain lengths).
- [ ] Outputs below the dust limit are refused by the mempool and never created by the wallet.
- [ ] `npm run scale` shows no regression in accept, start or sync times (or explains it).

## Validation

`npm run check`, `npm run smoke`, `npm run scale` before and after, `npm run e2e`.
