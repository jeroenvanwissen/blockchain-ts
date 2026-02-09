# Task B6: Chunked Block Storage with Index

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `B6`                                 |
| **Status**       | `[ ]`                                |
| **Priority**     | Medium                               |
| **Dependencies** | B5                                   |
| **Branch**       | `feature/b6-chunked-block-storage`   |

**Goal:**
Split blockchain data across multiple fixed-size files (`blk00000.dat`, `blk00001.dat`, ...) with a separate block index file, following the same approach as Bitcoin Core. Prevents unbounded growth of a single data file and enables efficient block lookups.

**Current Problems:**

1. **Single monolithic file:** All blocks stored in one file — grows without bound
2. **Full rewrite on save:** Every new block rewrites the entire chain file
3. **No random access:** Loading a specific block requires parsing the entire file

**Scope:**

```
src/blockchain/
├── Blockchain.ts                       # MODIFY — use BlockStore for persistence
├── BlockStore.ts                       # CREATE — chunked file storage + index
├── __tests__/BlockStore.test.ts        # CREATE — unit tests
├── __tests__/Blockchain.test.ts        # MODIFY — update persistence mocks
src/
├── config.ts                           # MODIFY — add storage constants
proto/
├── blockindex.proto                    # CREATE — protobuf schema for index
```

**Design:**

```
data/blocks/
├── blk00000.dat        # Block data file 0 (up to MAX_BLOCK_FILE_SIZE)
├── blk00001.dat        # Block data file 1
├── ...
└── index.dat           # Block index: block hash/height → file number + byte offset
```

- **Block data files** (`blk*.dat`): Append-only. Each block is serialized with protobuf and written sequentially. When a file exceeds `MAX_BLOCK_FILE_SIZE`, a new file is started.
- **Index file** (`index.dat`): Maps block hash and height to `(fileNumber, byteOffset, dataLength)` for O(1) lookup. Rewritten on update (small file).
- **Append-only writes:** New blocks are appended to the current data file — no rewriting of existing files.

**Implementation:**

1. **Add config constants:** `MAX_BLOCK_FILE_SIZE` (e.g., 128 MB), `BLOCKS_DIR` subdirectory name
2. **Create `BlockStore` class:**
   - `appendBlock(block: Block): void` — serialize and append to current data file, update index
   - `getBlock(hash: string): Block | null` — look up in index, read from data file at offset
   - `getBlockByHeight(height: number): Block | null` — look up by index (block height)
   - `loadAllBlocks(): Block[]` — sequential read of all data files (used on startup for chain validation)
   - `getBlockCount(): number` — return number of indexed blocks
   - `rebuildIndex(): void` — scan all `blk*.dat` files and rebuild index from scratch (recovery)
3. **Index structure:** Array of `{ hash, height, fileNumber, byteOffset, dataLength }` entries, serialized with protobuf
4. **Update `Blockchain`:** Replace `saveBlockchain()` / `loadBlockchain()` with `BlockStore` calls:
   - On new block: `blockStore.appendBlock(block)` instead of rewriting entire file
   - On startup: `blockStore.loadAllBlocks()` to reconstruct chain and UTXO set
   - On chain replacement (P2P sync): clear store and rewrite from new chain
5. **Update tests:** Mock `BlockStore` or use in-memory storage for Blockchain tests

**Proto Schema (draft):**

```protobuf
syntax = "proto3";

message BlockIndexEntry {
  string hash = 1;
  uint32 height = 2;
  uint32 file_number = 3;
  uint64 byte_offset = 4;
  uint32 data_length = 5;
}

message BlockIndex {
  repeated BlockIndexEntry entries = 1;
  uint32 current_file_number = 2;
  uint64 current_file_size = 3;
}
```

**Acceptance Criteria:**

- [ ] `BlockStore` class created with append, lookup by hash, lookup by height, and load all
- [ ] Blocks written to `blk*.dat` files with `MAX_BLOCK_FILE_SIZE` rotation
- [ ] Index file tracks block location `(fileNumber, byteOffset, dataLength)`
- [ ] Index supports lookup by both block hash and block height
- [ ] New blocks are appended (not full rewrite) during normal operation
- [ ] Chain replacement (P2P sync) clears and rewrites store
- [ ] `rebuildIndex()` can recover index from data files alone
- [ ] `Blockchain` uses `BlockStore` — no direct file I/O for block persistence
- [ ] No single-file `blockchain_data.dat` remains in config, source, or tests
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`
- [ ] Lint passes: `npm run lint`

**Verification Commands:**

```bash
npm run build
npm test
npm run lint
# Test: mine blocks beyond MAX_BLOCK_FILE_SIZE — should create blk00001.dat
# Test: delete index.dat, call rebuildIndex() — should recover
# Test: look up block by hash and by height — should return correct block
```
