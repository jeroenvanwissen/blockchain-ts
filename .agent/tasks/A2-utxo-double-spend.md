# Task A2: Fix UTXO Double-Spend Prevention (CRITICAL)

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `A2`                                 |
| **Status**       | `[ ]`                                |
| **Priority**     | Critical                             |
| **Dependencies** | None                                 |
| **Branch**       | `fix/a2-utxo-double-spend`           |

**Goal:**
Prevent double-spending by validating that UTXOs referenced in new transactions are not already spent by pending (unconfirmed) transactions. Currently, the same UTXO can be spent in multiple pending transactions before a block is mined.

**Current Problem:**

- `createTransaction()` checks the UTXO set but not `pendingTransactions`
- Two calls to `createTransaction()` spending the same UTXO both succeed
- Only one gets into a block; the other silently becomes invalid
- `addTransaction()` also doesn't check for UTXO conflicts with existing pending txs

**Scope:**

```
src/blockchain/
├── Blockchain.ts                   # MODIFY — add pending UTXO tracking
└── __tests__/Blockchain.test.ts    # MODIFY — add double-spend tests
```

**Implementation:**

1. Maintain a `pendingUTXOSpends: Set<string>` tracking UTXOs referenced by pending transactions (key: `${txHash}:${outputIndex}`)
2. In `addTransaction()`, check each input against both `utxoSet` and `pendingUTXOSpends`
3. Reject transactions that reference UTXOs already in `pendingUTXOSpends`
4. In `createTransaction()`, same check before creating the transaction
5. Clear `pendingUTXOSpends` when a block is mined (matching what went into the block)
6. On chain replacement, rebuild `pendingUTXOSpends` from remaining pending transactions
7. Add duplicate input detection within a single transaction (same UTXO used twice)

**Acceptance Criteria:**

- [ ] A UTXO cannot be spent by two different pending transactions
- [ ] Duplicate inputs within a single transaction are rejected
- [ ] `pendingUTXOSpends` is cleared correctly when blocks are mined
- [ ] Chain replacement properly rebuilds pending UTXO tracking
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Test: create two transactions spending the same UTXO — second should be rejected
```
