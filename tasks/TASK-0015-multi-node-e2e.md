# TASK-0015: Multi-node end-to-end test

Status: done
Priority: P1
Size: medium
Depends on: TASK-0004, TASK-0010, TASK-0013, TASK-0014
Source: F-016

## Why

Nothing currently checks that several real nodes agree on a chain. This test is the definition of "the network works".

## Scope

Add `npm run e2e`. It spawns two or three real node processes in temp dirs with accelerated chain params (low last-PoW height, short spacing, short stake age). The scenario:

1. Mine past the PoS cutoff.
2. Stake.
3. Send a transaction.
4. Partition one node, let both sides produce blocks, then reconnect (reorg).
5. Restart a node.

Assert that the tips and UTXO sets converge.

## Acceptance criteria

- [x] The scenario passes repeatably on a developer machine within a few minutes.
- [x] Failures print each node's tip, height and last log lines.

## Validation

`npm run e2e` (new).

## Outcome

**`npm run e2e`** (`src/e2e.ts`; process helpers shared with smoke in `src/nodeHarness.ts`)
- Three real node processes run on the new regression-test network:
  - `--regtest` sets network id `blockchain-ts/regtest`, `powCutoffBlock` 20 and `minStakeAge` 0. Confirmations and maturity stay at 10.
  - There's no wallet API yet (TASK-0016/0017), so an in-process harness peer (Blockchain + P2PServer) follows the network and submits the payment.
- Steps:
  1. A mines and stakes; B and C stake and join through A.
  2. The harness signs a payment from A's wallet file: 12 separate 1-coin outputs to C, so C has enough outputs to keep staking alone.
  3. Proof of stake starts after block 20, and both A and C stake.
  4. C is partitioned by restarting it on a new port with no peers, and stakes 2 blocks alone; A and C diverge.
  5. C reconnects: one node reorganizes and the tips of A, B and C converge.
  6. A restarts, loads its chain and converges again.
  7. The harness checks the payment is in the converged chain, C holds at least 12 coins, and the chain is valid.
- Node tips are read from each node's `VERSION` message, so no API is needed. On failure the script prints each live node's height, tip and last 40 log lines.
- Runs: before the staking-timer fix (item 3 below), one PASS (about 3 min 50 s, height 33) and one FAIL (C never won a slot). After it, two PASS runs in a row, the second in 122 s; both ended at height 26 with 6 PoS blocks, a same-slot side block at height 24, and a reorg when C reconnected.

**Fixes found by the scenario**
1. **Equal-work ties go to the lower tip hash.** First-seen meant that at the start of PoS, when every staker wins every slot because the target starts at its limit, simultaneous stakers stayed split indefinitely. A shared `_isBetter` is used by acceptance and by startup branch selection.
2. **A PoS block's timestamp must be later than its parent's.** This is the past-time limit of BlackCoin's protocol v2. With the median-time rule alone, a staker could chain about 6 blocks inside one 16 s slot (each new tip brings a new modifier and fresh kernel chances). `createStakeBlock` skips slots not after the tip. Height reached 93 in 3 minutes before the fix.
3. **Staking checks run on wall-clock second boundaries** (node behavior, not consensus). With free-running 1 s timers, the node whose timer fired first after a slot started always won it: the others received its block before they tried, so same-slot candidates never met and the tie-break never chose. In one run A staked blocks 21 to 32 while C, eligible from block 24, staked none. `StakingService` now schedules each check just after the next multiple of `STAKE_CHECK_INTERVAL` (plus `STAKE_CHECK_OFFSET`, 20 ms), so all stakers try a slot together.

**Related test changes**
- Reorg tests now predict tie outcomes from the hashes, and there's a new test showing the lower hash wins whatever the arrival order.
- The two-staker staking test simulates both stakers building on the same tip each slot, with fork choice keeping one.
- New PoS test: at most one PoS block per slot.
- New staking test: checks land on interval boundaries whenever the service starts.

**Note:** with only one coin, an isolated staker can't extend a chain by itself, because each staked output waits 10 confirmations. That's expected PoS behavior, and it's why the scenario pays C 12 outputs.

`npm test`: 17 suites, 232 tests.
