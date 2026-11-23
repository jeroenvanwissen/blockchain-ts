# TASK-0007: Block header with merkle root and compact target

Status: pending
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

- [ ] Changing any transaction changes the merkle root and invalidates the PoW.
- [ ] Changing `bits` or `time` invalidates the hash.
- [ ] Miner and validator share one header-hash function.
- [ ] Chain-work comparison uses `bigint`.

## Validation

`npm test`, `npm run smoke` with mining.

## Notes

Breaks stored data. Needs a new genesis.
