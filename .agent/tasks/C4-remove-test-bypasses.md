# Task C4: Remove Test Environment Bypasses

| Field            | Value                                    |
| ---------------- | ---------------------------------------- |
| **ID**           | `C4`                                     |
| **Status**       | `[ ]`                                    |
| **Priority**     | Medium                                   |
| **Dependencies** | B2, C2                                   |
| **Branch**       | `feature/c4-remove-test-bypasses`        |

**Goal:**
Remove `process.env.NODE_ENV === 'test'` checks that bypass critical validation logic. Tests should test the real code, not a simplified version. Use proper test fixtures and configuration instead.

**Current Problem:**

`NODE_ENV === 'test'` bypasses in `Blockchain.ts`:
- **Stake age validation** (line ~296) — allows stakes with 0 age
- **Block timing** (line ~162) — allows blocks created instantly
- **Difficulty validation** (line ~185) — skips difficulty checks entirely
- **Block reward mismatch** (line ~136, ~149) — uses 100 instead of 10

These bypasses mean tests don't actually test the real consensus rules.

**Scope:**

```
src/blockchain/
├── Blockchain.ts                   # MODIFY — remove NODE_ENV checks, add configurable params
└── __tests__/Blockchain.test.ts    # MODIFY — use test configuration instead of env bypasses
src/
└── config.ts                       # MODIFY — add test-friendly configuration overrides
```

**Implementation:**

1. Remove all `process.env.NODE_ENV === 'test'` checks from `Blockchain.ts`
2. Make bypassed values configurable via constructor options:
   ```typescript
   interface BlockchainOptions {
     minStakeAge?: number;        // default: 86400, test: 0
     minBlockInterval?: number;   // default: 600000, test: 0
     validateDifficulty?: boolean; // default: true, test: true (fix tests!)
     blockReward?: number;        // default: 10
   }
   ```
3. Tests create Blockchain with test-appropriate options, not environment hacks
4. Fix tests to work with real validation where possible:
   - Use `minStakeAge: 0` for staking tests
   - Use `minBlockInterval: 0` for rapid block creation
   - Fix difficulty tests to use real difficulty validation
5. Ensure no production code paths reference `NODE_ENV`

**Acceptance Criteria:**

- [ ] Zero `process.env.NODE_ENV` checks in `src/blockchain/` (except tests themselves)
- [ ] Blockchain accepts configuration options for test-friendly values
- [ ] All tests pass using configuration, not env bypasses
- [ ] Difficulty validation is tested with real rules
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
grep -r "NODE_ENV" src/blockchain/ --include="*.ts" | grep -v "__tests__" | wc -l
# Should return 0
```
