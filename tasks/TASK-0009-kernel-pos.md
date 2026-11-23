# TASK-0009: Kernel-based proof of stake

Status: done
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

- [x] F-006 and F-007 regression tests pass. A restarted node validates the next PoS block. A PoS block below the cutoff is rejected.
- [x] A block signed by a key that doesn't own the coinstake output is rejected.
- [x] A coinstake paying out more than inputs + reward + fees is rejected.
- [x] PoS validation reads no wall-clock time.

## Validation

`npm test`; single-node PoW→PoS run with accelerated chain params.

## Notes

Decided 2026-11-23: PoS pays a fixed 10 coins per block (`POS_BLOCK_REWARD`), not coin-age based.

## Outcome

**Rules** (`Blockchain._checkProofOfStake`, `src/blockchain/kernel.ts`)
- PoS is only allowed above `powCutoffBlock`, and the block timestamp must be a multiple of 16 s.
- The coinstake (tx[1]) must have the same timestamp as the block. Its `vin[0]` is the kernel: unspent in the pre-block UTXO set, with at least `STAKE_MIN_CONFIRMATIONS` (10) confirmations, old enough (`minStakeAge`, default `STAKE_MIN_AGE` = 8 h, measured at the block's timestamp), and its value returned to the owner in `vout[1]`.
- Kernel hash = sha256d(modifier ‖ prevTxTime ‖ prevout hash ‖ index ‖ blockTime). It must be ≤ target(bits) × value.
- The block signature is a compact ECDSA signature over the block hash by `vin[0]`'s public key, which must own the kernel. PoW blocks must carry no signature.
- Stake modifier after each block = sha256d(proof ‖ previous), where the proof is the kernel hash for PoS and the block hash for PoW; the genesis modifier is zero. It's derived in `_connectBlock` (`ConnectContext.modifiers`), kept in `Blockchain._modifiers` and rebuilt by `_replayChain`, so restarts and syncs agree (F-006).
- A coinstake is only valid as tx[1] of a PoS block, and the mempool rejects coinstakes. A coinstake-shaped transaction can therefore no longer turn a PoW-phase block into "PoS"; such a block is rejected below the cutoff (F-007).
- Coinstake outputs mature like coinbase outputs.
- Zero-value outputs, such as the coinstake marker and the genesis output, aren't added to the UTXO set.

**Production:** `Blockchain.createStakeBlock(wallet, timestamp)` tries the wallet's eligible UTXOs (skipping pending and immature ones) and returns a signed PoS block or null.

**Deviation from the task text:** the fixed 10-coin reward (owner decision) is paid in the **coinbase**, not the coinstake, so the coinstake obeys inputs ≥ outputs like every other transaction. This keeps the TASK-0006 rule that closed F-009, and the coinbase reward check stays the same for PoW and PoS.

**Options:** `allowPowAfterCutoff` was replaced by `powCutoffBlock` (default `POW_CUTOFF_BLOCK`), so tests can reach PoS without mining 100 blocks.

**Storage and wire:** the block signature is a new protobuf field (10) and a new JSON field, validated as empty or 128 hex chars.

**Tests**
- New `ProofOfStake.test.ts`:
  - a PoS block with the fixed reward;
  - continued staking with a fresh modifier each block;
  - a JSON round trip of a signed block;
  - the PoW/PoS cutoff in both directions;
  - wrong or missing signatures;
  - a timestamp off the grid;
  - a kernel that's too young;
  - coinstake maturity.
- `ConsensusAttacks.test.ts`: F-006 (restart rebuilds the modifier and validates the next PoS block), F-007 (mempool and block rejection) and F-009 (coinstake overpay) are normal tests again.
- New `Kernel.test.ts` covers the kernel inputs, value scaling and modifier chaining.
- `npm test`: 13 suites, 200 tests.
