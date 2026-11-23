# TASK-0030: Throttle block requests; persist bans

Status: done
Priority: P3
Size: small
Depends on: TASK-0020
Source: F-026, F-027 (reassessment 2026-11-23)

## Why

Each `GET_BLOCKS` made the node collect up to 200 blocks and serialize every one twice: once to measure it, once to send it. A peer could repeat the request without limit and without misbehavior points. Bans lived only in memory, so a restart let every banned peer straight back in.

## Scope

- Serve each peer's block requests one at a time with a minimum interval; a peer queuing more than a few is flooding.
- Serialize each block once and reuse it.
- Store bans in the data dir with their expiry.

## Acceptance criteria

- [x] A burst of block requests gets at most `MAX_PENDING_GET_BLOCKS` replies, and the excess scores misbehavior; honest sync is unaffected.
- [x] A ban survives a restart; expired bans are dropped on load.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**Throttling (`P2PServer`)**
- `_handleGetBlocks` queues each valid request. Replies to one peer go out `GET_BLOCKS_INTERVAL` (100 ms) apart.
- With `MAX_PENDING_GET_BLOCKS` (4) already waiting, a request is dropped and scores +10 ("too many block requests"). Honest peers have one request out at a time (they wait for each batch), occasionally a few when relayed blocks with unknown parents trigger extra requests.
- At 100 ms per batch of up to 200 blocks, sync from one peer can still reach 2,000 blocks per second.

**Serialization**
- `_sendBlocks` builds the `BLOCKS` message from per-block JSON strings, cached by hash (`BLOCK_JSON_CACHE_SIZE`, 2,000, oldest dropped first). Each block is serialized once instead of twice per request, and not at all on repeat requests.
- The message bytes are identical to before.

**Ban list**
- `banListPath` (the node passes `BAN_LIST_PATH` = `<data dir>/banned.json`) is loaded at construction, keeping unexpired entries, and rewritten on every ban.
- An unreadable file is ignored with a warning. Tests and tools that don't pass a path keep bans in memory.

**Tests**
- `PeerPolicy.test.ts`:
  - 10 requests in a burst get 4 replies and add 60 points
  - a ban is visible to a new node reading the same ban list
  - expired bans aren't loaded
- `P2PServer.test.ts` awaits the queued reply. `Sync.test.ts` (500 blocks in batches) passes unchanged.

**Runs**
- `npm run check`: 27 suites, 297 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 94 s (height 26, 6 PoS blocks). No honest node scored "too many block requests" (e2e fails on any misbehavior line).
