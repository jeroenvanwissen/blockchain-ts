# TASK-0011: Remove the registered-stake model

Status: done
Priority: P1
Size: medium
Depends on: owner decision (assessment open questions)
Source: F-006

## Why

Stake lives in `_stakes`, a map that local calls and unauthenticated `STAKE`/`UNSTAKE` peer messages can change (`src/blockchain/Blockchain.ts:520-660`, `src/networking/P2PServer.ts:486-506`). It is never rebuilt from the chain. Nodes therefore disagree about stake, and a restarted node rejects valid PoS blocks. Kernel PoS (TASK-0009) needs no registry.

## Scope

Delete:
- in `Blockchain.ts`: `_stakes`, `stake()`, `unstake()`, `_pendingUnstakes`, `_blockSignatures`, `submitDoubleSignEvidence`, `calculateStakeWeight`, `totalNetworkStake`, `isEligibleValidator`;
- the `STAKE`/`UNSTAKE` message types;
- the `UNSTAKE_DELAY` and `MAX_STAKE_AGE_MULTIPLIER` config values;
- the related tests and docs.

## Acceptance criteria

- [x] No consensus state exists that isn't derived from blocks.
- [x] Build and tests pass.
- [x] README status says PoS blocks are unavailable until TASK-0009.

## Validation

`npm run build`, `npm test`.

## Notes

Removes delayed unstaking and double-sign slashing, which have no equivalent in UTXO kernel staking. Needs owner confirmation.

## Outcome

Approved by the owner on 2026-11-23, together with kernel PoS and a fixed 10-coin PoS reward.

**Removed**
- From `Blockchain`: `StakeInfo`, `PendingUnstake`, `_stakes`, `_pendingUnstakes`, `_blockSignatures`, `stake()`, `unstake()`, `getStake()`, `getStakeInfo()`, `getPendingUnstakes()`, `submitDoubleSignEvidence()`, `calculateStakeWeight()`, `totalNetworkStake()`, `isEligibleValidator()`, `canCreateStakeBlock()`, `generateStakeBlock()`, `validateStake()`, `_applyStakeTransactions()`, the `stakeCheckInterval` option and the stakes in the connect context.
- `minePendingTransactions` is PoW-only.
- The `STAKE`/`UNSTAKE` P2P messages and their handlers.
- `UNSTAKE_DELAY`, `MAX_STAKE_AGE_MULTIPLIER` and `MIN_STAKE_AMOUNT` from config.
- `src/blockchain/StakingService.ts` and its start in `index.ts`; TASK-0010 brings a new one.
- 30 registry tests in `Blockchain.test.ts` and 2 in `P2PServer.test.ts`.
- The F-006/F-007/F-009 attack tests that used `stake()`. They return in TASK-0009, rewritten for kernel staking.

**Interim state**
- `_connectBlock` rejects PoS blocks with `proof-of-stake blocks are not supported yet (TASK-0009)`.
- The only consensus state left (UTXO set, chain) is derived from blocks.

**Checks:** `npm test` (11 suites, 186 tests) and `npm run smoke` pass.
