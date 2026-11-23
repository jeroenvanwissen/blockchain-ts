# TASK-0020: Peer limits and reconnect policy

Status: done
Priority: P2
Size: small
Depends on: TASK-0013
Source: old E4

## Why

A node accepted any number of inbound connections and dialed every address it learned through peer discovery. Reconnects used a separate code path that ignored both. A peer sending garbage or invalid blocks was never penalized: it could keep the node busy validating junk forever.

## Scope

- Caps on inbound and outbound connections; peer discovery and reconnects respect them.
- Capped exponential backoff for reconnects.
- A misbehavior score that disconnects and temporarily bans a peer.
- Out of scope: persisting bans across restarts, subnet-level bans.

## Acceptance criteria

- [x] At most `MAX_INBOUND_PEERS` inbound connections are accepted and at most `MAX_OUTBOUND_PEERS` dialed; the rest of the known peers stay known.
- [x] Reconnect delays double up to `RECONNECT_MAX_DELAY` and stop after `MAX_RECONNECT_ATTEMPTS`.
- [x] Malformed messages and invalid blocks add misbehavior points; at `BAN_SCORE` the peer is disconnected and refused for `BAN_DURATION`. Rejections an honest peer can cause add nothing.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**Limits (`P2PServer`, constants in `config.ts`)**
- `MAX_INBOUND_PEERS` = 32. Extra inbound connections are closed with code 1013.
- `MAX_OUTBOUND_PEERS` = 8, counting dials in progress.
- All outbound connections go through one `_dial` path. `connectToPeers` (CLI peers, `peers.json`, discovery), reconnects and a new periodic `_fillOutbound` (every peer-broadcast interval, 60 s) all check `_canDial`: not closing, not connected, not ourselves, not banned, under the cap.

**Reconnects**
- Delay `RECONNECT_BASE_DELAY × 2^(attempt−1)`, capped at `RECONNECT_MAX_DELAY` (60 s), for `MAX_RECONNECT_ATTEMPTS` (10) attempts. After that the outbound fill may pick the peer up again.
- Timers are unref'd. `close()` now also terminates dials still in progress, which used to fail and log after shutdown.

**Misbehavior**
- Points per peer, scored like Bitcoin Core: non-JSON or non-object message +20, malformed `BLOCKS` +20, malformed transaction +20, malformed `GET_BLOCKS` or `PEERS` +10, malformed block +50, invalid block +50.
- No points for rejections an honest peer can cause: a block we already know, an unknown parent, a timestamp ahead of our clock, or transaction policy (fee, conflict, missing inputs while behind). Those log at info level.
- At `BAN_SCORE` (100) the peer is disconnected and its ban key is refused for `BAN_DURATION` (24 h, in memory):
  - outbound peers by dialed URL, which is also dropped from known peers
  - inbound peers by IP, checked when the connection is accepted
  - on loopback by IP plus listen port, checked at VERSION, so local multi-node setups don't ban each other wholesale

**Tests**
- `integration/PeerPolicy.test.ts` (real WebSockets) covers:
  - an invalid block (+50) then a malformed block (+50) gets a peer banned and refused at its next handshake, while another local peer still connects
  - a future-dated block and an already-known block add nothing (only a malformed transaction counts)
  - the 33rd inbound connection is refused with 1013
  - dialing 11 unreachable peers starts only 8 dials and keeps all 11 known
  - reconnect delays follow the capped doubling schedule and stop after 10 attempts
- `P2PServer.test.ts`: unparseable messages now score misbehavior; PEERS routing passes the socket.
- Smoke flags any misbehavior or ban line; e2e fails if any honest node penalized a peer.

**Runs**
- `npm run check`: 23 suites, 275 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 97 s (height 26, 6 PoS blocks). No node logged misbehavior or a ban.
