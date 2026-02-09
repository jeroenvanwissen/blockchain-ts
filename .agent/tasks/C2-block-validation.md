# Task C2: Complete Block Validation

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `C2`                                 |
| **Status**       | `[x]`                                |
| **Priority**     | High                                 |
| **Dependencies** | A4, B2                               |
| **Branch**       | `feature/c2-block-validation`        |

**Goal:**
Add comprehensive block validation including timestamp checks, proper hash verification, and consensus transition validation. Ensure `replaceChain()` has the same validation rigor as `_addMinedBlockInternal()`.

**Already Implemented (via earlier tasks):**

- `_addMinedBlockInternal` validates median time past (`block.timestamp <= getMedianTimePast()` rejected)
- `_addMinedBlockInternal` enforces minimum block time (`BLOCK_TIME * 1000` gap)
- `_addMinedBlockInternal` rejects PoW blocks after `POW_CUTOFF_BLOCK`
- Coinbase validation (first tx is coinbase, correct reward, no duplicates) — task A4
- Block index and previous hash continuity checks

**Current Missing Validations:**

- `replaceChain()` has weaker validation than `_addMinedBlockInternal` — missing timestamp checks, difficulty validation for PoW, and incomplete PoS validation
- Genesis block hash not re-verified when loading from disk (only field-by-field comparison)
- `MIXED_MODE_START_BLOCK` and `POS_START_BLOCK` config values are dead code (defined but never imported)
- No maximum block size validation (max transactions per block)
- No future timestamp rejection (`block.timestamp <= Date.now() + 2 hours`)

**Scope:**

```
src/blockchain/
├── Block.ts                        # MODIFY — add timestamp validation, index validation
├── Blockchain.ts                   # MODIFY — add transition validation, genesis verification
└── __tests__/Blockchain.test.ts    # MODIFY — add block validation tests
src/
└── config.ts                       # MODIFY — remove or implement dead code constants
```

**Implementation:**

1. Bring `replaceChain()` validation to parity with `_addMinedBlockInternal()`:
   - Add timestamp validation (median time past, minimum block time gap)
   - Add difficulty validation for PoW blocks in received chains
   - Add full PoS validator eligibility check (currently only validates stake, not slot eligibility)
   - Add future timestamp rejection: `block.timestamp <= Date.now() + 2 hours`
2. Verify genesis block hash on chain load (recalculate full hash and compare, not just field-by-field)
3. Implement or remove `MIXED_MODE_START_BLOCK` and `POS_START_BLOCK`:
   - If mixed mode is intended: allow both PoW and PoS in range [80, 100]
   - If not: remove dead code from config.ts
4. Add block size limit (max transactions per block, add `MAX_BLOCK_TRANSACTIONS` to config)

**Acceptance Criteria:**

- [x] `replaceChain()` validates timestamps (median time past, minimum gap, future limit)
- [x] `replaceChain()` validates PoW difficulty matches expected difficulty
- [x] `replaceChain()` validates PoS validator eligibility (not just stake existence)
- [x] Genesis block integrity is verified via full hash on load
- [x] Dead config constants (`MIXED_MODE_START_BLOCK`, `POS_START_BLOCK`) are resolved
- [x] Block size limit is enforced
- [x] Build passes: `npm run build`
- [x] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Test: create block with timestamp before previous block — should be rejected
# Test: create PoW block after block 100 — should be rejected
```
