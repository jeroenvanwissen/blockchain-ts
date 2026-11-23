# TASK-0005: Canonical transaction format with verified signatures

Status: pending
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

- [ ] F-004 regression test passes: a transaction with a garbage or wrong-key signature is rejected.
- [ ] Changing an output after signing invalidates the transaction.
- [ ] txid is identical after serialize/deserialize and after a P2P round trip.
- [ ] No floating-point amounts remain in consensus code or storage.

## Validation

`npm test` (unit + integration), `npm run smoke`.

## Notes

Breaks stored data and changes addresses. Needs a new genesis.
