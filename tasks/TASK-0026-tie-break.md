# TASK-0026: Equal-work tie-break that block contents can't influence

Status: done
Priority: P2
Size: small
Depends on: TASK-0012
Source: F-022 (reassessment 2026-11-23)

## Why

Equal-work forks went to the tip with the lower block hash. A PoS block's hash changes with anything the staker puts in it: transaction choice and order, the coinbase, the coinstake split. A staker could try variants until its hash was lower than a competitor's and win every tie. Ties happen at every slot while the PoS target sits near its limit (the start of PoS, regtest), and otherwise whenever two stakers hit the same slot.

## Scope

- Break PoS ties on a value fixed by the stake used, not the block contents. Keep the block hash for PoW, where a lower hash costs more work.
- Keep fork choice deterministic so simultaneous stakers still converge.

## Acceptance criteria

- [x] In a same-slot tie, the winner is the same however the losing staker varies its block contents, whatever the arrival order.
- [x] Fork choice at runtime and at startup use the same rule.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

- `stakeTieBreak(parentHash, kernelTxHash, kernelOutputIndex)` in `kernel.ts` is sha256d over those fields.
- `Blockchain._isBetter(a, b)` compares chain work, then `_tieBreak(tip)`, then the block hash:
  - `_tieBreak` is the block hash for PoW and `stakeTieBreak` for PoS.
  - The hash only decides between blocks built on the same stake (one staker double-signing), so nodes still converge.
- Both `_acceptBlock` and startup branch selection in `loadBlockchain` use it.
- A staker with several hitting outputs can still pick the one with the lowest value. That choice scales with how many of its outputs hit, as with a kernel-hash tie-break, not with free retries.
- No format change; existing chains load. Only which equal-work branch wins can differ from before.

**Tests**
- `ProofOfStake.test.ts` "should settle same-slot ties by the stake used":
  - two stakers stake the same slot
  - the loser reworks its block (same stake, different coinbase) until its hash is lower than the winner's
  - fresh nodes fed both blocks in either order keep the winner
- With the old hash tie-break restored temporarily, the test fails, as intended.
- PoW tie tests in `Reorg.test.ts` are unchanged; their labels now say PoW.

**Runs**
- `npm run check`: 26 suites, 291 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 92 s (height 26, 6 PoS blocks). The same-slot tie at height 23 and the equal-work branches after the partition were settled by the new rule, and all nodes converged.
