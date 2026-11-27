# TASK-0056: Tests for every PoS block rule

Status: pending
Priority: P1
Size: small
Depends on: none
Source: F-056 (reassessment 3, 2026-11-27)

## Why

`_connectBlock` and `_checkSideBlock` enforce the PoS rules, but no test reaches eleven of their errors. Only "kernel input is too young to stake" and "invalid block signature" are tested. TASK-0057 and TASK-0058 move PoS checks earlier (onto side blocks); without tests, a check that gets lost on the way goes unnoticed.

## Scope

Add a test that builds an otherwise valid block breaking each rule, and expects its error:
- `kernel does not meet the stake target`
- `kernel input is missing or spent`
- `kernel input does not have enough confirmations`
- `coinstake must return the stake to the kernel owner`
- `coinstake timestamp must equal the block timestamp`
- `coinstake is only valid as the second transaction`
- `coinstake timestamp is earlier than the kernel input`
- `kernel input public key does not own the stake`
- `coinbase height does not match`
- `PoW blocks must not carry a block signature`
- `wrong consensus type for this height` (side path)

No rule changes.

## Acceptance criteria

- [ ] Each rule above has a test that fails if the rule is removed (checked by deleting each check once).
- [ ] The tests build blocks through the integration helpers (`openPosChain`, `stakeBlocks` or similar), not by mocking validation.

## Validation

`npm run check`.

## Notes

`src/__tests__/integration/ProofOfStake.test.ts` and `BlockValidation.test.ts` are the natural homes.
