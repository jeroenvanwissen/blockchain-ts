# TASK-0006: One block-validation path against a UTXO view

Status: done
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

- [x] F-005 regression test passes: a block spending a non-existent output is rejected.
- [x] A block spending the same outpoint twice is rejected.
- [x] The same chain is accepted or rejected identically by add-block, chain replacement and startup load.
- [x] No `Date.now()` in consensus validation apart from the future-time limit.

## Validation

`npm test`, `npm run smoke`.

## Outcome

**One validation path**
- `Blockchain._connectBlock(block, ctx)` is the only place blocks are validated. It checks, in order:
  - size limit, block index, link to the parent, block hash and coinbase (height and reward);
  - minimum interval, median time past and the future limit;
  - consensus type for the height, difficulty and PoW;
  - for PoS blocks, `validateStake` against the pre-block UTXO set, with stake age measured at the block's timestamp;
  - then every transaction in order against a block-local UTXO view (structure, signatures, unspent inputs, ownership, maturity, inputs ≥ outputs, valid output addresses), so outputs created earlier in the block are spendable and double spends inside the block are caught;
  - finally stake registrations and PoS eligibility.
- State (UTXO set and stakes) changes only after every check passes. A rejected block leaves the chain untouched.

**Callers**
- New blocks use `_addMinedBlockInternal`. `replaceChain`, startup load and `isChainValid` all replay the chain from genesis through `_replayChain`, which calls `_connectBlock`.
- Startup now fully revalidates the stored chain and fails with `invalid stored chain: …`.
- `replaceChain` re-admits pending and orphaned transactions that are still valid on the new chain.
- Mempool admission shares `_checkInputs` with block validation.

**UTXO set**
- New `src/blockchain/UtxoSet.ts` indexes unspent outputs by outpoint, with a per-address index. Each entry records its block height, a coinbase flag and the creating transaction's timestamp.
- This replaces the per-address arrays and the txid index. `hasValidTransactions`, `updateUTXOSet`, `findTransaction` and the duplicated checks in `isChainValid` and `replaceChain` are gone.
- `calculateNewDifficulty` and `getMedianTimePast` now delegate to their `…ForChain` variants, so each rule has one implementation.

**Coin selection**
- Staking and stake-block coin selection skip outputs already claimed by pending transactions. Before, a coinstake could re-spend the coins of a pending stake transaction in the same block, which went undetected.

**Wall clock**
- Inside validation, `Date.now()` is now used only for the future-timestamp limit. The remaining uses are block production and the node-local stake registry (TASK-0011).

**Side effects on other findings**
- **F-009 closed:** a coinstake must satisfy inputs ≥ outputs like any transaction, so its change output can't create money. PoS block weight is now bounded by coins the staker really owns.
- **F-006 partly fixed:** startup and chain replacement rebuild stake state from the chain. Node-local `stake()`/`unstake()`/slashing remain until TASK-0011.
- **Coinbase rule unchanged:** the coinbase still has to equal the reward exactly; it doesn't use "≤ subsidy + fees" yet. Fees exist (inputs − outputs) but are burned until TASK-0018.

**Tests**
- New `src/__tests__/integration/BlockValidation.test.ts`:
  - a double spend inside a block is rejected;
  - an output created earlier in the same block can be spent;
  - the same valid chain is accepted, and the same invalid block rejected with the same reason, by add-block, `replaceChain` on a fresh node, and startup load (bad block written to disk directly);
  - the chain stays usable after a rejection.
- `ConsensusAttacks`:
  - F-005 and F-006 are now normal tests;
  - new F-009 test: an inflated coinstake is rejected with `output amounts exceed input amounts`;
  - F-007 still fails on its assertion.
- The miner integration tests reopen with the options they mined with, because stored chains are revalidated.
- Two legacy staking unit tests were adjusted to leave enough unclaimed coins.
- `npm test`: 10 suites, 204 tests, about 6 s.
