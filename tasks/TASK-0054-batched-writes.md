# TASK-0054: Batched chain-database writes: rebuilding and syncing pay for a transaction per batch, not per block

Status: done
Priority: P1
Size: medium
Depends on: TASK-0053
Source: TASK-0053 outcome (2026-11-25)

## Why

Since TASK-0053 every connected block is its own SQLite transaction. That is right for a block arriving on its own, but a node that connects many blocks in a row pays the transaction cost for each:
- `--reindex`, the first start after an upgrade, and any rebuild (other version or rules) connect every stored block.
- A new node syncing receives up to 200 blocks per `BLOCKS` message and accepts them one by one (`addMinedBlock`).

Measured on 4,000 stored blocks with one signed payment each, rebuilding with N blocks per transaction (an experiment that patched `ChainDb.transaction`):

| Blocks per transaction | Rebuild | Database writes |
| --- | --- | --- |
| 1 (now) | 0.74 ms/block | 1,581 ms |
| 10 | 0.59 ms/block | 1,057 ms |
| 100 | 0.45 ms/block | 595 ms |
| 1,000 | 0.42 ms/block | 503 ms |
| all | 0.42 ms/block | 482 ms |

At 1,000,000 blocks the difference is about 12 minutes against about 7. A CPU profile of the batched rebuild shows the rest: the database statements (0.14 ms per block), signature checks (0.09 ms), and reading blocks (each block is read and parsed twice during a rebuild, and its file is opened for every read).

## Direction

- One transaction for a group of block operations (accepting a block with any reorg it causes, a `BLOCKS` batch, a rebuild), committed when the group ends and every so many blocks, so a long rebuild doesn't hold everything in one transaction.
- The in-memory state must keep matching the database. If a write or the commit fails, what wasn't committed is rolled back and the in-memory state is put back to the database's.
- A rejected block (invalid) ends the group normally: the blocks before it stay.

## Acceptance criteria

- [x] A rebuild commits once per batch of blocks instead of once per block; measured with `npm run scale` before and after.
- [x] A `BLOCKS` batch from a peer is accepted under one lock and one transaction; blocks before a rejected one stay connected.
- [x] Accepting a block that causes a reorg changes the database in one transaction.
- [x] A failed write or commit anywhere in a batch leaves memory and database at the last commit (tested).
- [x] A crash in a rebuild loses at most the blocks since the last commit: the next start validates them again.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e` (sync and reorg paths), `npm run scale` before and after.

## Outcome

**Batches** (`Blockchain._writeBatch`)
- Every public method that changes the chain writes the database in one transaction: `addMinedBlock` (one block, a reorg included), the new `addBlocks` (a `BLOCKS` batch from a peer, under one lock), `replaceChain`, and startup (loading, rebuilding and activating stored blocks).
- A batch commits when it ends and after every `CHAIN_DB_BATCH_BLOCKS` (1,000) blocks written, counting blocks recorded and blocks connected or disconnected. A long rebuild never holds everything in one transaction, and a crash loses at most the blocks since the last commit: the next start validates them again.
- A rejected block ends the batch normally: the blocks before it stay, as before.
- A failed write, read or commit throws a `StorageError`. The batch rolls back what wasn't committed, forgets the tree entries the rolled-back writes added (the blocks stay in the block files; the next start records them), and reloads the active chain, UTXO set and stake modifiers from the database (`_restoreFromDb`). `_connectTip` no longer puts the UTXO set back itself. Every write goes through `storing()`, so a failure can't pass for a rejected block.
- `ChainDb` has `begin`, `commit` and `rollback`. Inside a batch, `transaction()` (what `connect` and `disconnect` use) is part of the batch's transaction instead of its own.
- **Why no savepoints:** a first version nested each `connect` as a savepoint in the batch. SQLite then keeps a sub-journal, a temp file by default, and every transaction paid for creating and removing it. Single blocks became slower than before this task (0.77 to 0.92 ms against 0.52 at 4,000 blocks), and `connect` cost 0.20 ms instead of 0.05. Savepoints aren't needed, because a failed write rolls back the whole batch.
- **Sync** (`P2PServer._handleBlocks`): a `BLOCKS` message is parsed, then added with one `addBlocks` call. A malformed or rejected block still stops the batch, and the blocks before it stay.
- **Storage failures no longer score the peer:** before, a failed write while adding a peer's block (a full disk) was logged as an invalid block and scored the peer 50. Now it logs a warning (`Could not store a block from a peer`) and the peer isn't scored, for `BLOCK` and `BLOCKS` alike.
- **Startup:** a failed start closes the database (the constructor throws, so nobody else could).
- **Removed:** the unused `lastBlockTime` field.
- **`npm run scale`** also measures a sync: the built chain into a new node, in batches of 200 blocks, as a peer sends them.

**Measured** with `npm run scale` at 16,000 blocks, the code before this task and after, run back to back:

| | Before | After |
| --- | --- | --- |
| `--reindex` | 10.8 s (0.68 ms per block) | 6.8 s (0.43 ms per block) |
| Sync into a new node | 0.62 ms per block | 0.48 ms per block |
| Accepting single blocks | 0.58 to 0.92 ms | 0.62 to 0.89 ms |
| Start from the chain database | 224 ms | 245 ms |

At 8,000 blocks, in two alternating runs each: `--reindex` 4.7 and 5.4 s before, 3.0 s both times after; sync 0.58 and 0.66 ms per block before, 0.41 and 0.45 after.

What a synced block costs now (4,000 blocks, timed per part): validation 0.18 ms (mostly signature checks), appending to the block files 0.095 ms, database writes 0.05 ms, the commit 0.03 ms (spread over 200 blocks). The block-store costs are written down in TASK-0055.

**Found on the way, not changed:** the time to accept a single block grows with the database, before and after this task (0.5 to 0.9 ms from 0 to 16,000 blocks). All of the growth is in the commit (0.24 to 0.38 ms from 4,000 to 16,000 blocks). With `PRAGMA synchronous = OFF` it stays flat, so it comes from the fsyncs of SQLite's WAL checkpoints. The node keeps `synchronous = NORMAL` for durability. Single blocks arrive one every 16 to 30 s, and batches spread the commit over many blocks.

**Tests**
- `ChainDb.test.ts`: a batch's writes are invisible to another connection until `commit`, and gone after `rollback`.
- `ChainDatabase.test.ts` (4 new):
  - a sync batch commits once and keeps the blocks before a rejected one;
  - a failed write and a failed commit each leave memory and database at the last commit, the same blocks are added again afterwards, and a restart is consistent;
  - every accepted block, including the one that reorganizes, is one commit;
  - a rebuild commits every `CHAIN_DB_BATCH_BLOCKS` blocks, and after a rebuild that fails part way the next start continues from the last commit, validating only the blocks after it.
- `PeerPolicy.test.ts`: a block the node couldn't store, sent as `BLOCK` and in `BLOCKS`, doesn't count against the peer.
- Each new test fails when its code is broken on purpose: no reload after a rollback, no commits during a batch, scoring storage failures.

**Runs**
- `npm run check`: 38 suites, 401 tests, lint clean.
- `npm run smoke` on Node 26 and on Node 22.
- `npm run e2e`: height 26, 6 PoS blocks; the partition's reorg came in a sync batch.
- `npm run docker:check` and `npm run network:check`.
