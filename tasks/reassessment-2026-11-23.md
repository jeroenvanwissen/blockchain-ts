# Project reassessment: blockchain-ts

Date: 2026-11-23 (after TASK-0001 to TASK-0024)
Scope: `main` at `5076d2d`: `src/`, scripts, docs. The question was what still stands between this node and a network people could rely on, now that every task from the [first assessment](assessment-2026-11-23.md) is done.
Confidence: consensus, P2P, API and wallet code reread. F-021 was reproduced as a regression test. The other findings are from code reading. Their impact estimates are inferences and marked as such; nothing was benchmarked.

## Summary

The node works end to end. It mines, moves to proof of stake, syncs, relays, survives partitions and restarts, and sends and encrypts from its wallet. `npm run check` (284 tests), `npm run smoke` and `npm run e2e` pass.

The remaining risks fall into three groups:
- **Consensus:** one hole lets a miner skip the minimum stake age (F-021). The equal-work tie-break can be gamed (F-022).
- **Security:** the wallet API can be reached across a network over plain HTTP if someone binds it there (F-023).
- **Cost:** several costs grow with the chain or the mempool (F-024 to F-026).

Fix F-021 first; it's a consensus rule an attacker can exploit today.

## Key findings

Finding IDs continue the first assessment's numbering. Severity is the impact if left unfixed; priority is P0 now, P1 next, P2 planned, P3 later.

| ID | Finding and evidence | Severity | Priority | Confidence | Next step |
| --- | --- | --- | --- | --- | --- |
| F-021 | **Stake age can be skipped.** Minimum stake age and the kernel are measured from the timestamp of the transaction that created the output (`Blockchain.ts` `_checkProofOfStake`, `createStakeBlock`), and nothing constrains transaction timestamps: not against their block, not against their inputs. A miner gives its coinbase timestamp 0 and stakes it 15 minutes later instead of after 8 hours. Reproduced in `ConsensusAttacks.test.ts` (`test.failing`). The design follows Peercoin/BlackCoin, which bound transaction times by the block time and by their inputs, and measure age from the block that created the output. | High | P1 | verified | TASK-0025 |
| F-022 | **The equal-work tie-break can be gamed.** Equal work goes to the lower tip hash (`Blockchain._isBetter`). A producer can try many block variants (transaction choice and order, coinstake split) and publish the lowest hash, winning every tie. Ties happen at every slot while the PoS target is at its limit (start of PoS, regtest), and otherwise only when two stakers hit the same slot. | Medium | P2 | verified (code) | TASK-0026 |
| F-023 | **Wallet routes reachable across a network.** With `API_HOST` set to a non-loopback address, `POST /wallet/send`, `unlock` and `encrypt` accept any client holding the token (`ApiServer._handle`). The token, and the passphrase on unlock, travel over plain HTTP. The default (`127.0.0.1`) is safe; the README only says the chain routes can be exposed. | Medium | P2 | verified (code) | TASK-0027 |
| F-024 | **Mempool revalidation re-verifies every signature on every new tip.** `_readmitTransactions` runs each pending transaction through `_addTransactionInternal`, including `transaction.validate()` (ECDSA per input). With a full 8 MB mempool (tens of thousands of transactions), that's an estimated seconds of CPU per block on the event loop. Inference, not measured. | Low | P3 | inferred | TASK-0028 |
| F-025 | **Startup replays the whole chain with full validation.** `loadBlockchain` → `_replayChain` re-verifies every signature and kernel at every start. Fine at today's heights; grows linearly with the chain. Inference, not measured. | Medium (grows) | P3 | inferred | TASK-0029 |
| F-026 | **Block requests aren't throttled.** Each `GET_BLOCKS` serializes up to 200 blocks, calling `JSON.stringify` per block just to measure size (`P2PServer._handleGetBlocks`). A peer can repeat it without limit or misbehavior points. | Low | P3 | verified (code) | TASK-0030 |
| F-027 | **Bans are lost on restart** (`P2PServer._banned` is in memory only). | Low | P3 | verified (code) | TASK-0030 |
| F-028 | **Confirmed transaction lookup scans the chain** (`Blockchain.findTransaction`). | Low | P3 | verified (code) | TASK-0031 |
| F-029 | **An encrypted wallet's passphrase can't be changed**, and the only way out is a new wallet. | Low | P3 | verified (code) | TASK-0032 |
| F-030 | **No CI.** `.github/` has only Dependabot; `npm run check` runs only when someone remembers. | Low | — | verified | Owner decision |

## Architecture and documentation

AGENTS.md, the README and the task files match the code; each task's outcome records what changed and how it was verified. The first assessment stays as the historical record. This file adds findings without editing it.

## Validation performed

- `npm run check` (build, 284 tests, lint): pass. `npm run smoke`: pass. `npm run e2e`: pass (78 s), all at `578c15b`, the same code as `5076d2d`.
- F-021: `ConsensusAttacks.test.ts` "should measure stake age from block time": the attack block is accepted ("promise resolved instead of rejected"), recorded as `test.failing`.

## Recommended sequence

1. TASK-0025 (F-021): consensus hole.
2. TASK-0026 (F-022) and TASK-0027 (F-023): fairness and exposure.
3. TASK-0028 to TASK-0032: costs and conveniences, in any order.

## Open questions

- CI (F-030): add a GitHub Actions workflow that runs `npm run check` and smoke? That's the owner's call.
