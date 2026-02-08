# Task B3: Fix Difficulty Adjustment Algorithm

| Field            | Value                                    |
| ---------------- | ---------------------------------------- |
| **ID**           | `B3`                                     |
| **Status**       | `[ ]`                                    |
| **Priority**     | High                                     |
| **Dependencies** | None                                     |
| **Branch**       | `feature/b3-difficulty-adjustment`       |

**Goal:**
Fix the difficulty adjustment algorithm which currently only adjusts by +/-1 per interval and has conflicting block time constants (`BLOCK_TIME = 600s` vs `TARGET_BLOCK_TIME = 375ms`).

**Current Problems:**

1. **Conflicting block times:** `BLOCK_TIME = 600` (10 min) vs `TARGET_BLOCK_TIME = 375` (375ms) — which is correct?
2. **Adjustment too coarse:** Only adjusts by 1 per interval, should be proportional
3. **4x clamp is arbitrary:** Adjustment factor of 4 doesn't match any standard algorithm
4. **Minimum difficulty of 1:** Too low for security, allows trivial hash targets
5. **Timestamps can be manipulated:** Miners can set block timestamps to influence difficulty

**Scope:**

```
src/blockchain/
├── Blockchain.ts                   # MODIFY — fix difficulty algorithm, harmonize block time
└── __tests__/Blockchain.test.ts    # MODIFY — add difficulty adjustment tests
src/
└── config.ts                       # MODIFY — harmonize BLOCK_TIME and TARGET_BLOCK_TIME
```

**Implementation:**

1. Harmonize block time: decide on one value and remove the other
   - For a test/educational blockchain: 10-30 seconds is reasonable
   - Remove `TARGET_BLOCK_TIME` if it's leftover from a different design
2. Make adjustment proportional: `newDifficulty = oldDifficulty * (expectedTime / actualTime)`
3. Clamp adjustment: `max(oldDifficulty / 4, newDifficulty, oldDifficulty * 4)` — no more than 4x change
4. Set reasonable minimum difficulty (e.g., 4 for test network)
5. Add median timestamp validation: use median of last 11 blocks to prevent manipulation
6. Document the algorithm and its parameters

**Acceptance Criteria:**

- [ ] Single consistent block time constant across the codebase
- [ ] Difficulty adjusts proportionally, not just +/-1
- [ ] Adjustment is clamped to prevent extreme changes
- [ ] Minimum difficulty prevents trivially easy blocks
- [ ] Timestamp manipulation doesn't affect difficulty
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Test: mine 20 blocks quickly, verify difficulty increases proportionally
# Test: mine 20 blocks slowly, verify difficulty decreases proportionally
```
