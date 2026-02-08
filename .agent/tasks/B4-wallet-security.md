# Task B4: Wallet Security Hardening

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `B4`                                 |
| **Status**       | `[ ]`                                |
| **Priority**     | Medium                               |
| **Dependencies** | None                                 |
| **Branch**       | `feature/b4-wallet-security`         |

**Goal:**
Harden the wallet implementation to prevent private key exposure, validate imported wallets cryptographically, and handle file corruption gracefully.

**Current Problems:**

1. **Backup files accumulate:** Unencrypted backups with private keys are never deleted
2. **No file permissions:** Wallet files are world-readable (no `chmod 0600`)
3. **Import doesn't verify keys:** Imported public key isn't checked against private key
4. **Empty catch blocks:** Errors in key operations are silently swallowed
5. **Corrupted JSON crashes node:** No recovery from corrupted wallet file
6. **No wallet encryption:** Private keys stored in plaintext JSON

**Scope:**

```
src/blockchain/
├── Wallet.ts                       # MODIFY — add security hardening
└── __tests__/Wallet.test.ts        # CREATE — wallet security tests
```

**Implementation:**

1. **Limit backups:** Keep only the last 3 backups, delete older ones
2. **Set file permissions:** `fs.chmodSync(walletPath, 0o600)` after write
3. **Validate imports:** On import, derive public key from private key and compare
4. **Handle errors:** Replace empty catch blocks with proper error logging and fallbacks
5. **Graceful corruption recovery:** If wallet file is corrupted, log error and offer to create new wallet (don't crash)
6. **Optional encryption:** Add password-based encryption for wallet file using `crypto.scrypt()` + AES-256-GCM
7. **Clear sensitive data:** Zero out private key buffers when wallet is closed/destroyed

**Acceptance Criteria:**

- [ ] Only last 3 wallet backups are kept
- [ ] Wallet files have restricted permissions (0600)
- [ ] Imported wallets are cryptographically validated
- [ ] Corrupted wallet files are handled gracefully
- [ ] Empty catch blocks are replaced with proper error handling
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Test: import wallet with mismatched keys — should be rejected
# Test: corrupt wallet file, verify graceful recovery
```
