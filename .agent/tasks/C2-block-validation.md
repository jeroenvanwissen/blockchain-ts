# Task C2: Complete Block Validation

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `C2`                                 |
| **Status**       | `[ ]`                                |
| **Priority**     | High                                 |
| **Dependencies** | A4, B2                               |
| **Branch**       | `feature/c2-block-validation`        |

**Goal:**
Add comprehensive block validation including timestamp checks, proper hash verification, and consensus transition validation. Currently, blocks can have arbitrary timestamps, the genesis block hash isn't re-verified on load, and the PoW-to-PoS transition at block 100 isn't validated during chain sync.

**Current Missing Validations:**

- Block timestamps can be in the past or far future (no range check)
- Genesis block hash not re-verified when loading from disk
- No validation that PoW-to-PoS transition happens at the correct block height
- `MIXED_MODE_START_BLOCK` and `POS_START_BLOCK` config values are dead code
- Block index can be negative (no check)
- No maximum block size validation

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

1. Add timestamp validation:
   - `block.timestamp >= previousBlock.timestamp` (no going backwards)
   - `block.timestamp <= Date.now() + 2 hours` (not too far in the future)
   - Validate timestamp is a positive integer
2. Add block index validation: `block.index >= 0`
3. Verify genesis block hash on chain load (recalculate and compare)
4. Validate consensus transition:
   - Blocks 0 to `POW_CUTOFF_BLOCK - 1` must be PoW
   - Blocks >= `POW_CUTOFF_BLOCK` must be PoS
   - Reject PoS blocks before cutoff and PoW blocks after cutoff
5. Implement or remove `MIXED_MODE_START_BLOCK` and `POS_START_BLOCK`:
   - If mixed mode is intended: allow both PoW and PoS in range [80, 100]
   - If not: remove dead code
6. Add block size limit (max transactions per block)

**Acceptance Criteria:**

- [ ] Blocks with timestamps in the past (before previous block) are rejected
- [ ] Blocks with timestamps far in the future are rejected
- [ ] Genesis block integrity is verified on load
- [ ] PoW blocks after cutoff are rejected
- [ ] PoS blocks before cutoff are rejected
- [ ] Dead config constants are resolved
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Test: create block with timestamp before previous block — should be rejected
# Test: create PoW block after block 100 — should be rejected
```
