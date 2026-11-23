# TASK-0040: Staking status in the API and CLI

Status: done
Priority: P3
Size: small
Depends on: TASK-0016
Source: F-035 (reassessment 2, 2026-11-23)

## Why

An operator couldn't tell whether a node was staking without reading its log: not whether staking was on, whether the wallet could sign, how much of the balance was eligible, how long a kernel would take, or when the wallet last staked.

## Scope

- One status view over the staking state, computed with the same rules the staker uses.
- Exposed in the API (wallet-scoped) and the CLI.

## Acceptance criteria

- [x] `GET /wallet/staking` and `cli staking` report whether staking is enabled, the wallet lock state, eligible outputs and value, the chance per slot and expected wait, blocks staked since start, and the last staked block.
- [x] Eligibility matches what `createStakeBlock` uses.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**`Blockchain`**
- `getStakeableUTXOs(address, timestamp)` holds the eligibility rules: mature, `STAKE_MIN_CONFIRMATIONS`, old enough by block time, not claimed by the mempool, not dated after the slot. `createStakeBlock` now uses it, so the status and the staker can't disagree.
- `getStakingOutlook(address, timestamp)` returns the eligible outputs and value, plus the chance that at least one output has a kernel meeting the current PoS target in a slot. Each output hits with probability min(1, target × value / 2^256). The expected wait is one slot (16 s) divided by that chance; it ignores other stakers who may win the slot first.
- `findLastStakedBlock(address)` returns the newest PoS block on the active chain whose coinstake pays the wallet, looking back up to 10,000 blocks. It comes from the chain, so it survives restarts.

**Staking service:** `StakingService.stakedCount()` counts blocks staked since start.

**API and CLI**
- `GET /wallet/staking` is a wallet route: token-protected and loopback-only, since it describes the wallet's outputs.
- The node constructs its `StakingService` before the API and passes it in; it still starts only with `--stake`.
- `cli staking` prints the status, with the expected wait in readable units.
- README (HTTP API, staking section, quick reference) and AGENTS.md updated.

**Tests**
- `StakingService.test.ts`:
  - during PoW there is no chance and no expected wait
  - at the start of PoS, every eligible output hits every slot (chance 1, expected 16 s), and the outlook's outputs and value match `getStakeableUTXOs`
  - after staking, `stakedCount` is 1 and `findLastStakedBlock` returns that block
- `Api.test.ts`: `/wallet/staking` without the token gets 401; with it, the exact fields on a PoW-phase chain.
- e2e: at the end, node A's `cli staking` reports `staking: enabled` and a last staked block.

**Runs**
- `npm run check`: 29 suites, 314 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 70 s (height 25, 5 PoS blocks), including node A's `cli staking` check.
