# TASK-0053: Blocks and undo data on disk, not in memory: memory and chainstate don't grow with the chain

Status: in-progress
Priority: P1
Size: large
Depends on: TASK-0052
Source: scale measurement (2026-11-24)

## Why

The node keeps the whole chain in memory: `Blockchain.chain` holds every block with its transactions, `_undo` the outputs every block spent, and startup reads every stored block (`BlockStore.loadAllBlocks`). The saved chainstate (`blocks/chainstate.json`) holds the undo data of every block and is rewritten whole every 500 blocks and at shutdown.

Measured on a chain of 8,000 blocks with one signed payment each:
- The heap grows by about 5 KB per block (16 MB at 4,000 blocks, 41 MB at 8,000).
- The chainstate grows by about 0.5 KB per block (4.1 MB at 8,000 blocks).

Extrapolated to a year of 30-second blocks (about 1,000,000): about 5 GB of heap, more than Node's default heap limit on most machines, and a chainstate of about 500 MB, near the largest string `JSON.stringify` can produce.

## Direction

- Keep the block index in memory (hash, height, parent, chain work, file position, header fields the retarget, the median time and the stake modifier need), not block contents. Read blocks from `blk*.dat` when needed (sync replies, the API, reorgs).
- Store undo data per block on disk (like `rev*.dat` files) and read it when disconnecting a block.
- The chainstate holds the UTXO set and the per-block stake modifiers, not the undo data.
- The indexes derived from blocks (txid index, `AddressIndex`) need a plan too: rebuilt from blocks at startup they cost time and memory proportional to the chain.

## Decision

Storage: Node's built-in SQLite (`node:sqlite`), owner's choice (2026-11-24). The block files stay the source of truth; the database holds what is derived from them and can be rebuilt (`--reindex`).

## Steps

1. **`ChainDb`** (done, c66cd51): `blocks/chain.db`, the block tree and, for the active chain, the UTXO set, undo data, stake modifiers, the txid index and address histories; one transaction per connected or disconnected block.
2. **The database is the chain state** (done): it replaces `chainstate.json` and the in-memory undo data, txid index and address index.
3. **Headers in memory, blocks on disk**: the block tree from the database, block contents read from the block files when needed; startup reads no blocks.

## Acceptance criteria

- [ ] Heap after startup grows with the UTXO set and the block index, not with the size of all blocks: measured at two chain lengths.
- [ ] The chainstate no longer holds undo data; reorgs read it from disk.
- [ ] Startup doesn't read every block when a chainstate is present.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`, `npm run scale` before and after.

## Progress

**Step 2: the database is the chain state**
- **Writes:** `_connectTip` stores a new tip block in the block files first, then writes the block's changes to the database in one transaction. `_disconnectTip` undoes them the same way. If a write fails, the in-memory UTXO set is put back and a `StorageError` is thrown, which never marks a block invalid.
- **Startup:** it takes the state at the database's tip (UTXO set and stake modifiers), then activates the best valid stored branch the way blocks from peers are (`_activateBest`). Only blocks stored after the tip are validated: `chain database at height N; validated M newer block(s)`.
- **Rebuilds:** a database from another version, built under other rules (TASK-0051's check moved here), unreadable, or out of line with the block files is rebuilt from genesis, as with `--reindex`. A rebuild removes the old `chainstate.json`.
- **Invalid marks:** they're stored, so an invalid stored branch isn't validated again at every start.
- **A failing branch:** when a branch with more work turns out to hold an invalid block, the valid part before that block now stays active if it beats the chain it replaced, instead of the previous chain coming back. Blocks arrive one by one, so at runtime the valid part has already been activated, or doesn't beat the tip. The change matters at startup, where it saves validating the valid part twice.
- **Removed:** `chainstate.ts`, `saveChainstate` (replaced by `close`), `CHAINSTATE_INTERVAL`, and the in-memory `AddressIndex` class (`addressFlows` and `mergeHistories` remain).
- **Output order:** `UtxoSet.forAddress` returns outputs by height, then txid and output index, the same however the set was built. Before, the order depended on insertion, and a restarted node listed an address's outputs differently from a running one.
- **Tests:** `ChainDatabase.test.ts` replaces `Chainstate.test.ts` (8 tests). It covers a start with nothing to validate, a block stored after the tip, a stored better branch at startup, a reorg below the start point, rebuilds (`--reindex`, and a missing, unreadable or other-version database), the rules change without re-validation at the next start, removing `chainstate.json`, and a failed write. `AddressHistory.test.ts` checks the stored histories against a full replay. The unit tests that mock `fs` use `dbPath: ':memory:'`.
- **Measured** at 16,000 blocks with `npm run scale` (and a script that drops one structure at a time from a started node's heap):

  | | TASK-0052 | Step 2 |
  | --- | --- | --- |
  | Accepting a block | 0.26 to 0.39 ms | 0.60 to 0.93 ms (one database transaction each) |
  | Start from saved state | 1,155 ms | 1,077 ms |
  | `--reindex` | about 0.6 s | 11.4 s (one transaction per block; batching could bring it down) |
  | Started node's heap | 56 MB | 42 MB |

  Still in memory per block: block contents 1,272 B, the block-tree entry 320 B, the stake modifier 88 B.
- **Runs:**
  - `npm run check`: 38 suites, 394 tests, lint clean.
  - `npm run smoke` on Node 26 and on Node 22.
  - `npm run e2e` (height 26, 6 PoS blocks), `npm run docker:check`, `npm run network:check`.
  - A regtest data dir written by `main` (07a2e26, with `chainstate.json`) opened by this version: the database was built from its 20 blocks, `chainstate.json` was removed, and the next start began from the database with nothing to validate, at the same height and tip, without warnings.

