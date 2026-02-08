# Task E1: Transaction Fee System

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| **ID**           | `E1`                               |
| **Status**       | `[ ]`                              |
| **Priority**     | Medium                             |
| **Dependencies** | None                               |
| **Branch**       | `feature/e1-transaction-fees`      |

**Goal:**
Implement a transaction fee system where senders include fees collected by miners/validators. Provides economic incentive for block production and prevents spam.

**Scope:**

```
src/blockchain/
├── Transaction.ts                  # MODIFY — add fee calculation method
├── Blockchain.ts                   # MODIFY — fee collection in coinbase, tx prioritization
├── Block.ts                        # MODIFY — include total fees in block metadata
└── __tests__/Blockchain.test.ts    # MODIFY — add fee-related tests
src/
└── config.ts                       # MODIFY — add MIN_TRANSACTION_FEE constant
```

**Implementation:**

1. Add `getFee()` method to `Transaction.ts`: fee = sum(inputs) - sum(outputs)
2. Add `MIN_TRANSACTION_FEE` constant to `config.ts`
3. Enforce minimum fee during transaction validation in `Blockchain.ts`
4. Update coinbase transaction to include block reward + total fees from block
5. Prioritize higher-fee transactions when selecting transactions for block creation
6. Add fee information to transaction details / serialization
7. Update transaction validation to verify fee is non-negative

**Acceptance Criteria:**

- [ ] Transactions without sufficient fee are rejected
- [ ] Miners receive block reward + transaction fees in coinbase
- [ ] Higher-fee transactions are prioritized in block creation
- [ ] Fee calculation is correct and validated
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Verify fee rejection:
# Create a transaction with 0 fee, verify it's rejected
# Create a transaction with valid fee, verify it's accepted
```
