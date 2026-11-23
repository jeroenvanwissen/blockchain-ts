# TASK-0011: Remove the registered-stake model

Status: pending
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

- [ ] No consensus state exists that isn't derived from blocks.
- [ ] Build and tests pass.
- [ ] README status says PoS blocks are unavailable until TASK-0009.

## Validation

`npm run build`, `npm test`.

## Notes

Removes delayed unstaking and double-sign slashing, which have no equivalent in UTXO kernel staking. Needs owner confirmation.
