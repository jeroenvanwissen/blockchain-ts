# Task A3: Fix Concurrency / Race Conditions (CRITICAL)

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `A3`                                 |
| **Status**       | `[ ]`                                |
| **Priority**     | Critical                             |
| **Dependencies** | None                                 |
| **Branch**       | `fix/a3-concurrency-locks`           |

**Goal:**
Fix race conditions on shared mutable state. The `stakes` map, `pendingTransactions` array, and UTXO set can all be modified concurrently by the P2P server, mining, and staking service without synchronization.

**Current Problems:**

1. `stakes: Map` is public and unprotected — P2PServer and Blockchain both read/write
2. `pendingTransactions` is cleared during mining but new txs can arrive concurrently
3. `utxoSet` is updated after block is added but can be read during update
4. `replaceChain()` uses Mutex but the length check happens before lock acquisition
5. Chain can be mutated during iteration in `loadBlockchain()`

**Scope:**

```
src/blockchain/
├── Blockchain.ts                   # MODIFY — add mutex protection to all shared state
└── __tests__/Blockchain.test.ts    # MODIFY — add concurrency tests
src/blockchain/
└── StakingService.ts               # MODIFY — use locked access to blockchain
```

**Implementation:**

1. Extend the existing `async-mutex` usage to protect all shared state operations:
   - `addTransaction()` must lock before modifying `pendingTransactions`
   - `addMinedBlock()` must lock for the entire block addition + UTXO update + pending tx cleanup
   - `stake()` and `unstake()` must lock the stakes map
   - `replaceChain()` must lock before the length comparison (move check inside lock)
2. Make `stakes` private with getter/setter methods that use the mutex
3. Make `pendingTransactions` access go through mutex-protected methods
4. Ensure UTXO set reads are consistent (no partial updates visible)
5. Add a read lock for balance queries and chain iteration

**Acceptance Criteria:**

- [ ] All shared state modifications go through mutex
- [ ] `stakes` map is private with protected access methods
- [ ] No race condition between `addTransaction()` and `addMinedBlock()`
- [ ] `replaceChain()` length check is inside the lock
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
```
