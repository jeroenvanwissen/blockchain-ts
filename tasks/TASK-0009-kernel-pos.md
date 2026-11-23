# TASK-0009: Kernel-based proof of stake

Status: pending
Priority: P1
Size: large
Depends on: TASK-0006, TASK-0007, TASK-0008, TASK-0011
Source: F-006, F-007, F-009, F-010

## Why

The current PoS uses a node-local stake map (F-006). It classifies blocks by the shape of `tx[1]`, which lets a mempool stake transaction turn a PoW block into an unchecked "PoS" block (F-007). It doesn't bound the coinstake's change output, and it uses the coinstake amount as chain weight (F-009). It also reads the wall clock (F-010).

## Scope

Peercoin/BlackCoin-style kernel PoS, with every input taken from chain data.

**PoS block layout**
- `tx[0]` is an empty coinbase.
- `tx[1]` is the coinstake. `vin[0]` is the kernel UTXO, which must have the minimum confirmations and minimum age. `vout[0]` is an empty marker. The remaining outputs pay the staker.
- Coinstake outputs ≤ inputs + reward + fees.

**Kernel**
- Kernel hash = H(stakeModifier ‖ prevTxTime ‖ prevout.hash ‖ prevout.n ‖ blockTime). It must be ≤ target(bits) × kernel value.
- The stake modifier for each block is H(kernelHash ‖ prevModifier). It is kept in the block index and derived during validation, never trusted from the wire.
- Block time is masked to 16 s steps, which limits how many kernel hashes can be tried per period.

**Signatures**
- A PoS block carries a signature over the header hash by the key that owns `vout[1]`. A PoW block must carry none.

**Height rules and coinstake handling**
- Reject PoS at or below the last PoW height, and PoW above it.
- The coinstake shape is invalid anywhere except `tx[1]` of a PoS block.
- Coinstake outputs mature like coinbase outputs.

## Acceptance criteria

- [ ] F-006 and F-007 regression tests pass. A restarted node validates the next PoS block. A PoS block below the cutoff is rejected.
- [ ] A block signed by a key that doesn't own the coinstake output is rejected.
- [ ] A coinstake paying out more than inputs + reward + fees is rejected.
- [ ] PoS validation reads no wall-clock time.

## Validation

`npm test`; single-node PoW→PoS run with accelerated chain params.

## Notes

Decided 2026-11-23: PoS pays a fixed 10 coins per block (`POS_BLOCK_REWARD`), not coin-age based.
