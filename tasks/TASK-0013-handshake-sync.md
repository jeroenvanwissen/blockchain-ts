# TASK-0013: Version handshake and incremental block sync

Status: pending
Priority: P1
Size: large
Depends on: TASK-0012
Source: F-013, old E5

## Why

Every connection receives the full chain (`src/networking/P2PServer.ts:279`). Nodes don't handle `LATEST_BLOCK`, so a node that falls behind only catches up when it reconnects (`P2PServer.ts:339-367,459-466`). There is no network or genesis check and no self-connection detection. Payload checks are shallow.

## Scope

- `VERSION`/`VERACK` exchange carrying network magic, protocol version, genesis hash, best height, a random node nonce (to detect self-connections) and the listen port. Disconnect on mismatch.
- Locator-based `GET_BLOCKS`, answered in batches, replaces full-chain dumps.
- Fetch missing parents for orphan blocks.
- Strict type guards for every payload.
- A WebSocket `maxPayload` limit.

## Acceptance criteria

- [ ] A node at height 0 syncs 500 blocks from a peer in batches.
- [ ] A peer with a different genesis is disconnected.
- [ ] A self-connection is detected and dropped.
- [ ] Malformed messages are ignored without crashing (tests).

## Validation

`npm test`; two-node smoke run.
