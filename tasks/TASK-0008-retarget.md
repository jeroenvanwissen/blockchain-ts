# TASK-0008: Per-block retarget and timestamp rules

Status: done
Priority: P1
Size: medium
Depends on: TASK-0007
Source: F-008

## Why

The retarget scales a leading-zero count linearly (`src/blockchain/Blockchain.ts:1199-1232`): blocks only 2x too fast pushed difficulty from 4 to 8, which is 65,536x the work. The 30 s `minBlockInterval` equals the target spacing (`Blockchain.ts:220-227`), so in the default config difficulty can never rise.

## Scope

- Peercoin-style per-block retarget on the numeric target: `new = prev × ((N−1)·T + 2·actual) / ((N+1)·T)`, where `N = timespan / T` and `actual` is clamped (a negative value becomes `T`, the maximum is `10·T`).
- PoW and PoS retarget separately, each from the last block of the same type, capped at the type's limit.
- Remove `minBlockInterval`. Keep the median-time-past (11 blocks) rule and the future-time limit.

## Acceptance criteria

- [x] Simulated blocks at 2x speed tighten the target by a few percent per block, with no step jumps.
- [x] Slow blocks loosen the target up to the limit.
- [x] The result is deterministic from header data alone.

## Validation

`npm test` (simulation tests with synthetic headers).

## Outcome

**Retarget** (`src/blockchain/retarget.ts`)
- `requiredBits(chain, height, proofOfStake)` implements the Peercoin formula with N = 16 and T = 30 s:
  - `actual` is the spacing of the last two blocks of the same type;
  - negative spacing counts as T, and spacing is capped at 10·T;
  - the result is capped at the type's limit;
  - the first two blocks of each type use the limit.
- `_connectBlock` requires `block.bits` to equal it for both PoW and PoS blocks.
- `createBlockTemplate` and `generateStakeBlock` set the bits for the block's type. A template that a pending stake transaction turns into "PoS" (F-007) carries PoS bits.

**Minimum interval removed**
- `minBlockInterval` is gone; the retarget alone sets block spacing.
- A new chain mines its first blocks quickly. The target tightens by about 12% per block while blocks come in well under T, and settles near T within roughly 50 blocks on one CPU worker.
- `getNextBlockMinTimestamp()` is now just median-time-past + 1.

**Removed**
- `calculateNewDifficulty`, `calculateDifficultyForChain`, `getDifficulty`/`setDifficulty`, and the `DIFFICULTY_ADJUSTMENT_INTERVAL`/`MIN_DIFFICULTY`/`MAX_DIFFICULTY_CHANGE_FACTOR` constants.
- Blocks now expose `bits`, and `Blockchain.getRequiredBits(proofOfStake)` gives the target for the next block. With difficulty validation off (tests), it returns the easiest target.

**P2P ordering fix**
- Chain, block, transaction and stake messages from one peer are now processed in arrival order.
- Before, a block relayed right after a `CHAIN` message could be handled before that chain was adopted. It was then dropped as "ahead", and the node stayed behind until it reconnected. Faster block production made this reproducible in the smoke check.

**Tests**
- `Target.test.ts` checks retarget behavior on synthetic header chains:
  - steady on schedule;
  - 2x fast tightens by exactly 16/17 per block (no steps);
  - slow blocks loosen by 19/17 per block, up to the limit and never past it;
  - the gap cap and negative spacing;
  - PoW and PoS independence;
  - the same result from a JSON round-tripped copy.
- `npm run smoke` reads heights from the logs (B syncs to whatever A has mined, then accepts a newer block live) and takes about 10 s.
- `npm test`: 11 suites, 216 tests, about 11 s. The integration tests mine at the real starting target.
