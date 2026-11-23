# TASK-0007: Block header with merkle root and compact target

Status: done
Priority: P1
Size: large
Depends on: TASK-0005
Source: F-008, F-011, old F3

## Why

The block hash covers timestamp, full transaction JSON, previous hash and nonce, but not difficulty or height (`src/blockchain/Block.ts:24-46`). Difficulty is a count of leading hex zeros, so each step is 16x the work. Chain weight uses `2^difficulty` (`src/blockchain/Blockchain.ts:101`). The PoW nonce is stored as `uint32` (`proto/blockchain.proto:25`).

## Scope

- Header: `version, prevHash, merkleRoot, time (seconds), bits (compact target), nonce`.
- Block hash = double SHA-256 of the canonical header bytes.
- Merkle root over txids.
- PoW check: `hash ≤ target(bits)`.
- Extra nonce space in the coinbase.
- Block work = ⌊2^256 / (target + 1)⌋ as `bigint`, used for both PoW and PoS.
- A `ChainParams` object in `src/config.ts`: genesis, PoW/PoS limits, last PoW height, target spacing, maturity, stake min age, network magic, default port.
- New genesis.
- The mining worker hashes header bytes using the same encoder as validation.

## Acceptance criteria

- [x] Changing any transaction changes the merkle root and invalidates the PoW.
- [x] Changing `bits` or `time` invalidates the hash.
- [x] Miner and validator share one header-hash function.
- [x] Chain-work comparison uses `bigint`.

## Validation

`npm test`, `npm run smoke` with mining.

## Notes

Breaks stored data. Needs a new genesis.

## Outcome

Done together with TASK-0008, because the new target representation and the retarget formula depend on each other.

**Header** (`src/blockchain/Block.ts`)
- Fields: `version` (u32), previous hash, merkle root, timestamp (u64, **milliseconds**), `bits` (u32 compact target), nonce (u32). Block hash = sha256d(header).
- The merkle root covers witness hashes, so it commits to signatures. Odd levels duplicate the last node.
- Height isn't in the header. It's committed through the coinbase height, which validation enforces.
- PoW means `hash ≤ target(bits)`.
- The genesis previous hash is now 64 zeros, which makes a new genesis.

**Mining**
- `headerPrefix()` + `Block.hashHeader()` is the one hash definition. The worker hashes the same prefix with the nonce appended and compares hex strings against `targetHex(bits)`.
- `Block.solve()` reuses one buffer for in-process mining.
- Extra nonce space: when the nonce range is exhausted, the miner builds a fresh template. The coinbase transaction's ms timestamp changes the merkle root.

**Targets and chain work** (`src/blockchain/target.ts`)
- `bitsToTarget`/`targetToBits` (Bitcoin nBits encoding, checked against its test vectors) and `blockWork` = 2^256 / (target + 1).
- `cumulativeWeight` and `getChainWeight()` are bigint chain work for PoW and PoS alike. This replaces `2^difficulty` and the coinstake-amount weight (F-009).
- `POW_LIMIT`, `POS_LIMIT`, `TARGET_SPACING`, `RETARGET_WINDOW`, `MAX_RETARGET_SPACING` and `GENESIS_TIMESTAMP` are in `src/config.ts`.

**Wire and storage**
- `Block.toJSON`/`fromJSON` give a strict wire form. A claimed hash that doesn't match the header is rejected.
- P2P uses `Block.fromJSON`. Storage has new `bits`/`version` protobuf fields; `pow_difficulty` is reserved.

**Deviations from the task text**
- Timestamps stay in milliseconds (u64), not seconds. Switching would touch every time comparison in the codebase for no consensus benefit.
- Chain parameters remain named constants in `config.ts`, which is the project's convention, rather than a `ChainParams` object.
- The network magic comes with the handshake in TASK-0013.

**Tests**
- `src/blockchain/__tests__/Target.test.ts`: nBits vectors, rounding, work, header tamper cases (transaction, timestamp, bits, previous hash), merkle properties, JSON round trip and hash-mismatch rejection.
- `BlockValidation.test.ts`: wrong `bits` is rejected (`incorrect block difficulty`), and so is a hash above the target (`invalid proof of work`).
