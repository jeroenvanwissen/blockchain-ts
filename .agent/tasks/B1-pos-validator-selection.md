# Task B1: Implement PoS Validator Selection (CRITICAL)

| Field            | Value                                    |
| ---------------- | ---------------------------------------- |
| **ID**           | `B1`                                     |
| **Status**       | `[ ]`                                    |
| **Priority**     | Critical                                 |
| **Dependencies** | A3                                       |
| **Branch**       | `fix/b1-pos-validator-selection`         |

**Goal:**
Implement actual stake-weighted validator selection. Currently, the eligibility check is hardcoded to `return true` for any staker that meets the minimum age, meaning every staker produces a block every round — breaking consensus entirely.

**Current Problem:**

```typescript
// Blockchain.ts — hardcoded to always return true
// For testing purposes, always return true if other conditions are met
return true;
```

**Scope:**

```
src/blockchain/
├── Blockchain.ts                   # MODIFY — implement stake lottery
├── StakingService.ts               # MODIFY — integrate with lottery
└── __tests__/Blockchain.test.ts    # MODIFY — add validator selection tests
```

**Implementation:**

1. Implement stake-weighted lottery: probability of being selected = `stakeWeight / totalNetworkStake`
2. Use deterministic randomness based on previous block hash + staker address + slot number
3. Calculate a target: `SHA256(previousBlockHash + stakerAddress + timestamp) < target`
4. Target = `MAX_HASH * (stakeWeight / totalNetworkStake) * timeSinceLastBlock`
5. Only one validator should win per time slot
6. Add `totalNetworkStake()` method summing all active stake weights
7. Handle edge case: if no validator is selected in a slot, increase target for next slot
8. Ensure deterministic — all nodes must agree on who can produce the next block

**Acceptance Criteria:**

- [ ] Validator selection is probabilistic based on stake weight
- [ ] Selection is deterministic (same result on all nodes given same chain state)
- [ ] Higher stake weight = higher probability of selection
- [ ] Only one validator produces a block per time slot
- [ ] Nodes reject blocks from non-eligible validators
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Test: with two stakers (80% and 20% stake), verify ~80/20 block production ratio over 100 blocks
```
