# TASK-0062: Checkpoints or a maximum reorganization depth

Status: pending (owner decision needed)
Priority: P2
Size: medium
Depends on: owner decision
Source: F-040 (reassessment 3, 2026-11-27)

## Why

Fork choice compares chain work only (`Blockchain._isBetter`), and `_activateBranch` reorganizes to any depth. PoS work follows the value that stakes. A branch built from genesis, where the attacker mines the cheap early PoW phase and then stakes all of its coins, outweighs an honest chain on which not every coin is online. A simulation with regtest-like parameters forced a 2,600-block reorganization and erased the honest staker's balance. This is the long-range problem of proof of stake. The Peercoin/BlackCoin-style design this project follows answers it with checkpoints. It matters once a network persists; until then a new genesis is acceptable.

## Scope

One of the following, or both, after the owner decides:
- **Checkpoints:** heights and hashes in `config.ts` for each network; a block that conflicts with a checkpoint, or a branch forking below the last one, is refused.
- **A maximum reorganization depth:** a branch forking more than N blocks below the tip is refused. A node offline for longer than that must be pointed at the right chain by hand.

## Acceptance criteria

- [ ] The long-range scenario (a branch from genesis with more work) is refused, with a regression test in `ConsensusAttacks.test.ts`.
- [ ] Honest reorganizations up to the chosen limit still work (e2e partition).
- [ ] README documents the rule and what an operator does when it bites.

## Validation

`npm run check`, `npm run e2e`.

## Notes

Decision needed: checkpoints (need a release per checkpoint; the design this project follows), a depth limit (no releases; a node that was offline long can't rejoin alone), or both. See the reassessment's open questions. This fits with TASK-0058's bound on how deep a side branch may fork.
