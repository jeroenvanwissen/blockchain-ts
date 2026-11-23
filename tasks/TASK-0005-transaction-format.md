# TASK-0005: Canonical transaction format with verified signatures

Status: done
Priority: P0
Size: large
Depends on: TASK-0003
Source: F-004, F-011, F-012, F-020

## Why

Anyone can spend any UTXO. Inputs carry no public key, and `Transaction.verifySignature` is never called (`src/blockchain/Transaction.ts:62-88`). Validation only checks for a non-empty signature string. The txid is `JSON.stringify` over fields that include signatures, so it changes when the transaction is signed (`Transaction.ts:32-49`). Amounts are floats (`Transaction.ts:13`, `proto/blockchain.proto:11`). Addresses hash the hex string of SHA-256 instead of the bytes (`src/blockchain/Wallet.ts:81-84`).

## Scope

- Amounts are integer base units (`bigint`, 1 coin = 100,000,000 units), serialized as int64.
- Each input carries `pubKey` and `signature`.
- txid = double SHA-256 over a canonical binary encoding of the unsigned body (version, outpoints, outputs, time). Signatures are excluded, so the txid can't be malleated.
- The signature hash commits to the body and the input index.
- Verification: `hash160(pubKey)` equals the spent output's address, and `ecdsaVerify(sig, sighash, pubKey)` passes. Reject high-S signatures.
- Address = Base58Check(`0x00` ‖ RIPEMD160(SHA-256(pubKey))) using Node's `crypto`. Drop `crypto-js`.
- Remove the random tx `nonce`.
- Update the protos, the wallet and the P2P transaction handler so every field survives a round trip.

Excluded: block header changes (TASK-0007).

## Acceptance criteria

- [x] F-004 regression test passes: a transaction with a garbage or wrong-key signature is rejected.
- [x] Changing an output after signing invalidates the transaction.
- [x] txid is identical after serialize/deserialize and after a P2P round trip.
- [x] No floating-point amounts remain in consensus code or storage.

## Validation

`npm test` (unit + integration), `npm run smoke`.

## Notes

Breaks stored data and changes addresses. Needs a new genesis.

## Outcome

**Format** (`src/blockchain/Transaction.ts`)
- Amounts are `bigint` base units (`COIN` = 10^8). They're stored as protobuf `uint64` (the old `double` field number is reserved) and sent over JSON as decimal strings.
- Canonical little-endian encoding: version, timestamp, outpoints, outputs (with a length-prefixed address), then the witness data.
- `calculateHash()` (the txid) is double SHA-256 of the encoding without public keys or signatures. `witnessHash()` covers everything, and blocks commit to it (`Block.powPrefix`), so changing a signature still changes the block hash.
- Each input carries a compressed public key and a compact low-S signature over `sighash(i)` = sha256d(txid ‖ input index).
- The random tx `nonce` is gone. A coinbase instead has one null input whose `outputIndex` is the block height, which validation enforces (BIP34-style), so coinbase txids stay unique.

**Verification**
- `Transaction.isValid()` and `validate()` verify every input signature without needing chain context.
- `Blockchain._addTransactionInternal` also requires `hash160(publicKey)` to match the spent output's address.
- Block validation calls `isValid()`, so blocks with bad signatures are rejected. The UTXO check for transactions inside blocks is still TASK-0006 (F-005 stays a `test.failing`).

**Addresses** (`src/blockchain/address.ts`)
- Base58Check over RIPEMD160(SHA256(pubkey)) using Node's `crypto`. It matches the Bitcoin test vector for private key 1. `crypto-js` and `@types/crypto-js` are removed.
- Wallets re-derive their address from the public key on load.

**Wire and storage**
- `Transaction.toJSON`/`fromJSON` strictly validate the wire form.
- P2P now rejects a block if any of its transactions is malformed; before, the bad transaction was silently dropped.
- Relayed transactions keep their txid.
- `BlockStore` and `Wallet` encode 64-bit fields through `fromObject`/`longs: String`.

**Other changes**
- Block validation checks the size limit and the coinbase before the expensive signature checks.
- `Blockchain` keeps a txid index (rebuilt alongside the UTXO set). It replaces a full-chain rescan that re-hashed every transaction on each lookup.
- `Block.solve()` computes the hash prefix once, for in-process mining.
- `jest.setup.cjs` preloads `secp256k1`. Under `jest.mock('fs')` the library couldn't find its native addon and fell back to pure JS, which made `Blockchain.test.ts` take 190 s.
- Removed the dead `src/test-consensus.ts`.

**Tests**
- New `src/blockchain/__tests__/Transaction.test.ts` covers:
  - txid stability across signing;
  - tampered outputs and outpoints;
  - a wrong public key;
  - a high-S signature;
  - swapped input signatures;
  - JSON round trip with an amount above 2^53;
  - malformed wire rejection;
  - the address test vector.
- P2P tests check that a relayed transaction keeps its txid and witness hash, and that a block with a malformed transaction is dropped.
- F-004 is now two normal tests: a spend signed with another wallet's key, and a forged signature under the victim's key. F-005, F-006 and F-007 still fail on their final assertions.
- `npm test`: 9 suites, all passing, in about 5 s (37 s before this task).

**Notes**
- Old data dirs won't load (new genesis); the README troubleshooting section covers this.
- The stake registry was converted to `bigint` only as far as needed. TASK-0011 removes it.
