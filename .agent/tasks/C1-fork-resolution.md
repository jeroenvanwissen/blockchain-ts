# Task C1: Implement Proper Fork Resolution

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `C1`                                 |
| **Status**       | `[ ]`                                |
| **Priority**     | High                                 |
| **Dependencies** | B1                                   |
| **Branch**       | `fix/c1-fork-resolution`             |

**Goal:**
Implement proper fork resolution using cumulative difficulty/weight instead of simple chain length. Currently, `replaceChain()` only compares chain length, which doesn't account for PoW difficulty or PoS stake weight. Two chains of equal length cause undefined behavior.

**Current Problem:**

```typescript
// Blockchain.ts — replaceChain()
if (newChain.length <= this.chain.length) {
    console.log('Received chain is not longer');
    return;
}
```

**Scope:**

```
src/blockchain/
├── Blockchain.ts                   # MODIFY — cumulative weight calculation, fork resolution
├── Block.ts                        # MODIFY — add cumulative difficulty/weight field
└── __tests__/Blockchain.test.ts    # MODIFY — add fork resolution tests
src/networking/
└── P2PServer.ts                    # MODIFY — use weight-based chain selection
```

**Implementation:**

1. Add `cumulativeWeight` field to Block (sum of all previous blocks' work/stake weight)
2. For PoW blocks: weight = `2^difficulty` (exponential, matching Bitcoin)
3. For PoS blocks: weight = `stakeWeight` of the validator
4. `replaceChain()` compares cumulative weight, not length
5. Handle equal-weight chains: prefer the one received first (no flip-flopping)
6. When receiving a new block, check if it extends the heaviest known chain
7. Store orphan blocks temporarily in case they become part of the heaviest chain later
8. Re-add transactions from orphaned blocks back to pending pool

**Acceptance Criteria:**

- [ ] Chain selection uses cumulative weight, not length
- [ ] PoW blocks contribute `2^difficulty` to chain weight
- [ ] PoS blocks contribute stake weight
- [ ] Equal-weight chains are handled deterministically
- [ ] Transactions from orphaned blocks return to pending pool
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Test: create two chains of same length but different difficulty — higher difficulty wins
```
