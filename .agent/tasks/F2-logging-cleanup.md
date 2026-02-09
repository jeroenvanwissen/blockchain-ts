# Task F2: Logging Cleanup

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| **ID**           | `F2`                               |
| **Status**       | `[ ]`                              |
| **Priority**     | Low                                |
| **Dependencies** | None                               |
| **Branch**       | `feature/f2-logging-cleanup`       |

**Goal:**
Replace scattered `console.log` statements (111 occurrences across 12 source files) with proper structured logging. A skeleton winston logger exists at `lib/logger.js` (CommonJS) but is never imported by any source file — it needs to be migrated to TypeScript ESM and integrated.

**Scope:**

```
src/blockchain/
├── Block.ts                        # MODIFY — remove console.log in hash calculation
├── Blockchain.ts                   # MODIFY — replace console usage with logger
├── Miner.ts                        # MODIFY — replace console usage with logger
└── Wallet.ts                       # MODIFY — replace console usage with logger
src/networking/
└── P2PServer.ts                    # MODIFY — replace console usage with logger
src/
└── index.ts                        # MODIFY — replace console usage with logger
lib/logger.js                       # MIGRATE — convert CJS to TypeScript ESM, move to src/
```

**Implementation:**

1. Migrate `lib/logger.js` (CommonJS) to TypeScript ESM at `src/logger.ts`; update the existing winston configuration to use `LOG_LEVEL` env var instead of `DEBUG`
2. Audit all `console.log` / `console.error` / `console.warn` usage across `src/` (currently 111 occurrences in 12 files)
3. Replace with appropriate winston log levels (`error`, `warn`, `info`, `debug`)
4. Remove hash calculation logging from `Block.ts` or move to `debug` level
5. Ensure log format includes timestamp, level, and component name (partially done in existing logger)
6. Verify that sensitive data (private keys, etc.) is never logged
7. Remove the old `lib/logger.js` after migration

**Acceptance Criteria:**

- [ ] No `console.log` statements remain in `src/` (except in tests)
- [ ] All logging uses winston with appropriate log levels
- [ ] Log level is configurable via `LOG_LEVEL` environment variable
- [ ] No sensitive data (private keys, wallet contents) appears in logs
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
grep -r "console\.\(log\|error\|warn\)" src/ --include="*.ts" | grep -v "__tests__" | wc -l
# Should return 0
```
