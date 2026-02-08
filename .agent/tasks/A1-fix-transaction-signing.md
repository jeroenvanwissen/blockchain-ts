# Task A1: Fix Transaction Signing (CRITICAL)

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `A1`                                 |
| **Status**       | `[ ]`                                |
| **Priority**     | Critical                             |
| **Dependencies** | None                                 |
| **Branch**       | `fix/a1-transaction-signing`         |

**Goal:**
Fix the insecure transaction signing in `Transaction.ts`. Currently, `signTransaction()` uses `SHA256(hash + privateKey)` which is not a real cryptographic signature — it leaks the private key into the signature and can't be verified without the private key. The `Wallet.signTransaction()` method uses proper ECDSA but the two paths are inconsistent.

**Current Problem:**

```typescript
// Transaction.ts — INSECURE: concatenates hash + privateKey
signTransaction(privateKey: string): void {
    this.inputs.forEach((input) => {
        const hashTx = this.calculateHash();
        input.signature = crypto
            .createHash('sha256')
            .update(hashTx + privateKey)
            .digest('hex');
    });
}
```

The `verifySignature()` method references secp256k1 but `signTransaction()` doesn't use it — these are fundamentally incompatible.

**Scope:**

```
src/blockchain/
├── Transaction.ts                  # MODIFY — replace signing with proper ECDSA
├── Blockchain.ts                   # MODIFY — update any direct signing calls
└── __tests__/Blockchain.test.ts    # MODIFY — update tests for new signing
src/blockchain/
└── Wallet.ts                       # VERIFY — ensure consistency with wallet signing
```

**Implementation:**

1. Replace `signTransaction()` in `Transaction.ts` with proper secp256k1 ECDSA signing
2. Each input should be signed with: `secp256k1.ecdsaSign(hash, privateKeyBuffer)`
3. Update `verifySignature()` to use `secp256k1.ecdsaVerify(signature, hash, publicKey)`
4. Ensure the wallet's `signTransaction()` and `Transaction.signTransaction()` use the same mechanism
5. Consider removing the duplicate signing path — only sign through the Wallet
6. Update all tests that create signed transactions

**Acceptance Criteria:**

- [ ] Transaction signing uses proper ECDSA via secp256k1
- [ ] `signTransaction()` and `verifySignature()` are consistent
- [ ] Private key never appears in the signature output
- [ ] Wallet signing and Transaction signing produce identical results
- [ ] All existing tests pass with updated signing
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Verify: sign a transaction, verify it, then try to verify with wrong key — should fail
```
