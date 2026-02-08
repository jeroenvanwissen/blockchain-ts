# Task E3: Improve Miner Integration

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| **ID**           | `E3`                               |
| **Status**       | `[ ]`                              |
| **Priority**     | Medium                             |
| **Dependencies** | None                               |
| **Branch**       | `feature/e3-miner-integration`     |

**Goal:**
Improve the miner component to be better integrated with the main node. Currently hardcoded to connect to `localhost:5001`, limiting flexibility.

**Scope:**

```
src/blockchain/
├── Miner.ts                        # MODIFY — refactor connection, add config, stats
└── miningWorker.cjs                # MODIFY — add job cancellation support
src/
├── mine.ts                         # MODIFY — add CLI argument parsing
├── config.ts                       # MODIFY — add miner configuration options
└── index.ts                        # MODIFY — optional embedded miner startup
```

**Implementation:**

1. Make miner connection address configurable via CLI argument or environment variable
2. Add support for running miner as both embedded (same process) and external (separate process)
3. Implement mining job cancellation — cancel stale jobs when a new block arrives
4. Add mining statistics logging (hashrate, blocks found, time per block)
5. Improve error handling when node is unavailable (graceful retry, not crash)
6. Add configurable mining address (CLI argument `--address` or config)
7. Ensure miner properly handles PoW-to-PoS transition (stop mining at cutoff block)

**Acceptance Criteria:**

- [ ] Miner connection address is configurable (not hardcoded)
- [ ] Mining stops gracefully at PoW cutoff block
- [ ] Mining statistics are logged (hashrate, blocks found)
- [ ] Stale mining jobs are cancelled when a new block is received
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Test configurable address:
MINER_NODE=ws://localhost:5002 npm run mine
```
