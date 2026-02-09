# Task E6: Improve Test Coverage

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| **ID**           | `E6`                               |
| **Status**       | `[ ]`                              |
| **Priority**     | Medium                             |
| **Dependencies** | None                               |
| **Branch**       | `feature/e6-test-coverage`         |

**Goal:**
Expand the test suite to cover more components and edge cases. Tests exist for Blockchain, Wallet, BlockStore, P2PServer, and config, but several components are still untested.

**Existing Test Files:**

- `Blockchain.test.ts` — consensus, mining, staking, UTXO, difficulty adjustment
- `Wallet.test.ts` — key generation, address encoding, signing, persistence
- `BlockStore.test.ts` — chunked storage, index, load/save
- `P2PServer.test.ts` — connection, message handling
- `config.test.ts` — configuration constants

**Scope:**

```
src/blockchain/__tests__/
├── Transaction.test.ts             # CREATE — transaction unit tests
├── Block.test.ts                   # CREATE — block unit tests
├── StakingService.test.ts          # CREATE — staking service unit tests
├── Wallet.test.ts                  # MODIFY — expand edge case coverage
├── BlockStore.test.ts              # MODIFY — expand edge case coverage
└── Blockchain.test.ts              # MODIFY — add edge case tests
src/networking/__tests__/
└── P2PServer.test.ts               # MODIFY — expand coverage
```

**Implementation:**

1. Create `Transaction.test.ts` — test creation, signing, verification, validation, fee calculation
2. Create `Block.test.ts` — test creation, mining, validation, hash calculation, PoW/PoS detection
3. Create `StakingService.test.ts` — test eligibility checking, PoS block generation, interval management
4. Expand `Wallet.test.ts` — add import/export edge cases, error paths
5. Add edge case tests to `Blockchain.test.ts` — tampered blocks, invalid transactions, double-spend
6. Add UTXO tracking tests — double-spend prevention, change handling
7. Add difficulty adjustment algorithm tests
8. Expand `P2PServer.test.ts` — message handling, connection lifecycle, reconnection
9. Target >80% code coverage

**Acceptance Criteria:**

- [ ] All listed test files are created with meaningful tests
- [ ] Code coverage exceeds 80% (`npm test -- --coverage`)
- [ ] Tests pass reliably (no flaky tests)
- [ ] Edge cases and error paths are covered
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test -- --coverage
# Verify coverage report shows >80% across all files
```
