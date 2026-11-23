# TASK-0044: One connection per peer node

Status: done
Priority: P2
Size: small
Depends on: TASK-0039
Source: found while testing TASK-0043 (2026-11-23)

## Why

Peers are told apart by address string. A node reachable under two addresses, such as a Docker service name (`ws://a:5001`) and its container IP, gets a connection under each. Two nodes that dial each other also keep both connections. In `compose.regtest.yaml` the two nodes held three connections between them. Each extra connection takes an outbound slot (8 in all) and carries every block and transaction relay again.

## Scope

- Recognize a duplicate by the node nonce in VERSION, which already detects connections to ourselves.
- Both ends must agree on which connection survives, so a pair never drops both.
- Don't redial an address known to reach a node that is already connected.
- No misbehavior score: duplicates are normal.

## Acceptance criteria

- [x] Two nodes that dial each other, or one under two addresses, end up with one connection.
- [x] The surviving connection is the same at both ends, whatever order the handshakes complete in.
- [x] `fillOutbound` doesn't keep redialing an alias of a connected node.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`, and `compose.regtest.yaml` by hand.

## Outcome

**Rule (`P2PServer._dropDuplicate`, run when a handshake completes):** if another connection that finished its handshake has the same `VERSION` nonce, only a dialing side closes one:
- A node that dialed another twice, for example under a hostname and an IP, closes its newer dial. The receiving end sees two inbound connections and leaves them alone.
- When two nodes dialed each other, the one with the higher nonce closes its own dial, in whichever order the handshakes complete. The lower-nonce node never closes anything in this case. Both ends therefore keep the same connection, and never both close theirs.

**Closed connections**
- A closed duplicate is flagged `isDuplicate`: it no longer counts as ready, and its close doesn't schedule a reconnect.
- Its address is kept as an alias of the node's nonce, and `_canDial` refuses it while that node is connected. The alias expires on its own when the node disconnects or restarts with a new nonce.
- Duplicates score no misbehavior. The address still counts as verified, since its handshake succeeded.

**Tests**
- `DuplicatePeers.test.ts` (real in-process nodes):
  - a node dialed as `127.0.0.1` and as `localhost` keeps one connection, and `fillOutbound` doesn't redial the alias
  - four rounds of nodes dialing each other, with fresh nonces, each end with the lower-nonce node's outbound connection as the only one at both ends
- Both tests fail when the rule is switched off: two connections remain.
- `P2PServer.test.ts`: the mock peers now each send their own nonce (they all used one before, so they looked like one node connected several times).

**Runs**
- `npm run check`: 32 suites, 333 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS (height 26, 6 PoS blocks). The rule closed 2 duplicates where nodes dialed each other, and no node penalized a peer.
- `compose.regtest.yaml` by hand: three connections before the fix, one after. a ends with an outbound connection to b and b with the matching inbound one, with no WARN or ERROR lines.
