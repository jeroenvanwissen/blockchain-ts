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

## Acceptance criteria

- [ ] Heap after startup grows with the UTXO set and the block index, not with the size of all blocks: measured at two chain lengths.
- [ ] The chainstate no longer holds undo data; reorgs read it from disk.
- [ ] Startup doesn't read every block when a chainstate is present.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`, `npm run scale` before and after.
