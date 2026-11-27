# TASK-0058: Side blocks cost their producer: checked before they are stored or relayed

Status: pending
Priority: P1
Size: large
Depends on: TASK-0057
Source: F-037 (reassessment 3, 2026-11-27); "cheap junk side blocks" noted in TASK-0012

## Why

A block that doesn't extend the tip is stored after `_checkSideBlock`. For PoS that checks only transaction count, size, the type for the height and `bits`. The block is appended to `blk*.dat`, recorded in `chain.db` and the block index, never pruned, and relayed to every peer without points (`P2PServer.ts:929-933`). The reproductions showed:
- 20 unsigned 1 MB "PoS" blocks were all stored (+35.7 MB);
- 30 blocks of 720 KB were stored and relayed to a second node (+21.8 MB on each), with no score;
- 73 fake blocks spaced 1 ms apart claimed more work than 149 real ones, because `requiredBits` uses the side branch's own unchecked timestamps. The node disconnected 149 blocks and reconnected 150 before the first fake block failed.

A PoW variant forks off genesis at the PoW limit, at about 96 ms of hashing per block. Each side block also costs an O(height) `_branchTo` walk: measured 5.6 ms at 100,000 blocks and 118 ms at 1,000,000, so a 200-block batch takes about 24 s under the chain lock.

## Scope

- Before storing a side block, check what can be checked from the header chain and the block alone:
  - timestamps: grid, later than the parent, median time past, future limit (the last without an invalid mark, see TASK-0057);
  - the coinstake's shape;
  - the block signature (TASK-0057);
  - transaction structure.

  Check the kernel where its outpoint is in the active UTXO set at or below the fork point. Decide what to do with a kernel created on the side branch itself.
- Bound how far below the tip a new side branch may fork. Relate it to TASK-0062 if that adds a reorganization limit.
- Make the per-block cost of a side block independent of the height: retarget and median-time-past need only the last few headers, not the branch from genesis.
- Relay a side block only once it has passed these checks, or only when its branch has more work. See the open question in the reassessment.
- Score a peer for side blocks that fail these checks.
- Decide whether stored side blocks are ever pruned, and bound what one peer can make the node store.

## Acceptance criteria

- [ ] A PoS side block with a bad timestamp, signature, coinstake or (where checkable) kernel is refused before it is stored, and scores its sender.
- [ ] A branch of fake blocks can't force a reorganization: its claimed work comes from checked timestamps only.
- [ ] Storing a side block costs the same at height 1,000,000 as at 1,000 (measured).
- [ ] Junk side blocks aren't relayed.
- [ ] Regression tests in `ConsensusAttacks.test.ts` for the disk-fill and fake-work scenarios.
- [ ] Honest forks still resolve: same-slot siblings, a partition and its reorganization (e2e).

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`, and `npm run scale` before and after.

## Notes

A kernel that spends an output created on the side branch can't be checked against the active UTXO set. Options: check it when the branch activates (as now), or keep a UTXO view for the branch. The first is enough if the work claimed before activation is bounded by checked timestamps.
