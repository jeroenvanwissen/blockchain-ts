# TASK-0055: Block positions in the chain database: one block index instead of two

Status: pending
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

## Acceptance criteria

- [ ] A started node keeps one index of the stored blocks in memory; measured at two chain lengths.
- [ ] Startup still checks the block files against the database and rebuilds when they disagree.

## Validation

`npm run check`, `npm run smoke`, `npm run scale` before and after.
