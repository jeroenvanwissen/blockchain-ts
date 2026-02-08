# Security Requirements

## Secrets Management

- Private keys are stored in `data/wallet.json` — currently unencrypted (improvement planned in task B4)
- Never log private keys, wallet file contents, or key material
- Create timestamped backup before overwriting wallet: `wallet.json.{timestamp}.backup`
- Wallet files should have restricted permissions (`0600`) — not currently enforced (task B4)
- Never include `data/` directory contents in version control (covered by `.gitignore`)

## Cryptographic Operations

- Use Node.js built-in `crypto` module for SHA256 hashing
- Use `secp256k1` library for ECDSA signing and verification
- Address generation: SHA256 → RIPEMD160 → Base58Check encoding
- Never use `SHA256(data + privateKey)` as a signature — use proper ECDSA (fix planned in task A1)
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
- PoS: verify validator eligibility based on stake weight and age
- Enforce `POW_CUTOFF_BLOCK` — reject wrong consensus type for block height
- Validate coinbase transaction: exactly one per block, correct reward amount
- Prevent double-spending: check both UTXO set and pending transactions

## Data Protection

- Chain data in `blockchain_data.json` — integrity verified by hash chain
- Never store sensitive data in log output
- Verify genesis block hash on chain load from disk
- Sanitize file paths from user input (data directory argument)

## Do / Don't

| Do                                                  | Don't                                                |
| --------------------------------------------------- | ---------------------------------------------------- |
| Use `secp256k1.ecdsaSign()` for transaction signing  | Concatenate hash + private key as a "signature"      |
| Validate address checksum before accepting            | Trust address format from external input             |
| Use type guards on all P2P message data               | Cast incoming data to expected types directly        |
| Check UTXO existence before accepting transactions    | Allow spending of non-existent or already-spent UTXOs |
| Verify block hashes match recalculated values         | Trust hash fields in received blocks                 |
| Lock shared state with mutex during modifications     | Read/write shared maps without synchronization       |
