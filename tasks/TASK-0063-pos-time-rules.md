# TASK-0063: PoS time rules: the future limit and later-slot siblings

Status: pending (owner decision needed)
Priority: P2
Size: small
Depends on: owner decision; TASK-0057
Source: F-042 (reassessment 3, 2026-11-27)

## Why

Blocks may be dated up to 2 hours ahead (`MAX_FUTURE_BLOCK_TIME`). A PoS block must be later than its parent, and stakers try only the current slot. A staker who searches the roughly 450 future slots finds a kernel 110 to 120 minutes ahead even with a small stake. Once that block is the tip, no honest staker can produce a block until the clock passes it. Reproduced: a block at +110 minutes was accepted, and the honest staker made no block in 375 slots.

A sibling staked in a later slot with a lower tie-break value also replaces the tip, because siblings have equal work and `stakeTieBreak` ignores the timestamp. That lets a staker take a block from the honest staker who was first. This is a trade-off of TASK-0026.

Reassessment 2 accepted the 2-hour limit for grinding and retarget gaps. The design this project follows has the same limit and the same rule.

## Scope

After the owner decides:
- Optionally, a tighter future limit for PoS blocks, for example a few slots. Raise `PROTOCOL_VERSION` and add the value to `ChainRules`.
- Optionally, prefer the earlier slot between equal-work siblings, before the tie-break value.

## Acceptance criteria

- [ ] With the chosen rules, a block dated near the limit doesn't stop honest staking for longer than the limit (test with a fake clock).
- [ ] Simultaneous stakers still converge (e2e, the soak scenario).
- [ ] README's clock notes match.

## Validation

`npm run check`, `npm run e2e`.

## Notes

Decision needed: keep 2 hours or limit PoS blocks to a few slots ahead, and whether an earlier slot should win between equal-work siblings. A tighter limit makes nodes with skewed clocks refuse more blocks. That is benign, but they fall behind until their clock is corrected.
