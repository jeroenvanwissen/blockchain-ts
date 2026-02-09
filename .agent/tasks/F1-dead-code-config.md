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

- `MIXED_MODE_START_BLOCK = 80` — defined in config.ts but never imported anywhere
- `POS_START_BLOCK = 90` — defined in config.ts but never imported anywhere
- ~~`COIN_MATURITY = 10` — never referenced in code~~ — **RESOLVED**: now used in `Blockchain.ts` (task A4)
- ~~`TARGET_BLOCK_TIME = 375` in Miner.ts conflicts with `BLOCK_TIME`~~ — **RESOLVED**: Miner now uses `blockchain.BLOCK_TIME` from config
- package.json name says "blockchain-js" but project is "blockchain-ts"
- Unused RSA key generation in `mine.ts` (generates keys that are never used)

**Scope:**

```
src/
├── config.ts                       # MODIFY — remove or implement dead constants
├── blockchain/Blockchain.ts        # MODIFY — implement COIN_MATURITY if kept
└── blockchain/Miner.ts             # MODIFY — use consistent block time
package.json                        # MODIFY — fix project name
```

**Implementation:**

1. Decide on remaining dead constants:
   - `MIXED_MODE_START_BLOCK`: Remove if not implementing mixed mode, or implement it
   - `POS_START_BLOCK`: Remove if using `POW_CUTOFF_BLOCK` only, or implement preparation phase
   - Note: `COIN_MATURITY` and block time conflicts are already resolved
2. Fix package.json name to "blockchain-ts"
3. Remove unused RSA key generation in `mine.ts`
4. Search for any other dead code or unused imports across src/

**Note on dependency:** The dead config constants (`MIXED_MODE_START_BLOCK`, `POS_START_BLOCK`) could be removed independently of C2 if the decision is to simply delete them. Only implementing them requires C2 to define the transition behavior first.

**Acceptance Criteria:**

- [ ] No unused constants in config.ts (`MIXED_MODE_START_BLOCK`, `POS_START_BLOCK` resolved)
- [ ] All config constants are referenced in code
- [x] Block time is consistent across all files — resolved (Miner uses `blockchain.BLOCK_TIME`)
- [ ] package.json name matches project (currently "blockchain-js")
- [ ] No unused imports or dead functions in src/ (including RSA keygen in mine.ts)
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Verify no unused exports:
grep -r "MIXED_MODE_START_BLOCK\|POS_START_BLOCK\|COIN_MATURITY" src/ --include="*.ts"
```
