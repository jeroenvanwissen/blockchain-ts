# Task F2: Logging Cleanup

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| **ID**           | `F2`                               |
| **Status**       | `[ ]`                              |
| **Priority**     | Low                                |
| **Dependencies** | None                               |
| **Branch**       | `feature/f2-logging-cleanup`       |

**Goal:**
Replace scattered `console.log` statements with proper structured logging using the winston logger already configured in the project.

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
lib/logger/                         # MODIFY — verify logger configuration
```

**Implementation:**

1. Audit all `console.log` / `console.error` / `console.warn` usage across `src/`
2. Replace with appropriate winston log levels (`error`, `warn`, `info`, `debug`)
3. Remove hash calculation logging from `Block.ts` or move to `debug` level
4. Ensure log format includes timestamp, level, and component name
5. Add configurable log level via environment variable (`LOG_LEVEL=debug`)
6. Verify that sensitive data (private keys, etc.) is never logged

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
