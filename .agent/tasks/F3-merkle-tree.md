# Task F3: Merkle Tree for Transaction Validation

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| **ID**           | `F3`                               |
| **Status**       | `[ ]`                              |
| **Priority**     | Low                                |
| **Dependencies** | None                               |
| **Branch**       | `feature/f3-merkle-tree`           |

**Goal:**
Implement a Merkle tree structure for transaction validation within blocks. Allows efficient verification of transaction inclusion without downloading the entire block (SPV).

**Scope:**

```
src/blockchain/
├── MerkleTree.ts                   # CREATE — Merkle tree implementation
├── Block.ts                        # MODIFY — add Merkle root to header and hash calculation
├── Blockchain.ts                   # MODIFY — use Merkle root in validation
└── __tests__/MerkleTree.test.ts    # CREATE — Merkle tree tests
```

**Implementation:**

1. Create `MerkleTree` class that builds a tree from an array of transaction hashes
2. Use SHA256 for hashing (consistent with existing hash functions)
3. Handle edge cases: odd number of transactions (duplicate last), single transaction, empty block
4. Add `merkleRoot` field to `Block` header, include it in block hash calculation
5. Implement Merkle proof generation — path from a transaction to the root
6. Implement Merkle proof verification — verify a transaction is included given a proof
7. Update block validation in `Blockchain.ts` to verify Merkle root matches transactions

**Acceptance Criteria:**

- [ ] Merkle root is computed and stored in every block
- [ ] Merkle proofs can verify transaction inclusion
- [ ] Block validation includes Merkle root verification
- [ ] Edge cases (odd count, single tx, empty block) are handled correctly
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Verify Merkle root changes when transactions are modified
# Verify Merkle proof for a specific transaction in a block
```
