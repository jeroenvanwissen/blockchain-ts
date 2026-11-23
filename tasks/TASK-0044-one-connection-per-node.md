# TASK-0044: One connection per peer node

Status: pending
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

- [ ] Two nodes that dial each other, or one under two addresses, end up with one connection.
- [ ] The surviving connection is the same at both ends, whatever order the handshakes complete in.
- [ ] `fillOutbound` doesn't keep redialing an alias of a connected node.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`, and `compose.regtest.yaml` by hand.
