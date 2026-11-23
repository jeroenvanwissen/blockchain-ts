# TASK-0004: Mine PoW blocks inside the node

Status: pending
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

- [ ] `npx tsx src/index.ts --mine --data-dir <tmp>` produces blocks continuously.
- [ ] After a restart the node continues from the stored height.
- [ ] A second node connected with `--peers` reaches the same tip.
- [ ] A rejected block doesn't stop the miner.

## Validation

`npm run smoke` extended with a mining check (height > 0 after N seconds), plus `npm test`.

## Notes

Owner decision: keep or drop the standalone miner (assessment open questions).
