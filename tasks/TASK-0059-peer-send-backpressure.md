# TASK-0059: Backpressure on peer sends; block replies read only what they send

Status: pending
Priority: P1
Size: small
Depends on: none
Source: F-038 (reassessment 3, 2026-11-27)

## Why

Replies go out through `socket.send` without looking at `bufferedAmount` (`P2PServer.ts:497-499`, `:804`). The `GET_BLOCKS` throttle (4 queued per peer, 100 ms apart) allows a reply of up to 8 MB every 100 ms to a socket that never drains. There is no ping or idle timeout. One host with 32 inbound connections that never read made the node buffer 322 MB in 12 seconds (reproduced). Each reply also reads and re-hashes 201 blocks (`getBlocksAfter(locator, 201)`), even when the 8 MB cap sends only a few.

## Scope

- Don't serve a peer's next `GET_BLOCKS` while its earlier replies are still buffered. Disconnect a peer whose buffer stays above a limit for too long.
- Read blocks for a reply only until the size cap is reached.
- Ping peers, and disconnect one that doesn't answer within a timeout. This also clears dead connections that hold slots (see TASK-0064).

## Acceptance criteria

- [ ] A peer that never reads holds at most a bounded number of bytes in the node's send buffers, then is disconnected.
- [ ] A reply reads no more blocks than it sends, plus one.
- [ ] A connection that stops answering pings is closed.
- [ ] Sync and relay between honest nodes are unchanged (e2e, network:check).

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`, `npm run network:check`.
