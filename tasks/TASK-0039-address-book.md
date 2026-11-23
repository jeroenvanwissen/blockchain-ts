# TASK-0039: Peer address book

Status: done
Priority: P2
Size: medium
Depends on: TASK-0020
Source: F-034 (reassessment 2, 2026-11-23)

## Why

Known peer addresses were a set of up to 128, kept in arrival order:
- Any peer's `PEERS` message could add addresses, and the node dialed them immediately.
- Addresses that never answered were never dropped.
- Outbound slots were refilled in arrival order.

Whoever flooded addresses first could fill the list for good and decide whom the node connected to, the setup for an eclipse attack. The node also passed every address it had heard of on to its peers.

## Scope

- Track per address whether it ever worked and how often it failed in a row; drop learned addresses that keep failing.
- Keep a flood from displacing addresses that work.
- Choose outbound peers at random, verified first; never dial what a peer names.
- Pass on only addresses that are configured or verified; bound the addresses taken from, and sent in, one message.

## Acceptance criteria

- [x] A `PEERS` message adds at most `MAX_ADDRESSES_PER_MESSAGE` addresses and doesn't dial them.
- [x] A full address book only replaces an address that has failed and never worked.
- [x] Learned addresses are dropped after `MAX_ADDRESS_FAILURES` failures in a row; configured ones never.
- [x] Outbound candidates come verified first, then the rest, in random order, with failing ones waiting out a backoff.
- [x] Discovery still works across real nodes (e2e).

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**`src/networking/AddressBook.ts`**
- Each entry has a source (`configured`: CLI `--peers` and `SEED_NODES`; `learned`: `PEERS` messages, inbound listen ports, `peers.json`), consecutive failures, last attempt and last success.
- `addLearned`: when the book is full (`MAX_KNOWN_PEERS`, 128), only an address that has failed and never worked is replaced.
- `markFailure` drops learned addresses after `MAX_ADDRESS_FAILURES` (5) failures in a row; `markSuccess` resets the count.
- `candidates(now)`: verified addresses first, then the rest, each group shuffled. Failing ones wait `ADDRESS_RETRY_BASE` (30 s) × 2^(failures−1), capped at `ADDRESS_RETRY_MAX` (1 h).
- `shareable(max)` returns only configured or verified addresses. `all()` lists verified and configured first (for `peers.json`).

**`P2PServer`**
- A failed dial counts a failure; a completed outbound handshake marks the address verified.
- A peer on another network or with another genesis block is removed. A protocol-version mismatch counts as a failure (the peer may upgrade). Self-connections and bans remove the address.
- `PEERS`: the first `MAX_ADDRESSES_PER_MESSAGE` (32) entries are considered. New addresses trigger `fillOutbound()`, which dials from the book at random, never the addresses the sender named.
- `PEERS` sent and broadcast hold at most 32 shareable addresses.
- `_canDial` refuses addresses that are no longer in the book, so reconnects stop once one is dropped.
- `fillOutbound()` is now public; the node calls it at startup after dialing its configured peers.
- `loadInitialPeers(configured, learned)`: the node passes seeds and `--peers` as configured and `peers.json` as learned.
- Connecting a socket no longer adds its address by itself.

**Tests**
- `AddressBook.test.ts` (unit, seeded random) covers:
  - replacement only of failed, never-working addresses
  - dropping after 5 failures, reset by a success, configured addresses kept
  - verified-first random candidates and retry waits
  - shareable addresses limited to configured or verified, and capped
  - the saving order
- `P2PServer.test.ts`: updated for the new rules, plus: a `PEERS` message triggers the random fill instead of dialing the named addresses; nothing new means no refill; learned addresses aren't shared until verified.
- `PeerPolicy.test.ts`: a peer sending 200 addresses teaches the node exactly 32. The reconnect test registers its address first.

**Runs**
- `npm run check`: 29 suites, 312 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 86 s (height 25, 5 PoS blocks). B and C find each other through A's `PEERS` messages, and the partitioned C reconnects.
