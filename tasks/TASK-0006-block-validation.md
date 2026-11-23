# TASK-0006: One block-validation path against a UTXO view

Status: pending
Priority: P0
Size: large
Depends on: TASK-0005
Source: F-005, F-010

## Why

Blocks can mint coins from nothing. `_addMinedBlockInternal` and `replaceChain` only run `hasValidTransactions()` (`src/blockchain/Blockchain.ts:204-356,1311-1314`). `updateUTXOSet` skips unknown inputs and still credits outputs (`Blockchain.ts:121-158`). Each entry point applies different checks, stake age reads `Date.now()` (`Blockchain.ts:414-426`), and loading from disk does no consensus validation.

## Scope

- A single `connectBlock(block, view)` (name open) that checks:
  - structure and limits; coinbase first and only;
  - for each transaction, applied in order to a UTXO view: inputs exist and are unspent, maturity, signatures (TASK-0005), inputs ≥ outputs;
  - no double spend inside the block;
  - coinbase (or coinstake) value ≤ subsidy + fees.
  It produces undo data.
- Use it for new blocks, chain replacement (until TASK-0012) and startup load (full revalidation, or a validated snapshot).
- Mempool admission uses the same per-transaction checks against view + mempool.
- Remove `hasValidTransactions` and the duplicated checks in `isChainValid` and `replaceChain`.
- Consensus checks read time only from block data. The wall clock is used only for the future-timestamp limit.

## Acceptance criteria

- [ ] F-005 regression test passes: a block spending a non-existent output is rejected.
- [ ] A block spending the same outpoint twice is rejected.
- [ ] The same chain is accepted or rejected identically by add-block, chain replacement and startup load.
- [ ] No `Date.now()` in consensus validation apart from the future-time limit.

## Validation

`npm test`, `npm run smoke`.
