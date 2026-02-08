# Task F1: Clean Up Dead Code and Config

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `F1`                                 |
| **Status**       | `[ ]`                                |
| **Priority**     | Low                                  |
| **Dependencies** | C2, B3                               |
| **Branch**       | `feature/f1-dead-code-config`        |

**Goal:**
Remove dead code and unused configuration constants. Clean up inconsistencies between config values and actual usage.

**Current Problems:**

- `MIXED_MODE_START_BLOCK = 80` — never referenced in code
- `POS_START_BLOCK = 90` — never referenced in code
- `COIN_MATURITY = 10` — never referenced in code (maturity not enforced)
- `TARGET_BLOCK_TIME = 375` in Miner.ts conflicts with `BLOCK_TIME = 600` in Blockchain.ts
- package.json name says "blockchain-js" but project is "blockchain-ts"

**Scope:**

```
src/
├── config.ts                       # MODIFY — remove or implement dead constants
├── blockchain/Blockchain.ts        # MODIFY — implement COIN_MATURITY if kept
└── blockchain/Miner.ts             # MODIFY — use consistent block time
package.json                        # MODIFY — fix project name
```

**Implementation:**

1. Decide on each dead constant:
   - `MIXED_MODE_START_BLOCK`: Remove if not implementing mixed mode, or implement it
   - `POS_START_BLOCK`: Remove if using `POW_CUTOFF_BLOCK` only, or implement preparation phase
   - `COIN_MATURITY`: Implement it (coinbase outputs can't be spent for N blocks) or remove
2. Harmonize block time: use one constant everywhere
3. Fix package.json name to "blockchain-ts"
4. Search for any other dead code or unused imports across src/

**Acceptance Criteria:**

- [ ] No unused constants in config.ts
- [ ] All config constants are referenced in code
- [ ] Block time is consistent across all files
- [ ] package.json name matches project
- [ ] No unused imports or dead functions in src/
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Verify no unused exports:
grep -r "MIXED_MODE_START_BLOCK\|POS_START_BLOCK\|COIN_MATURITY" src/ --include="*.ts"
```
