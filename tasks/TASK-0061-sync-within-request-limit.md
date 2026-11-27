# TASK-0061: Sync a long chain without tripping the request limit

Status: pending
Priority: P1
Size: small
Depends on: none
Source: F-043 (reassessment 3, 2026-11-27)

## Why

While a node syncs, each block its peer relays has an unknown parent, and the node sends another `GET_BLOCKS` (`P2PServer.ts:925-927`). The request chains never merge, because each batch with `more` asks again (`:886-888`). The peer scores +10 for each request beyond 4 queued (`:775-777`). About 14 relayed blocks into a sync, the syncing node is banned for 24 hours. Each extra chain also downloads the same batches again. In a time-compressed reproduction, a node was banned 2 seconds into a 6,000-block sync and stalled at height 3,000. At real block times the trigger is a sync lasting about 14 block intervals (inferred), which is a long chain or a slow machine.

## Scope

- At most one block request in flight per peer. While one is outstanding, a relayed block with an unknown parent doesn't start another; it is answered by the running sync.
- Decide whether to sync from several peers at the handshake, or from one at a time with the others as fallback.
- The server-side limit stays. The client keeps under it.

## Acceptance criteria

- [ ] A node syncing a long chain while new blocks arrive keeps at most one request in flight per peer and isn't scored.
- [ ] It downloads each batch once.
- [ ] A test with a new block arriving every few batches during a sync of several thousand blocks.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`, `npm run scale` (sync time into a new node).
