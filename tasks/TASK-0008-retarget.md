# TASK-0008: Per-block retarget and timestamp rules

Status: pending
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

- [ ] Simulated blocks at 2x speed tighten the target by a few percent per block, with no step jumps.
- [ ] Slow blocks loosen the target up to the limit.
- [ ] The result is deterministic from header data alone.

## Validation

`npm test` (simulation tests with synthetic headers).
