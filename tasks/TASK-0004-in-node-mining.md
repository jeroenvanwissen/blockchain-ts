# TASK-0004: Mine PoW blocks inside the node

Status: done
Priority: P0
Size: medium
Depends on: TASK-0001, TASK-0002
Source: F-003, old E3

## Why

No component produces a block the node accepts. `src/index.ts` only starts `StakingService`. The standalone miner pays a 100-coin reward against a consensus value of 10 (`src/blockchain/Miner.ts:162`). It takes difficulty and block index from its own stale `Blockchain` instance (`Miner.ts:168,238`), hardcodes `ws://localhost:5001` (`Miner.ts:72`) and can lose its reply to `once('message')` (`Miner.ts:109`). Live run: every mined block was rejected with `invalid coinbase reward amount`.

## Scope

- In-node miner behind a `--mine` flag. It builds the job from the node's own tip: height, required difficulty, reward from `src/config.ts`, mempool transactions.
- Hashing runs in the worker thread. Restart the job when the tip changes. Submit through the normal block path and broadcast through `P2PServer`.
- Remove the standalone miner (`src/mine.ts`, the WebSocket client in `Miner.ts`, `npm run mine`) unless the owner wants it kept behind a proper block-template message.

Excluded: header and difficulty redesign (TASK-0007, TASK-0008).

## Acceptance criteria

- [x] `npx tsx src/index.ts --mine --data-dir <tmp>` produces blocks continuously.
- [x] After a restart the node continues from the stored height.
- [x] A second node connected with `--peers` reaches the same tip.
- [x] A rejected block doesn't stop the miner.

## Validation

`npm run smoke` extended with a mining check (height > 0 after N seconds), plus `npm test`.

## Notes

Owner decision: keep or drop the standalone miner (assessment open questions).

## Outcome

**Hashing**
- `Block.powPrefix()` returns the hashed block data up to the nonce. `Block.hashWithNonce()` hashes `prefix + nonce + '}'`, byte-identical to the previous `calculateHash`, so stored blocks keep their hashes.
- The worker (`miningWorker.cjs`) receives only the prefix and the difficulty, so it can't serialize a block differently from validation. It stops at `MAX_BLOCK_NONCE` (the nonce is stored as `uint32`); the miner then builds a fresh template.

**Blockchain**
- New `createBlockTemplate(address, timestamp)`, which `minePendingTransactions` now also uses.
- New `getNextBlockMinTimestamp()`: the minimum block interval combined with median time past.

**Miner**
- Rewritten as an in-node `Miner`, enabled with `--mine` in `src/index.ts`.
- It waits for the earliest valid timestamp, hashes in the worker, and abandons the job when the tip changes (checked every 500 ms).
- After a rejected block it waits `MINER_RETRY_DELAY` and continues.
- It stops itself when PoW blocks are no longer accepted.
- Mined blocks are broadcast to peers.

**Standalone miner removed** (the default from the open question): `src/mine.ts`, `npm run mine`, and the WebSocket client in `Miner.ts`.

**P2P**
- Logs `Synced chain from peer` and `Accepted block N from peer`.
- Ignores blocks it already has. Before, every block echoed back by a peer logged `Block created too quickly`.

**Tests**
- `src/__tests__/integration/Miner.test.ts`, with a real worker thread and real files:
  - mines valid blocks that persist across reopen;
  - keeps going after a rejected block;
  - stops after the PoW phase;
  - abandons a job when another block extends the tip.
- `npm run smoke` now covers the whole flow:
  - node A mines block 1;
  - node B syncs to A's tip on connect;
  - B accepts A's block 2 live;
  - A restarts with `Chain loaded: height N, tip …` matching its last mined block;
  - no node logs any error.
  It takes about 31 s. Removing the known-block guard makes it fail, as intended.
- Fixed a pre-existing flaky test, `Validator Selection › should produce different results for different slot numbers` (about 3% failure rate). It now keeps the time since the last block constant and checks 1000 slots.

**Known limits**
- A node that misses a relayed block only catches up when it reconnects (F-013, TASK-0013).
- Difficulty can't rise because of the 30 s minimum interval (F-008, TASK-0008).
- A pending stake transaction still turns PoW blocks into "PoS" blocks that get rejected (F-007). The miner keeps retrying instead of stopping.
