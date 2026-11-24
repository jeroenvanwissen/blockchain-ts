# TASK-0051: A new network shouldn't pause between the PoW phase and the first stakeable coins

Status: done
Priority: P2
Size: small
Depends on: TASK-0025
Source: found in TASK-0050 (2026-11-24)

## Why

On the main network parameters the PoW phase ends at block 100 (`POW_CUTOFF_BLOCK`). From block 101 only PoS blocks are valid, and a coin can stake once it is 8 hours old (`STAKE_MIN_AGE`). On a brand-new network the only coins are the PoW rewards, and mining 100 blocks takes about 30 to 40 minutes: the retarget lets the first 40 blocks through in about 75 seconds, then the spacing settles at 30 seconds. So the new network makes no blocks, and confirms no payments, for about 7.5 hours, until block 1's reward turns 8 hours old.

Measured in TASK-0050: a fresh node mined 47 blocks in 3 minutes on the main parameters, with blocks 30 to 40 already 5 seconds apart and slowing toward 30.

## Options

1. Lengthen the PoW phase past the stake age: for example `POW_CUTOFF_BLOCK = 1200`, about 10 hours at 30-second blocks. PoS takes over without a pause. More coins are mined by PoW before staking starts. This is closest to how kernel-PoS chains launched, with a PoW phase of thousands of blocks.
2. Keep both and document the one-time pause on a new network.
3. Lower `STAKE_MIN_AGE` (for example to 30 minutes): shorter pause, but less protection against grinding with fresh coins.

All three are consensus parameters: every node of a network must use the same values, and changing them needs a new data dir (no persistent network exists yet).

## Decision

Option 1 (owner, 2026-11-24): `POW_CUTOFF_BLOCK = 1200`.

## Acceptance criteria

- [x] On the main parameters the PoW phase outlasts `STAKE_MIN_AGE`, so the first PoW coins can stake when it ends. A test runs the phase through the real retarget and fails on the old cutoff.
- [x] A node upgraded with a data dir from before doesn't trust state validated under the old rules: blocks the new rules reject are dropped at startup, and the PoW phase goes on.
- [x] Nodes on the old and new rules refuse to peer instead of banning each other.
- [x] README and AGENTS.md describe the new phase length and the upgrade.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`, `npm run docker:check`, and an upgrade run: a data dir written by the previous version opened by this one, and an old node peering with a new one.

## Outcome

**PoW phase**
- `POW_CUTOFF_BLOCK` is 1200: about 10 hours of 30-second blocks, against an 8-hour `STAKE_MIN_AGE`. Regtest keeps 20 blocks and no stake age.
- `Target.test.ts` mines the phase at a constant hash rate, each block taking its expected time under `requiredBits`, and checks that block 1's coinbase is old enough to stake before block 1200. Simulated lengths of the phase:

  | Hash rate | PoW phase | Blocks before the spacing reaches 25 s |
  | --------- | --------- | -------------------------------------- |
  | 10 kH/s   | 9.9 h     | 26                                     |
  | 1 MH/s    | 9.6 h     | 64                                     |
  | 1 GH/s    | 9.1 h     | 119                                    |
  | 1 TH/s    | 8.7 h     | 175                                    |

  A faster miner starts further below its difficulty, so more early blocks come quickly; even so, the phase stays over 8 hours. With the old cutoff of 100 the test fails at every rate.
- The unit test that mined the whole PoW phase uses a 12-block cutoff now and also checks that a PoW block after it is refused.

**Upgrading**
- The chainstate records the rules it was validated under (`ChainRules`: PoW cutoff and stake age; `CHAINSTATE_VERSION` 2). Startup ignores a saved chainstate from other rules (warning `ignoring the saved chainstate: validated with other consensus rules (...)`) or from version 1, and validates every stored block. Blocks the new rules reject, such as PoS blocks inside the longer PoW phase, are dropped, and the node continues from the last valid block.
- `Chainstate.test.ts`: a chain that staked after a 12-block PoW phase, reopened with a 22-block phase, falls back to block 12, keeps mining PoW, and starts from its new chainstate the next time.
- `PROTOCOL_VERSION` is 3, so nodes on the old and the new rules disconnect at the handshake (`protocol version ...`) instead of rejecting each other's blocks.

**Found while verifying:** an old and a new node redialed each other every second. A connection that opened and was then refused at the handshake restarted the reconnect backoff at its first, 1-second step, so a configured peer on another protocol version, or one that had banned the node, was redialed every second for as long as the node ran. The backoff now carries over until a handshake completes (`P2PServer._redials`). In the upgrade run the redials came 1, 2, 4 and 8 seconds apart. `PeerPolicy.test.ts` covers a peer that refuses every handshake; with the old behavior it redials without end.

## Runs

- `npm run check`: 37 suites, 389 tests, lint clean.
- `npm run smoke`, `npm run e2e` (height 26, 6 PoS blocks), `npm run docker:check`: pass. After the backoff fix: `npm run smoke`, `npm run e2e` (height 27, 7 PoS blocks), `npm run network:check`: pass.
- Upgrade run with the previous version (`main` at fefa5dc) in a worktree, main parameters:
  1. The previous version mined 29 blocks and saved a version-1 chainstate.
  2. This version on the same data dir: `ignoring the saved chainstate: unsupported version 1`, validated the 29 blocks, mined on to 34, and saved a version-2 chainstate.
  3. The next start: `chainstate at height 34; validated 0 newer block(s)`.
  4. A previous-version node and a new one: each logs `Disconnecting peer: protocol version ...` for the other; no bans, no misbehavior.

