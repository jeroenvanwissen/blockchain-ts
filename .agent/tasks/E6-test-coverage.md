# Task E6: Improve Test Coverage

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| **ID**           | `E6`                               |
| **Status**       | `[ ]`                              |
| **Priority**     | Medium                             |
| **Dependencies** | None                               |
| **Branch**       | `feature/e6-test-coverage`         |

**Goal:**
Expand the test suite to cover more components and edge cases. Currently tests exist for Blockchain and P2P Server but several components are untested.

**Scope:**

```
src/blockchain/__tests__/
├── Transaction.test.ts             # CREATE — transaction unit tests
├── Block.test.ts                   # CREATE — block unit tests
├── Wallet.test.ts                  # CREATE — wallet unit tests
├── StakingService.test.ts          # CREATE — staking service unit tests
└── Blockchain.test.ts              # MODIFY — add edge case tests
src/networking/__tests__/
└── P2PServer.test.ts               # MODIFY — expand coverage
```

**Implementation:**

1. Create `Transaction.test.ts` — test creation, signing, verification, validation, fee calculation
2. Create `Block.test.ts` — test creation, mining, validation, hash calculation, PoW/PoS detection
3. Create `Wallet.test.ts` — test key generation, address encoding, signing, persistence, import/export
4. Create `StakingService.test.ts` — test eligibility checking, PoS block generation
5. Add edge case tests to `Blockchain.test.ts` — tampered blocks, invalid transactions, double-spend
6. Add UTXO tracking tests — double-spend prevention, change handling
7. Add difficulty adjustment algorithm tests
8. Expand `P2PServer.test.ts` — message handling, connection lifecycle
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
