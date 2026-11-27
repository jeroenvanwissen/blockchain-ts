# TASK-0067: Storage recovery: damaged database, rollback after a mid-batch commit, damaged block files, peer files

Status: pending
Priority: P2
Size: medium
Depends on: none
Source: F-048, F-049, F-054 (reassessment 3, 2026-11-27)

## Why

- **Damaged chain database (F-048).** `_openDb` checks only the `meta` table (`Blockchain.ts:772-785`). Damage elsewhere surfaces later as an error that doesn't trigger a rebuild, so every start fails. `--reindex` runs `DROP TABLE` on the damaged file and fails too. Only deleting `chain.db` by hand recovers, though README says `--reindex` rebuilds it. In the other direction, any open error, a permissions problem for one, deletes the database and rebuilds from genesis. Both reproduced.
- **Rollback after a mid-batch commit (F-049).** In `_acceptBlock`'s connect path, `_connectTip`'s `_wrote()` can commit before `_addEntry` records the entry. A later StorageError in the same batch then removes the committed tip from the index, and `_restoreFromDb` skips the restore. The UTXO set runs ahead of the database, and later blocks get `unknown parent block` until a restart. After any such rollback the node also stays at the database's tip without re-running fork choice. Reproduced with 1,002 blocks in one batch.
- **Damaged block files (F-054).** A damaged length prefix makes a scan stop and cut off the rest of that file (`BlockStore.ts:190-207`). `--reindex` then destroys every valid block after it: height 50 became 9 (reproduced).
- **Peer files (F-054).** `peers.json` and `banned.json` are written in place (`P2PServer.ts:840`, `:1053`), and a valid-JSON `peers.json` that isn't an array stops every start (`index.ts:133`), both reproduced. One unparseable transaction in `mempool.json` drops them all (`mempoolFile.ts:24`).

## Scope

- Treat a damaged database (SQLITE_CORRUPT / "malformed" from any read at startup) as a reason to rebuild. `--reindex` and a rebuild replace the database file instead of running `DROP TABLE` on it. Only "not a database" or damage leads to deleting; other open errors stop the node with the error.
- Record the entry in the index before the write that can commit (or have `_wrote` take the entry), and re-run `_activateBest` after `_restoreFromDb`.
- A scan doesn't truncate a file at a length prefix that is merely implausible in the middle of a file. It truncates only an incomplete block at the true end. Find the next block again, for example by looking for the next valid frame, or add a per-record marker (a format change for the block files).
- Write `peers.json` and `banned.json` atomically (temp file and rename), and type-check them on load. Load `mempool.json` per transaction, skipping the bad ones.
- Decide the fsync policy (see the reassessment's open question): at least fsync the block files before the database commit that records them.

## Acceptance criteria

- [ ] A database with a damaged page is rebuilt at the next start, and with `--reindex` (tests with an overwritten page).
- [ ] A permissions error on `chain.db` stops the node with that error and leaves the file.
- [ ] A StorageError after a mid-batch commit leaves memory equal to the database (test with `CHAIN_DB_BATCH_BLOCKS` replaced by a small value and a failing write).
- [ ] A damaged length prefix in the middle of a file loses at most that block on `--reindex`.
- [ ] Damaged `peers.json`, `banned.json` or one bad `mempool.json` entry costs only that data, never a start.

## Validation

`npm run check`, `npm run smoke`, `npm run scale` (if the block-file format or fsync changes).
