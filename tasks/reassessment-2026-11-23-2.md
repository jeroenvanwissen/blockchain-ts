# Project reassessment 2: blockchain-ts

Date: 2026-11-23 (after Milestone 6 and the dependency work, TASK-0025 to TASK-0036)
Scope: `main` at `a60667c`. Process lifecycle, operability, peer handling and supported runtimes, now that consensus and the earlier findings are addressed.
Confidence: code read for each finding; dependency `engines` read from `node_modules`. Nothing was benchmarked. Impact statements marked "inferred" are reasoning, not reproduced.

## Summary

Consensus, storage, P2P limits, the API and the wallet are in good shape, and CI runs check, smoke and e2e on every push. What remains is mostly about running the node as a service:
- It ignores SIGTERM, and it keeps running half-alive when its P2P port is taken.
- The documented Node version is wrong.
- Its peer address list can be filled and steered by whoever floods it first.
- Operators can't see whether it is staking.

## Key findings

Finding IDs continue from the [first reassessment](reassessment-2026-11-23.md).

| ID | Finding and evidence | Severity | Priority | Confidence | Next step |
| --- | --- | --- | --- | --- | --- |
| F-031 | **SIGTERM isn't handled.** `src/index.ts` registers only `SIGINT`. systemd, Docker and plain `kill` send SIGTERM, which ends the process without saving the chainstate, stopping the mining worker, or closing peers and the API. | Medium | P2 | verified (code) | TASK-0037 |
| F-032 | **A taken P2P port leaves the node running without listening.** `P2PServer.listen()` resolves only on `listening`; `error` is just logged. `index.ts` calls `void p2pServer.listen()`, so a node whose port is in use keeps running, dials out, and never accepts peers. Only the absent "P2P Server listening" line shows it. | Medium | P2 | verified (code) | TASK-0037 |
| F-033 | **The documented Node version is wrong and untested.** README says Node.js 18+ and npm 9+; `package.json` has no `engines`. ESLint 10 and @eslint/js require `^20.19 \|\| ^22.13 \|\| >=24`. CI only tests Node 26. Node 18 and 20 are past end of life. | Low | P2 | verified | TASK-0038 |
| F-034 | **The peer address list can be filled and steered.** `_knownPeers` keeps up to `MAX_KNOWN_PEERS` (128) addresses in arrival order, adding any valid-looking address from any peer's `PEERS` message. Addresses are never evicted for failing, and `_fillOutbound` dials them in arrival order. A peer that floods addresses early fills the list for good and steers outbound connections (eclipse risk, inferred). | Medium | P2 | verified (code); impact inferred | TASK-0039 |
| F-035 | **Staking can't be observed.** No API or CLI output says whether the node is staking, whether its wallet is locked, how much of its balance is eligible, or when it last staked; only log lines do. | Low | P3 | verified (code) | TASK-0040 |

**Known trade-off, not a finding:** blocks may be dated up to 2 hours ahead (`MAX_FUTURE_BLOCK_TIME`). With 16 s PoS slots, a modified staker could try kernels for future slots within that window, and a miner could inflate retarget gaps (capped at 10 × target spacing). The BlackCoin design this project follows uses the same 2-hour drift and the same cap, so it stays as is.

## Validation performed

- Code reading at `a60667c` for F-031, F-032, F-034 and F-035; dependency `engines` for F-033.
- `npm run check`, smoke and e2e pass on `main`, both locally and in CI.

## Recommended sequence

1. TASK-0037 (F-031, F-032): process lifecycle, small.
2. TASK-0038 (F-033): supported Node versions in `engines`, README and CI.
3. TASK-0039 (F-034): peer address book.
4. TASK-0040 (F-035): staking status.
