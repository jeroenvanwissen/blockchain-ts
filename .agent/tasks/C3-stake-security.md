# Task C3: Stake Security Improvements

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `C3`                                 |
| **Status**       | `[x]`                                |
| **Priority**     | Medium                               |
| **Dependencies** | B1                                   |
| **Branch**       | `feature/c3-stake-security`          |

**Goal:**
Address stake-related security issues: nothing-at-stake problem, instant unstaking, stake age using wall clock instead of block time, and negative stake weight from timestamp corruption.

**Current Problems:**

1. ~~**Nothing-at-stake:** Validators can sign blocks on multiple forks with no penalty~~ — **DONE** (C3): `submitDoubleSignEvidence()` slashes validator's stake
2. ~~**Instant unstake:** `unstake()` removes stake immediately with no withdrawal period~~ — **DONE** (C3): Unstake now queues a `PendingUnstake`, processed after `UNSTAKE_DELAY` blocks
3. ~~**Stake age uses `Date.now()`:** Should use block timestamps for consistency across nodes~~ — **DONE** (B1): `calculateStakeWeight()` now uses `lastBlockTime - timestamp` (block timestamps)
4. ~~**Negative stake weight:** `lastBlockTime - timestamp` can be negative if timestamps are corrupted~~ — **DONE** (C3): `Math.max(0, elapsedMs)` guards against negative elapsed time
5. ~~**Stake weight multiplier not bounded:** `Math.pow(1.1, elapsedDays)` grows unboundedly for old stakes~~ — **DONE** (C3): Capped at `MAX_STAKE_AGE_MULTIPLIER` (4x)
6. ~~**Pattern B stake detection too broad:** Single-address transfers >= 100 are falsely treated as staking~~ — **DONE** (C3): Removed Pattern B; `stake()` now creates coinstake-format transactions (zero marker) so only Pattern A (coinstake) detects stakes

**Scope:**

```
src/blockchain/
├── Blockchain.ts                   # MODIFIED — unstake delay, bounded weight, slashing, Pattern B fix
├── StakingService.ts               # No changes needed (uses existing Blockchain API)
└── __tests__/Blockchain.test.ts    # MODIFIED — 18 new C3 tests + updated existing unstake test
src/
└── config.ts                       # MODIFIED — added UNSTAKE_DELAY, MAX_STAKE_AGE_MULTIPLIER
```

**Implementation:**

1. ~~**Fix stake age calculation:** Use latest block timestamp instead of `Date.now()`~~ — **DONE** (B1)
2. ~~**Add unstake delay:** When `unstake()` is called, mark stake as "pending withdrawal" — actual removal after `UNSTAKE_DELAY` blocks (e.g., 100 blocks)~~ — **DONE** (C3)
3. ~~**Bound stake weight:** Cap the age multiplier at `MAX_STAKE_AGE_MULTIPLIER` (e.g., 4x) to prevent ancient stakes from dominating~~ — **DONE** (C3)
4. ~~**Guard against negative weight:** `Math.max(0, elapsedMs)` in `calculateStakeWeight()`~~ — **DONE** (C3)
5. ~~**Nothing-at-stake mitigation:** Track which blocks a validator has signed — if they sign two blocks at the same height, slash their stake (remove it)~~ — **DONE** (C3)
6. ~~**Add slashing condition:** If evidence of double-signing is received via P2P, remove the offender's stake~~ — **DONE** (C3)
7. ~~**Fix Pattern B stake detection:** Tighten the heuristic in `_addMinedBlockInternal` and `isChainValid` so normal transfers aren't treated as staking~~ — **DONE** (C3)

**Acceptance Criteria:**

- [x] Stake age uses block timestamps, not wall clock — done in B1
- [x] Unstaking has a withdrawal delay
- [x] Stake weight multiplier is bounded
- [x] Negative stake weight is impossible
- [x] Double-signing evidence triggers stake slashing
- [x] Build passes: `npm run build`
- [x] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Test: unstake and verify funds are locked for UNSTAKE_DELAY blocks
# Test: submit double-signing evidence, verify stake is slashed
```
