# TASK-0053: Blocks and undo data on disk, not in memory: memory and chainstate don't grow with the chain

Status: done
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
2. **The database is the chain state** (done, bff2ca9): it replaces `chainstate.json` and the in-memory undo data, txid index and address index.
3. **Headers in memory, blocks on disk** (done): the block tree from the database, block contents read from the block files when needed; startup reads no blocks.

## Acceptance criteria

- [x] Heap after startup grows with the UTXO set and the block index, not with the size of all blocks: measured at two chain lengths.
- [x] The chainstate no longer holds undo data; reorgs read it from disk.
- [x] Startup doesn't read every block when a chainstate is present.

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

**Step 3: headers in memory, blocks on disk**
- **The block tree:** it holds `ChainEntry` objects: hash, parent hash (the parent's string, so each hash is in memory once), height, timestamp, `bits`, type, cumulative work, tie-break and invalid flag. Startup builds it from the database's block records. Blocks in the block files without a record, from a stop between the two writes of a new block, are read and recorded.
- **Reading blocks:** only the tip block keeps its transactions in memory. Disconnecting reads the new tip from the block files. Activating a branch reads each block as it connects. `getBlockAt`, `getBlockByHash`, `findTransaction` and `getBlocksAfter` read from the files, and `getChain()` reads every active block, for tests and tools only.
- **New methods:** `getHeight`, `getHeader`, `hasTransaction` and `getPendingTransaction`. `findLastStakedBlock` is a query on the database's producer column instead of a walk through 10,000 blocks' transactions.
- **Retarget and validation:** `requiredBits`, the median time and validation read only header fields (`BlockHeader`: hash, timestamp, `bits`, type), so entries and blocks both work.
- **Callers:**
  - The API reads the blocks of one page: the block list, the block page, and the wallet history, which reads each block once per request. The address page uses header times.
  - P2P takes the genesis hash from the header, checks announced txids with `hasTransaction`, and serves requested transactions from the mempool.
- **Tests:**
  - `Blockchain.test.ts` runs on real files in a temp dir per test instead of mocking `fs` and `protobufjs`.
  - A new `ChainDatabase.test.ts` test counts block reads during a start: genesis, to check it, and the tip. With startup reading all blocks again, it fails.

## Outcome

Measured at 16,000 blocks, one signed payment per block (`npm run scale`, plus a script that drops one structure at a time from a started node's heap):

| | Before (TASK-0052) | After |
| --- | --- | --- |
| Started node's heap | 56 MB | 20.4 MB (9.9 MB at 8,000 blocks) |
| Heap per block, besides unspent outputs | about 2.9 KB: block contents 1,178 B, block objects, undo data 372 B, address index 412 B, txid index 217 B, stake modifier 88 B | about 475 B: tree entry 176 B, `BlockStore` index 211 B, stake modifier 88 B |
| Start | 1,155 ms (reads and indexes every block) | 222 ms (reads 2 blocks) |
| Accepting a block | 0.26 to 0.39 ms | 0.57 to 0.89 ms (one database transaction each) |
| `--reindex` | about 0.6 s | 11.5 s (one database transaction per block) |
| On disk | `chainstate.json` | `chain.db`, 22 MB |

At a year of 30-second blocks (about 1,000,000), the per-block part comes to about 475 MB instead of about 2.9 GB, plus the unspent outputs, and the database holds the rest on disk.

**Runs (step 3)**
- `npm run check`: 38 suites, 395 tests, lint clean.
- `npm run smoke` on Node 26 and on Node 22.
- `npm run e2e` (height 27, 7 PoS blocks), `npm run docker:check`, `npm run network:check`.
- A regtest data dir written by step 2 (`main` at bff2ca9, 20 PoW blocks and 1 staked) opened by this version: `chain database at height 21; validated 0 newer block(s)`, without warnings. The database format is unchanged, so step 2's databases load as they are.
- Removing the change that keeps startup from reading every block makes the read-count test fail.

- **Rebuilds and sync:** `--reindex`, the first start after this upgrade and syncing a new node pay about 0.7 ms per block for the database, so about 12 minutes at 1,000,000 blocks. Writing many blocks per transaction would cut that.
- **`BlockStore` index:** its in-memory index (entries plus hash and height maps, 211 B per block) duplicates the tree's hashes. The file positions could live in the tree entries or the database.
- **Stake modifiers:** they stay in memory as an array (88 B per block), and could come from the database for the few blocks a reorg needs.
- **Node 22:** it prints one `ExperimentalWarning` for `node:sqlite` at startup; Node 24+ doesn't.

