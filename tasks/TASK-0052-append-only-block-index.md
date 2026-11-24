# TASK-0052: Append-only block index: storing a block costs the same at any height

Status: done
Priority: P1
Size: small
Depends on: none
Source: scale measurement (2026-11-24)

## Why

`BlockStore.appendBlock` writes the block to its `blk*.dat` file, then rewrites all of `index.dat`: every entry, encoded and verified as one protobuf message. The cost of storing a block grows with the chain.

Measured on a chain of 8,000 blocks with one signed payment each (built in-process, CPU-profiled):
- `_saveIndex` takes about 75% of the time to accept a block at height 8,000.
- Accepting a block costs 0.54 ms per block over blocks 0 to 2,000 and 1.77 ms over blocks 6,000 to 8,000, growing by about 0.2 ms per 1,000 blocks of height.

Extrapolated: about 20 ms per block at 100,000 blocks (about 5 weeks of 30-second blocks), about 200 ms at 1,000,000 (about a year). A node syncing from scratch rewrites the index once per block, so it writes on the order of N² bytes: roughly 400 GB of index data for 100,000 blocks.

A crash bug in the same code: the next block's byte offset is the stored `currentFileSize`, not the file's actual size. If the node stops after appending a block but before saving the index, the block's bytes stay in the file without an index entry. The next block is appended after them but indexed at their offset, so reading it returns the wrong block or fails.

## Acceptance criteria

- [x] Storing a block appends one fixed-size record to `index.dat` instead of rewriting it; the time to accept a block no longer grows with the size of the index (same measurement).
- [x] The offset of each block comes from the actual size of its file.
- [x] After a crash at any point of an append, the next start indexes every complete block in the files and drops a torn record or a torn block at the end.
- [x] A damaged index (bad checksum, an entry past the end of its file) is rebuilt from the block files.
- [x] An `index.dat` from before (one protobuf message) is converted at the first start.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`, the scale measurement before and after (`npm run scale`).

## Outcome

**Format**
- `index.dat` is an 8-byte header (`BTSIDX`, version 1), then one 52-byte record per stored block, in the order they were stored: the hash (32 bytes), height, file number, byte offset and data length (uint32 LE each), then a CRC-32 of those 48 bytes (`zlib.crc32`).
- `appendBlock` appends the block to its `blk*.dat` file, then its record to `index.dat`; nothing is rewritten. The protobuf index schema is gone from `protoSchemas.ts`.

**Startup brings the index in line with the block files** (`BlockStore._loadIndex`)
- An `index.dat` without the header (the protobuf format from before) is rebuilt from the block files (`converting the block index to the append-only format`, info).
- A missing index next to block files, a record with a bad checksum, or one pointing past the end of its file means the index is rebuilt from the block files (warning). The rebuilt index is written to a temporary file, then renamed.
- An incomplete record at the end of `index.dat` is cut off (warning).
- Blocks in the files after the last indexed one, left by a stop between the two writes, are indexed (`indexed N stored block(s) the block index was missing`, warning). The scan starts at the end of the last indexed block, so a normal start reads nothing.
- A torn block at the end of a block file (length prefix or data cut short, or zeroes) is cut off the file, so later blocks are stored where a scan finds them. A complete block that can't be decoded is skipped, and the scan goes on to the next one.
- New blocks go to the last block file at its actual size, never at an offset read from the index. This fixes the crash bug in the Why section.

**Tests**
- `src/__tests__/integration/BlockStore.test.ts` (13 tests, real files) replaces the unit test that mocked `fs` and `protobufjs`. It keeps the old cases (by hash, by height, in order, after a restart, a rebuild) and adds:
  - one record per block, with the earlier bytes unchanged
  - a stop before the index record
  - a torn index record
  - torn block files (cut short, a cut length prefix, zeroes)
  - blocks in a later file
  - a damaged record, and a block file shorter than the index says
  - a missing index
  - the old protobuf format
- Without the offset fix, the index recovery or the truncation, 2, 6 and 3 of them fail.
- The `P2PServer` unit test built its chain with a mocked `fs.existsSync` that said every file exists. Before, that ended in suppressed warnings. Now it builds the chain against an empty data dir.

**Measured** with what is now `npm run scale` (one signed payment per block, simulated clock, time in `addMinedBlock`; before: `main` at d3975e3):

| Blocks | Before | After |
| --- | --- | --- |
| 0 to 4,000 | 1.22 ms/block | 0.26 ms/block |
| 4,000 to 8,000 | 2.79 ms/block | 0.33 ms/block |
| 8,000 to 12,000 | 5.09 ms/block | 0.36 ms/block |
| 12,000 to 16,000 | 6.97 ms/block | 0.39 ms/block |
| `index.dat` at 16,000 | 1,231 KB | 813 KB |
| Start from the chainstate at 16,000 | 1,681 ms | 1,155 ms |

The rest grows by about 0.01 ms per 1,000 blocks instead of 0.5 ms, and not in the block store, where an append is now constant work. Startup still reads every block (TASK-0053).

**Scale script:** `npm run scale [-- --blocks <n>] [--batch <n>]` (`src/scale.ts`) runs this measurement so it can be repeated for TASK-0053. It builds the chain in a temp dir, reports per batch, then starts from the chainstate and with `--reindex` after dropping the chain it built, so the heap shown after a start is a started node's.

## Runs

- `npm run check`: 37 suites, 385 tests, lint clean. `npm run smoke`: pass. `npm run e2e`: pass (height 27, 7 PoS blocks), no warning or error in its output, including its SIGKILL step.
- With real node processes:
  - A regtest data dir written by `main` (d3975e3, protobuf index) opened by this version: `converting the block index to the append-only format`, then `Chain loaded: height 20` with the same tip, and no warning.
  - A node mining on the main parameters, killed with SIGKILL 8 times at random moments (3 to 8 s after each start): it went from height 0 to 33, and every start loaded without a warning or an error. A clean start and a `--reindex` start agree on height 33 and the tip.

