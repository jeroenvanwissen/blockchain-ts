# Task B2: Complete Transaction Validation

| Field            | Value                                    |
| ---------------- | ---------------------------------------- |
| **ID**           | `B2`                                     |
| **Status**       | `[x]`                                    |
| **Priority**     | High                                     |
| **Dependencies** | A1, A2                                   |
| **Branch**       | `feature/b2-transaction-validation`      |

**Goal:**
Add comprehensive transaction validation that is currently missing. Transactions are accepted with minimal checks, allowing invalid amounts, missing signatures, and malformed structures.

**Current Missing Validations:**

- No check that input amounts >= output amounts
- No check for duplicate inputs (same UTXO twice)
- No check that referenced UTXOs actually exist
- No validation that outputs have positive amounts
- No address format validation (despite `validateAddress()` existing but never called)
- No transaction size limits
- No nonce uniqueness validation

**Scope:**

```
src/blockchain/
├── Transaction.ts                  # MODIFY — add comprehensive validate() method
├── Blockchain.ts                   # MODIFY — call validation in addTransaction(), use validateAddress()
└── __tests__/Blockchain.test.ts    # MODIFY — add validation tests
```

**Implementation:**

1. Enhance `Transaction.validate()` to check:
   - All inputs have valid signatures
   - All inputs reference existing UTXOs (pass UTXO set to validate)
   - No duplicate inputs (same txHash + outputIndex)
   - Sum of inputs >= sum of outputs (difference is fee)
   - All output amounts are positive (> 0, except PoS marker)
   - All output addresses pass `validateAddress()`
   - Transaction hash matches calculated hash
2. Call `validateAddress()` in `createTransaction()`, `addTransaction()`, and `stake()`
3. Add transaction size limit (max inputs, max outputs)
4. Ensure `addTransaction()` rejects all invalid transactions with descriptive errors

**Acceptance Criteria:**

- [x] Transactions with invalid signatures are rejected
- [x] Transactions spending non-existent UTXOs are rejected
- [x] Transactions with duplicate inputs are rejected
- [x] Transactions with outputs > inputs are rejected
- [x] Transactions with negative/zero output amounts are rejected
- [x] Invalid addresses are rejected everywhere
- [x] Build passes: `npm run build`
- [x] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Test each validation rule individually
```
