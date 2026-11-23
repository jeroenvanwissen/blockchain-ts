# TASK-0014: Relay validated transactions and blocks

Status: pending
Priority: P1
Size: medium
Depends on: TASK-0005, TASK-0013
Source: F-011, F-013, old D2

## Why

Transactions are never relayed. The transaction handler rebuilds a transaction without its `timestamp` and `nonce`, so the txid changes in transit (`src/networking/P2PServer.ts:479`). Blocks are rebroadcast to every socket, including the one they came from.

## Scope

- Relay a transaction or block only after it has been accepted, to every peer except the sender.
- Keep a seen-hash cache to stop loops.
- Preserve exact serialization end to end.

## Acceptance criteria

- [ ] With nodes connected A–B–C, a transaction submitted at A reaches C's mempool with the same txid.
- [ ] A block produced at A reaches C.
- [ ] Nothing is rebroadcast indefinitely.

## Validation

`npm test`; three-node run (TASK-0015).
