# TASK-0064: Eclipse resistance: inbound limits per IP, nonce impersonation, address groups

Status: pending
Priority: P2
Size: medium
Depends on: TASK-0059
Source: F-044 (reassessment 3, 2026-11-27)

## Why

TASK-0039 stopped address floods and made outbound choices random. Three ways to surround a node remain:
- **Inbound slots:** one host can hold all 32. There is no per-IP cap and no eviction, the count includes connections that never finish the handshake, and there is no idle timeout (`P2PServer.ts:215-219`, `:281-284`).
- **Nonce impersonation:** the VERSION nonce isn't authenticated, and each node sends it to anyone who connects. A peer that presents honest node H's nonce to victim X makes X close its real outbound connection to H as a duplicate and not redial H while the impostor stays connected (`_dropDuplicate`, `:319-334`; `_canDial`, `:299-305`). Reproduced.
- **Address book:** entries are keyed by URL with no per-IP or network-group limit, and verified entries are never evicted (`AddressBook.ts:52-61`, `:98-107`). Inbound VERSION adds `IP:<claimed port>` (`P2PServer.ts:740-747`), and `PEERS` messages have no rate limit. One IP with many listening ports can fill the book with verified entries that keep honest addresses out, notably after a restart from `peers.json`.

## Scope

- Inbound: cap connections per IP, keep handshake-pending connections from holding slots for long, and when full, evict an inbound peer by a rule an attacker can't easily meet (keep long-lived and useful peers, as Bitcoin Core does).
- Duplicates: drop a duplicate only when the existing connection is outbound and the new one comes from the same IP as the address dialed, or prove the nonce (for example by echoing a challenge in VERACK). Never let an inbound connection displace an outbound one.
- Address book: limit entries per IP and per network group (/16 for IPv4, /32 for IPv6). Choose outbound peers across groups.
- Rate-limit `PEERS` per peer.

## Acceptance criteria

- [ ] One IP can't hold more than the per-IP cap of inbound slots; a full node still accepts a new honest peer by evicting.
- [ ] An impostor with another node's nonce doesn't close the victim's outbound connection to that node.
- [ ] One IP can't fill more than its share of the address book; outbound peers come from different groups where the book allows.
- [ ] `network:check` passes (separate containers, own IPs).

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`, `npm run network:check`.

## Notes

Docker setups that put all inbound peers behind one gateway IP would hit a per-IP cap. Make the cap a setting, or document the setup.
