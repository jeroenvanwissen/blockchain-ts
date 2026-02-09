# Security Requirements

## Secrets Management

- Private keys are stored in `data/wallet.dat` (protobuf) with restricted permissions (`0600`)
- Never log private keys, wallet file contents, or key material
- Create timestamped backup before overwriting wallet: `wallet.dat.{timestamp}.backup` (max 3 kept)
- Never include `data/` directory contents in version control (covered by `.gitignore`)

## Cryptographic Operations

- Use Node.js built-in `crypto` module for SHA256 hashing
- Use `secp256k1` library for ECDSA signing and verification (`ecdsaSign` / `ecdsaVerify`)
- Address generation: SHA256 → RIPEMD160 → Base58Check encoding
- Transaction signing: SHA256 of tx hash → ECDSA sign with private key → hex-encoded signature on each input
- Validate all cryptographic inputs (key lengths, hash formats) before use

## Input Validation

- Validate addresses with `validateAddress()` using Base58Check checksum verification
- Use type guards for all wire format data: `isSerializedBlock()`, `isSerializedTransaction()`
- Validate transaction amounts are positive and inputs >= outputs
- Verify block hash matches recalculated hash on receipt
- Verify chain continuity (previous hash linkage) on sync
- Never trust data from P2P peers without validation

## Network Security

- P2P uses unencrypted WebSocket (`ws://`) — no TLS currently
- Accept connections on `0.0.0.0` (all interfaces)
- No peer authentication or whitelisting
- Validate all incoming messages against expected types before processing
- Reject malformed messages silently (don't crash)

## Consensus Security

- PoW: verify SHA256 hash has required leading zeros matching difficulty
- PoS: deterministic validator lottery — `SHA256(prevBlockHash + address + slotNumber)` < target
- Enforce `POW_CUTOFF_BLOCK` — reject wrong consensus type for block height
- Validate coinbase transaction: exactly one per block, first tx, correct reward amount (PoW/PoS)
- Coinbase maturity: outputs require `COIN_MATURITY` (10) blocks before spending
- Prevent double-spending: check both UTXO set and pending transactions
- Fork resolution: compare cumulative chain weight, not chain length
- Difficulty adjustment: proportional every 10 blocks, clamped to 4x max change
- Validate block timestamps: must be after median time of last 11 blocks, not more than 2 hours in future

## Stake Security

- Delayed unstaking: `UNSTAKE_DELAY` (100) blocks before funds are released
- Stake weight: `amount × 1.1^days` capped at `MAX_STAKE_AGE_MULTIPLIER` (4x)
- Double-sign detection: `_blockSignatures` tracks height → validator → blockHash
- Slashing: `submitDoubleSignEvidence()` removes stake and pending unstakes for offending validator
- Coinstake format: zero marker output (amount=0) + stake amount output

## Data Protection

- Chain data in `blocks/` directory — integrity verified by hash chain
- Never store sensitive data in log output
- Verify genesis block hash on chain load from disk
- Sanitize file paths from user input (data directory argument)

## Do / Don't

| Do                                                  | Don't                                                |
| --------------------------------------------------- | ---------------------------------------------------- |
| Use `secp256k1.ecdsaSign()` for transaction signing  | Concatenate data + private key as a "signature"      |
| Validate address checksum before accepting            | Trust address format from external input             |
| Use type guards on all P2P message data               | Cast incoming data to expected types directly        |
| Check UTXO existence before accepting transactions    | Allow spending of non-existent or already-spent UTXOs |
| Verify block hashes match recalculated values         | Trust hash fields in received blocks                 |
| Lock shared state with mutex during modifications     | Read/write shared maps without synchronization       |
