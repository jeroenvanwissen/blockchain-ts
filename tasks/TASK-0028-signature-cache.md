# TASK-0028: Mempool revalidation without re-verifying signatures

Status: done
Priority: P3
Size: small
Depends on: TASK-0019
Source: F-024 (reassessment 2026-11-23)

## Why

Every new tip runs each pending transaction through admission again, including ECDSA verification of every input. Connecting a block verified its transactions' signatures once more, though most had been verified when they entered the mempool. With a full mempool this cost CPU on the event loop at every block.

## Scope

- Verify a transaction's signatures once per exact witness bytes, for both mempool admission and block validation.
- Bound the cache; never let it vouch for different bytes.

## Acceptance criteria

- [x] Revalidation and connecting a block of already-verified transactions don't verify signatures again.
- [x] A copy with the same txid but a different signature is verified (and rejected).
- [x] Measured improvement for a large mempool.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

- `Blockchain._validateTransaction` is used by `_connectBlock` and `_addTransactionInternal`:
  - it runs the structural checks (`tx.validate(true)`) first, so their error messages come first
  - it then looks up the witness hash (data, keys and signatures) in `_verifiedSignatures`, and runs `tx.verifySignatures()` only on a miss
  - the cache holds `SIGNATURE_CACHE_SIZE` (50,000) entries, oldest dropped first
- A witness that can't be encoded isn't cached; signature verification reports it.
- `Transaction.validate(skipSignatures)` and the new `verifySignatures()` split structure from ECDSA. Direct callers of `validate()` still get both.
- Safety: a signature's validity depends only on the bytes the witness hash commits to (the txid, the key and the signature). A cache hit therefore means the same check already passed.
- Measured (throwaway benchmark, 1004 pending one-input transactions): revalidation took 148.5 ms with an empty cache and 44.2 ms with a warm one. The rest is input lookups, address hashing and serialization.

**Tests** (`integration/SignatureCache.test.ts`)
- Two payments are verified once each at admission, and not again on revalidation or when the block containing them connects.
- A copy of a cached payment with a tampered signature (same txid) is rejected with "invalid input signature".

**Runs**
- `npm run check`: 27 suites, 295 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 85 s (height 25, 5 PoS blocks).
