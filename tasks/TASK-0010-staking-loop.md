# TASK-0010: Staking loop in the node

Status: done
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

- [x] With accelerated chain params, a single node moves from PoW to PoS at the last PoW height and keeps producing PoS blocks near the target spacing.
- [x] With two stakers, both produce blocks over a long simulated run (loose proportionality bound).

## Validation

`npm test`; extended `npm run smoke`.

## Outcome

**`StakingService`** (`src/blockchain/StakingService.ts`)
- Calls `Blockchain.createStakeBlock(wallet, slot)` once per 16 s slot, and again when the tip changes within a slot (a new tip means a new stake modifier and new kernel chances).
- On a hit it submits the block through `addMinedBlock` and broadcasts it. Rejections are logged and the next slot gets a fresh attempt.
- It does nothing during the PoW phase. Its timer runs every `STAKE_CHECK_INTERVAL` (1 s), but each slot and tip pair is tried once.

**Node:** `--stake` in `src/index.ts`, and the service is stopped on SIGINT. A real node with `--mine --stake` starts and runs cleanly.

**Tests** (`src/__tests__/integration/StakingService.test.ts`, accelerated params: `powCutoffBlock` 12 or 30, `minStakeAge` 0)
- PoW → PoS exactly at the cutoff.
- 300 PoS blocks. Observed average spacing per 50 blocks: 16.0, 16.0, 16.0, 16.0, 24.2, 28.7 s, and 26.7 s over the last 100. Every slot wins while the target tightens from `POS_LIMIT`, then spacing converges toward 30 s. The test asserts 0.6–2× `TARGET_SPACING` over the last 100.
- Two stakers (100 coins against about 200) staked 81 and 119 of 200 blocks. The test asserts more than 10 each.
- One attempt per slot and tip, a retry on a new tip, and staking continues after a rejected block.

**Note:** with the default 8 h minimum age, every output (including a coinstake's own output) waits 8 h before it can stake again. A chain with few stakers or few outputs can pause until coins age, which is standard behavior in this PoS family.

`npm test`: 14 suites, 205 tests.
