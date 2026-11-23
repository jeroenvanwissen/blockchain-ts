# TASK-0013: Version handshake and incremental block sync

Status: done
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

- [x] A node at height 0 syncs 500 blocks from a peer in batches.
- [x] A peer with a different genesis is disconnected.
- [x] A self-connection is detected and dropped.
- [x] Malformed messages are ignored without crashing (tests).

## Validation

`npm test`; two-node smoke run.

## Outcome

**Handshake**
- Each side sends `VERSION` on connect: `NETWORK_MAGIC`, `PROTOCOL_VERSION`, genesis hash, height, tip, a random 8-byte node nonce, and its listen port.
- A valid `VERSION` is answered with `VERACK`, and a peer is ready once both have arrived.
- A different network, protocol version or genesis, or a malformed `VERSION`, closes the socket.
- Our own nonce means a self-connection: the socket closes, the dialled address is added to our own addresses, removed from known peers, and not retried.
- Other messages are ignored until the peer is ready. Peers that don't finish within `HANDSHAKE_TIMEOUT` (10 s) are dropped.
- Inbound peers' `IP:listenPort` is added to known peers, so discovery now spreads reachable addresses.

**Sync**
- `Blockchain.getBlockLocator()` (ten dense hashes, then doubling steps, then genesis) and `getBlocksAfter(locator, max)`.
- After the handshake, a node sends `GET_BLOCKS` if the peer's tip is unknown. `BLOCKS` replies hold up to `SYNC_BATCH_SIZE` (200) blocks and at most half of `MAX_MESSAGE_BYTES`, plus a `more` flag.
- The requester accepts blocks in order (stopping at the first bad one) and continues with a locator starting from the last received hash, which also works when that block lands on a side branch.
- A relayed `BLOCK` with an unknown parent triggers `GET_BLOCKS` to that peer, replacing the old useless `GET_LATEST_BLOCK` broadcast.

**Removed:** `CHAIN` (full-chain dumps on every connect), `GET_LATEST_BLOCK`/`LATEST_BLOCK` (left over from the old miner), `sendChain` and `broadcastChain`. `Blockchain.replaceChain` stays as an API for bulk import and tests.

**Limits**
- Every payload has a strict guard: `VERSION` fields, locators (at most 64 hex hashes), block arrays (at most the batch size, with `Block.fromJSON` per block), plus the existing block, transaction and peers guards.
- Non-JSON or non-object messages are ignored.
- WebSocket `maxPayload` is `MAX_MESSAGE_BYTES` (16 MB) on the server and on outbound sockets.
- Broadcasts only go to ready peers.

**Other**
- `listen()` returns a promise, and `close()` terminates sockets, timers and reconnects, so tests can run real nodes in-process.
- Unreachable peers are logged as information, not errors. That noise showed up once nodes learned each other's listen addresses.

**Tests**
- New `src/__tests__/integration/Sync.test.ts` uses real WebSocket servers in-process:
  - a 500-block sync in at least 3 batches;
  - fetching the missing parent of a relayed block;
  - disconnecting a peer with a different genesis;
  - detecting a self-connection;
  - surviving malformed and oversized (> 16 MB) messages while still serving a good peer.
- `P2PServer.test.ts`: handshake (`VERSION`/`VERACK`, network/genesis/version/malformed rejection, self-detection, pre-handshake silence, timeout) and sync (request on an unknown tip, `GET_BLOCKS` answers and malformed requests, malformed `BLOCKS`/`BLOCK`/`TRANSACTION` ignored). The CHAIN tests were removed.
- `npm run smoke` now syncs over the handshake.
- `npm test`: 16 suites, 223 tests.
