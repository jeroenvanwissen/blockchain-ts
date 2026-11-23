# TASK-0010: Staking loop in the node

Status: pending
Priority: P1
Size: medium
Depends on: TASK-0009
Source: F-003

## Why

After the last PoW block, only the staking loop can extend the chain. The current `StakingService` depends on the stake map that TASK-0011 removes, and it retries on a fixed timer.

## Scope

- Rewrite `StakingService` behind a `--stake` flag.
- On each masked timestamp step, try the kernel for every mature wallet UTXO.
- On a hit: build the coinstake and block (including mempool transactions), sign, submit through the normal block path, and broadcast.
- Abandon the attempt when the tip changes.

## Acceptance criteria

- [ ] With accelerated chain params, a single node moves from PoW to PoS at the last PoW height and keeps producing PoS blocks near the target spacing.
- [ ] With two stakers, both produce blocks over a long simulated run (loose proportionality bound).

## Validation

`npm test`; extended `npm run smoke`.
