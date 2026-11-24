# TASK-0051: A new network shouldn't pause between the PoW phase and the first stakeable coins

Status: todo (waiting for the owner's decision)
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
