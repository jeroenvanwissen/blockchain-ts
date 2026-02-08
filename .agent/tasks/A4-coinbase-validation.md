# Task A4: Coinbase Transaction Validation

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `A4`                                 |
| **Status**       | `[ ]`                                |
| **Priority**     | High                                 |
| **Dependencies** | None                                 |
| **Branch**       | `fix/a4-coinbase-validation`         |

**Goal:**
Add proper validation for coinbase (block reward) transactions. Currently, coinbase transactions are created but never validated — allowing blocks with incorrect rewards, multiple coinbases, or missing coinbases.

**Current Problem:**

- No validation that exactly one coinbase transaction exists per block
- No validation that coinbase amount equals `BLOCK_REWARD` (+ fees when implemented)
- No validation that coinbase has zero inputs
- Coinbase outputs can have arbitrary addresses without validation
- PoS coinstake marker output (amount=0) not validated for correct structure

**Scope:**

```
src/blockchain/
├── Blockchain.ts                   # MODIFY — add coinbase validation in block validation
├── Transaction.ts                  # MODIFY — add isCoinbase() method
├── Block.ts                        # MODIFY — add coinbase validation helper
└── __tests__/Blockchain.test.ts    # MODIFY — add coinbase validation tests
```

**Implementation:**

1. Add `isCoinbase(): boolean` method to Transaction (no inputs, single output with reward amount)
2. In `addMinedBlock()` / block validation, verify:
   - Exactly one coinbase transaction per block (first transaction)
   - Coinbase has no inputs
   - Coinbase output amount equals expected reward (PoW: 10, PoS: 10, + fees when E8/C2 done)
   - Coinbase output address is a valid address
3. For PoS blocks, verify coinstake structure:
   - Second transaction is coinstake (marker output with amount=0)
   - Coinstake inputs match the validator's stake
   - Coinstake outputs return stake + reward
4. Validate that coinbase maturity is enforced (outputs can't be spent for `COIN_MATURITY` blocks)

**Acceptance Criteria:**

- [ ] Blocks with incorrect reward amounts are rejected
- [ ] Blocks with multiple coinbase transactions are rejected
- [ ] Blocks with no coinbase are rejected
- [ ] PoS coinstake structure is validated
- [ ] Coinbase maturity is enforced
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Test: create block with double reward — should be rejected
# Test: create block with no coinbase — should be rejected
```
