# Task E2: Transaction Mempool

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| **ID**           | `E2`                               |
| **Status**       | `[ ]`                              |
| **Priority**     | Medium                             |
| **Dependencies** | E1                                 |
| **Branch**       | `feature/e2-mempool`               |

**Goal:**
Implement a proper transaction mempool to replace the simple pending transactions array. Provides deduplication, eviction policies, and fee-based ordering.

**Scope:**

```
src/blockchain/
├── Mempool.ts                      # CREATE — mempool implementation
├── Blockchain.ts                   # MODIFY — replace pending array with Mempool
└── __tests__/Mempool.test.ts       # CREATE — mempool tests
src/
└── config.ts                       # MODIFY — add mempool config (max size, expiry time)
```

**Implementation:**

1. Create `Mempool` class using a `Map` for O(1) lookup by transaction hash
2. Add configurable `MAX_MEMPOOL_SIZE` and `TX_EXPIRY_TIME` (default: 72 hours) to `config.ts`
3. Implement transaction deduplication — reject already-known transactions
4. Order transactions by fee (highest first) for block inclusion
5. Implement eviction policy — remove lowest-fee transactions when pool is full
6. Track transaction age and expire old transactions
7. Remove transactions from mempool when included in a mined block
8. Handle chain reorganizations — re-add transactions from orphaned blocks
9. Replace `pendingTransactions` array in `Blockchain.ts` with `Mempool` instance

**Acceptance Criteria:**

- [ ] Duplicate transactions are rejected
- [ ] Mempool has a configurable size limit with eviction
- [ ] Transactions are ordered by fee for block creation
- [ ] Expired transactions are automatically removed
- [ ] Mined transactions are removed from the mempool
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Submit the same transaction twice, verify second is rejected
# Fill mempool to max, submit high-fee tx, verify low-fee tx is evicted
```
