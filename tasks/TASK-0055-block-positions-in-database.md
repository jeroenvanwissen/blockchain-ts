# TASK-0055: Block positions in the chain database: one block index instead of two

Status: done
Priority: P2
Size: medium
Depends on: TASK-0053
Source: TASK-0053 outcome (2026-11-25)

## Why

After TASK-0053 two indexes of all stored blocks are in memory:
- the block tree (`ChainEntry`, about 176 B per block), built from the chain database;
- `BlockStore`'s index (entries plus hash and height maps, about 211 B per block), built from `index.dat`, to find a block's file and offset.

Both hold every block's hash. At 1,000,000 blocks the `BlockStore` index is about 211 MB of the node's heap, nearly half of what grows with the chain.

## Direction

- Record each block's file number, offset and length in the chain database (or in the tree entries), so a block is found without `BlockStore`'s in-memory maps.
- `index.dat` stays the block files' own index, so the database can still be rebuilt from the block files (`--reindex`); the node only needn't keep it in memory.
- Measure the heap of a started node before and after (`npm run scale`, and dropping one structure at a time).

Found while profiling TASK-0054, in the same code:
- `BlockStore.appendBlock` opens, writes and closes two files per block (`appendFileSync` on the `blk*.dat` file and on `index.dat`): about 0.095 ms of the 0.40 ms a synced block costs.
- `_readBlockAt` opens and closes the block file for every read; during a rebuild that is about 0.03 ms per block.
- A rebuild reads and parses every block twice: once to record it (`_addStoredBlock`), once to connect it (`_activateBranch`).

## Decision

`index.dat` is removed instead of kept next to the positions in the database (2026-11-25). The direction kept it so the database could be rebuilt from the block files. A rebuild reads and validates every block anyway, so a scan of the block files serves it just as well, and the same scan finds the blocks stored after the database's last one at startup. Keeping `index.dat` would have meant a third copy of every block's position, written for every block (one of the two file writes per stored block) and read only by a rebuild.

## Acceptance criteria

- [x] A started node keeps one index of the stored blocks in memory; measured at two chain lengths.
- [x] Startup still checks the block files against the database and rebuilds when they disagree.

## Validation

`npm run check`, `npm run smoke`, `npm run scale` before and after.

## Outcome

**One index in memory**
- The chain database records where each block is in the block files (file, offset, length; `CHAIN_DB_VERSION` 2), and each `ChainEntry` in the block tree holds it. `_readBlock` reads a block at its entry's position.
- `BlockStore` keeps nothing per block: its in-memory index (entries, hash and height maps) and `index.dat` are gone. It has `append` (returns the position), `read(position)`, `contains(position)`, `scan(after?)` and `close`. It keeps the file it appends to open, and up to 8 files open for reading, instead of opening and closing two files for every stored block and one for every read.
- A failed append is cut off the file again, so the next block follows the last complete one. Before, an incomplete block left by a full disk stayed, later blocks went after it, and the next start's scan cut them all off.
- Reads hash the block again: a damaged block, or another block where the database says it is, is a `StorageError`, never an invalid block. Before, a stored block that failed to decode during a reorg was marked invalid.

**Startup**
- Every database record is checked against the block files' sizes. An active block the files can't hold means a rebuild; a side block's record is forgotten (deleted). Genesis is read and hashed, as before, and so is the tip; if the tip can't be read or isn't the block the database says, the database is rebuilt.
- Then the block files are scanned from the end of the last block the database records: blocks stored after it (a stop before their records were committed) are recorded and connected. The scan also cuts an incomplete block off the end of a file, which `index.dat`'s recovery did before.
- A rebuild scans every stored block once. Each block is recorded and, when its branch beats the tip, connected with the block in hand (`_addStoredBlock` → `_activateBranch(entry, block)`), the way blocks from peers are. Before, a rebuild read and parsed every block twice: once to record it, once to connect it. `_acceptBlock`'s reorg path also connects the new block in hand instead of reading it back.
- The first start after this upgrade rebuilds the database (another version) and removes `index.dat`. `ChainDb.reset` now drops and recreates the tables, because a version-1 `blocks` table lacks the new columns.

**Measured**
- Heap of a started node, dropping one structure at a time (a script on chains built with one payment per block):

  | | 8,000 blocks before | 8,000 after | 16,000 before | 16,000 after |
  | --- | --- | --- | --- | --- |
  | Started node | 10.4 MB | 9.6 MB | 20.5 MB | 18.9 MB |
  | `BlockStore` | 130 B/block | 0 | 132 B/block | 0 |
  | Block tree | 255 B/block | 280 B/block | 256 B/block | 280 B/block |
  | Stake modifiers | 87 B/block | 88 B/block | 88 B/block | 88 B/block |
  | UTXO set | 802 B/block | 806 B/block | 820 B/block | 823 B/block |

  The `BlockStore` index was 130 B per block, not the 211 B estimated in TASK-0053. The positions add 24 B to each tree entry, so a block costs about 106 B less: about 100 MB at 1,000,000 blocks.
- `npm run scale`, the code before and after run back to back:

  | | 16,000 before | 16,000 after | 8,000 before | 8,000 after |
  | --- | --- | --- | --- | --- |
  | `--reindex` | 6.8 s | 5.8 s | 3.2 s | 2.6 s |
  | Sync into a new node | 0.49 ms/block | 0.44 ms/block | 0.44 ms/block | 0.35 ms/block |
  | Start from the chain database | 234 ms | 225 ms | 101 ms | 101 ms |

- The block store alone, 4,000 blocks from the scale chain: appending 74 to 86 µs per block before, 11 to 14 µs after; reading 37 to 40 µs before, 20 to 22 µs after (both include protobuf encoding or decoding).

**Tests**
- `BlockStore.test.ts`, rewritten (13): append and read by position across a restart; scan in order, and after a given block; no per-block state; `contains`; reads the files can't serve; three kinds of incomplete block cut off the end so the next block is found; a failed write cut off; a new file past `MAX_BLOCK_FILE_SIZE`, reading from 12 files with at most 8 open; scanning several files; an unreadable block skipped; a new directory.
- `ChainDb.test.ts`: positions are kept, and a block recorded twice takes the new position and keeps its status; `forget` never removes an active block; `reset` rebuilds a table from a version with other columns.
- `ChainDatabase.test.ts` (5 new): a rebuild reads each stored block once; a version-1 database with `index.dat` and `chainstate.json` is rebuilt and the files removed, and the next start validates nothing; a side block whose data is gone is forgotten without a rebuild, while an active one means a rebuild; a damaged tip means a rebuild; a damaged block that still decodes is a `StorageError`. The start test now counts the blocks parsed: genesis and the tip.
- Each new test fails when its code is broken on purpose: connecting a stored block by reading it again, no cut after a failed write, no forgetting, failing the start on an unreadable tip, a reset that only deletes rows, checking only the stored hash field on read, no bounds check of the records.

**Runs**
- `npm run check`: 38 suites, 407 tests, lint clean.
- `npm run smoke` on Node 26 and on Node 22.
- `npm run e2e` (height 27, 7 PoS blocks), `npm run docker:check` (height 16, restart from the volume), `npm run network:check` (height 14).
- A data dir written by `main` (594f5dd, 8,000 blocks, version-1 database and `index.dat`) opened by this version: rebuilt in 3.1 s, `index.dat` removed, same height and tip; the next start took 128 ms and validated nothing.

