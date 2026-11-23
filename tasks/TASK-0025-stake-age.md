# TASK-0025: Bound transaction timestamps; measure stake age from block time

Status: done
Priority: P1
Size: medium
Depends on: TASK-0009
Source: F-021 (reassessment 2026-11-23)

## Why

Minimum stake age was measured from the timestamp of the transaction that created an output, and nothing constrained transaction timestamps. A miner could give its coinbase timestamp 0 and stake it after 15 minutes instead of 8 hours. Anyone could do the same with a backdated self-payment once it had 10 confirmations. Reproduced as a regression scenario.

## Scope

Peercoin/BlackCoin rules:
- A transaction's timestamp is never later than its block's.
- It is never earlier than the transactions whose outputs it spends.
- Stake age counts from the time of the block that created the output.

Producers and wallets must follow the rules: templates take only transactions dated at or before the block, and payments are dated no earlier than their inputs. The mempool refuses far-future transactions, which could never confirm.

## Acceptance criteria

- [x] The F-021 scenario is rejected, and its regression test is a plain `test`.
- [x] Blocks with a transaction dated after the block, or dated before an output it spends, are rejected; so are such transactions in the mempool.
- [x] Honest mining, staking and payments keep working (smoke, e2e).

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**Consensus (`Blockchain`)**
- `UTXO.blockTimestamp` records the creating block's time. `_checkProofOfStake` and `createStakeBlock` measure `minStakeAge` from it. The coinstake still can't be dated before the kernel input's transaction.
- `_connectBlock`: every transaction, coinbase included, must satisfy `tx.timestamp ≤ block.timestamp`.
- `_checkInputs` (blocks and mempool): `tx.timestamp ≥` the `txTimestamp` of every output it spends.
- The kernel hash is unchanged, still using the input transaction's time as BlackCoin does. Existing PoS blocks therefore stay valid, and that time is now bounded by the two rules above.
- `PROTOCOL_VERSION` 2, so nodes on the old rules stop peering with upgraded ones. No new genesis: stored blocks that break the new rules are dropped at load (README troubleshooting).

**Policy and producers**
- The mempool refuses transactions dated more than `MAX_FUTURE_BLOCK_TIME` ahead.
- `_selectForBlock` takes only transactions dated at or before the block. This matters for PoS blocks, whose timestamp is the start of their 16 s slot: a payment made mid-slot waits for the next block.
- `buildPayment` dates payments `max(now, inputs' transaction times)`, so a payment spending an output from a node whose clock runs ahead stays valid.

**Tests**
- `ConsensusAttacks.test.ts` F-021 is now a plain `test`. A coinbase backdated to 0, staked after 15 minutes, is rejected with "too young to stake".
- `integration/TransactionTime.test.ts` covers:
  - a transaction dated after its block, rejected
  - a transaction dated before its input, rejected in the mempool and in a block
  - far-future transactions kept out of the mempool
  - templates holding back a transaction dated after them
  - payments dated after an input from a clock that runs ahead
- Tests that built blocks dated before their transactions now date blocks realistically. Fourteen coinbases in `Blockchain.test` get their block's timestamp, and the Api and Relay block builders never date blocks before now. A message-less `rejects.toThrow()` in `BlockValidation.test` now names its reason.

**Runs**
- `npm run check`: 26 suites, 290 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 89 s (height 26, 6 PoS blocks), with no warnings or errors from the harness peer.
