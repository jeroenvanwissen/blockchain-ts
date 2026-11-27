# TASK-0065: Cost bounds on the public API

Status: pending
Priority: P2
Size: medium
Depends on: none
Source: F-045 (reassessment 3, 2026-11-27)

## Why

The public chain routes run synchronously on the node's event loop, and P2P and staking wait while they do:
- `/transactions/:txid` reads, parses and re-hashes the whole block of every input (`ApiServer.ts:549-586`, through `findTransaction`), with no cache. At 27 ms per 735 KB block, a 256-input transaction takes about 6.9 s (measured).
- `/blocks?limit=100` reads 100 full blocks to show summaries (`:499-521`).
- `/addresses/:address` and `/addresses/:address/transactions` load the address's entire history on every request (`:588-631`; `ChainDb.ts:451-464`, no `LIMIT`): 400 ms at 200,000 entries, against 12 ms for the same page, count and sums in SQL (measured). `/wallet/transactions` does the same over all wallet addresses.
- `/addresses/:address/utxos` and `/mempool` return everything.

The Docker image binds the API to `0.0.0.0` so it can be published, and README invites exposing the explorer.

## Scope

- Block summaries and transaction lookups from the chain database where it has the data: the block index has height, time, type, producer, transaction count and size. Look up spent outputs through the txid index and the undo data, not by reading whole blocks; at least cache blocks within a request.
- History pages, counts and sums in SQL.
- Page `/addresses/:address/utxos` and `/mempool`.
- A limit on concurrent API requests, or on the work per request.

## Acceptance criteria

- [ ] No public route reads more than a bounded number of blocks per request.
- [ ] Address routes cost the same for an address with 200,000 entries as for one with 10 (measured).
- [ ] The explorer still works (its pages and links).

## Validation

`npm run check`, `npm run smoke`, `npm run docker:check`.
