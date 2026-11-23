# TASK-0014: Relay validated transactions and blocks

Status: done
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

- [x] With nodes connected A–B–C, a transaction submitted at A reaches C's mempool with the same txid.
- [x] A block produced at A reaches C.
- [x] Nothing is rebroadcast indefinitely.

## Validation

`npm test`; three-node run (TASK-0015).

## Outcome

**Relay rules**
- Transactions and blocks are relayed only after the node accepts them (into the mempool or the block tree), to every ready peer except the sender.
- A bounded seen cache (`RELAY_SEEN_CACHE_SIZE` = 20,000 recent `b:<hash>` / `t:<txid>`) drops duplicates, echoes and repeatedly sent invalid items without re-validating them.
- `broadcastBlock` and `broadcastTransaction` mark the node's own items as seen.
- Serialization is preserved: `Transaction.fromJSON`/`toJSON` round-trips to the same txid and witness hash (TASK-0005), and the integration test checks the txid at the far end.

**Tip announcement after sync:** when a node finishes catching up through `BLOCKS` batches, it announces its new tip to its other peers. A peer that lacks the parent then fetches the gap with `GET_BLOCKS`. This closed a real gap the line test exposed: if C handshook with B before B had synced from A, C stayed behind because synced blocks were never announced.

**Tests**
- `P2PServer.test.ts`:
  - a transaction is relayed to the other peer but not the sender;
  - a rejected transaction isn't relayed;
  - each transaction is processed once across peers;
  - echoes of the node's own broadcasts are ignored;
  - a block is relayed but not back to the sender.
  An `afterEach` now closes the server, so handshake timers don't fire after tests.
- New `src/__tests__/integration/Relay.test.ts` runs three real nodes in a line, with discovery stubbed so the line stays a line. C syncs through B. A transaction from A reaches C's mempool with the same txid, and a block from A reaches C and confirms it. Each node handles each item exactly once (A 0, B 1, C 1).
- `npm test`: 17 suites, 229 tests.
