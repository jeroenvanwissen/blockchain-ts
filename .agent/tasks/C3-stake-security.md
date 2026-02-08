# Task C3: Stake Security Improvements

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `C3`                                 |
| **Status**       | `[ ]`                                |
| **Priority**     | Medium                               |
| **Dependencies** | B1                                   |
| **Branch**       | `feature/c3-stake-security`          |

**Goal:**
Address stake-related security issues: nothing-at-stake problem, instant unstaking, stake age using wall clock instead of block time, and negative stake weight from timestamp corruption.

**Current Problems:**

1. **Nothing-at-stake:** Validators can sign blocks on multiple forks with no penalty
2. **Instant unstake:** `unstake()` removes stake immediately with no withdrawal period
3. **Stake age uses `Date.now()`:** Should use block timestamps for consistency across nodes
4. **Negative stake weight:** `lastBlockTime - timestamp` can be negative if timestamps are corrupted
5. **Stake weight multiplier not bounded:** Very old stakes get disproportionate weight

**Scope:**

```
src/blockchain/
├── Blockchain.ts                   # MODIFY — fix stake age, add unstake delay, bounds
├── StakingService.ts               # MODIFY — coordinate with new stake rules
└── __tests__/Blockchain.test.ts    # MODIFY — add stake security tests
src/
└── config.ts                       # MODIFY — add UNSTAKE_DELAY, MAX_STAKE_AGE_MULTIPLIER
```

**Implementation:**

1. **Fix stake age calculation:** Use latest block timestamp instead of `Date.now()`
2. **Add unstake delay:** When `unstake()` is called, mark stake as "pending withdrawal" — actual removal after `UNSTAKE_DELAY` blocks (e.g., 100 blocks)
3. **Bound stake weight:** Cap the age multiplier at `MAX_STAKE_AGE_MULTIPLIER` (e.g., 4x) to prevent ancient stakes from dominating
4. **Guard against negative weight:** `Math.max(0, elapsedMs)` in `calculateStakeWeight()`
5. **Nothing-at-stake mitigation:** Track which blocks a validator has signed — if they sign two blocks at the same height, slash their stake (remove it)
6. **Add slashing condition:** If evidence of double-signing is received via P2P, remove the offender's stake

**Acceptance Criteria:**

- [ ] Stake age uses block timestamps, not wall clock
- [ ] Unstaking has a withdrawal delay
- [ ] Stake weight multiplier is bounded
- [ ] Negative stake weight is impossible
- [ ] Double-signing evidence triggers stake slashing
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Test: unstake and verify funds are locked for UNSTAKE_DELAY blocks
# Test: submit double-signing evidence, verify stake is slashed
```
