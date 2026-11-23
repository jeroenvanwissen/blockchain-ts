# TASK-0045: Address history index

Status: done
Priority: P2
Size: medium
Depends on: TASK-0042
Source: owner request (2026-11-23), suggested after TASK-0042

## Why

The node indexed only unspent outputs per address. The explorer and the API could show an address's balance but not the transactions that moved coins in and out of it.

## Scope

- An index of every active-chain transaction per address, with what it received and sent and the balance afterwards.
- It must stay correct through reorganizations and restarts, whether the node starts from a saved chainstate or replays the chain.
- API routes and the explorer's address page use it; pending transactions are shown separately.

## Acceptance criteria

- [x] `GET /addresses/:address/transactions` pages the history newest first with stable positions; `GET /addresses/:address` adds the transaction count and totals.
- [x] After any sequence of connects, reorganizations and restarts, the index equals one rebuilt from the active chain, and each address's last entry equals its balance in the UTXO set.
- [x] A transaction spending an output created earlier in the same block is resolved.
- [x] The explorer's address page shows the history (pending first, with the balance after each) and pages through it.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`, and the explorer in headless Chrome.

## Outcome

**Index (`AddressIndex.ts`)**
- For each address it keeps `{txid, height, received, sent, balance}` per transaction, oldest first.
- `connect(block, spent)` resolves inputs from the block's undo data, plus outputs created earlier in the same block: those are absent from the undo data because they never reached the UTXO set.
- `disconnect` removes the block's entries, which are the newest of each address it touched.
- Zero-value outputs (the coinstake marker) count as nothing, so a stake shows as sending and receiving the kernel output (net 0), and the reward is received in the coinbase.

**Chain state:** the index isn't saved, like the txid index. `Blockchain._indexTransactions` maintains both on connect (`_connectTip`) and disconnect (`_disconnectTip`), and startup rebuilds them from the active branch. Startup now sets `_undo` before indexing, because the address index reads it. The chainstate format is unchanged.

**Chain queries:** `getAddressHistory(address)`, and `getPendingActivity(address)` for mempool transactions that pay the address or spend its outputs (pending inputs are always confirmed outputs, so the UTXO set resolves them).

**API**
- `GET /addresses/:address/transactions?before=&limit=`:
  - newest first; `limit` 1 to 100, default 25
  - each entry has its position, txid, height, time, confirmations, received, sent and the balance after it
  - positions count from 0, oldest first, so page links don't shift as blocks arrive
  - plus `pending`
- `GET /addresses/:address` adds `transactions`, `totalReceived` and `totalSent`.

**Explorer:** the address page shows the totals and a transaction table: pending entries first, then the block, age, signed change (green in, red out, 0 for a stake) and the balance after each. It pages with "Older" and "Newer" (`#/address/<address>/<before>`). The unspent outputs table stays below it.

**Tests**
- `AddressHistory.test.ts`. Every test checks that the live index equals one rebuilt from the active chain and that each history ends at the address's balance.
  - received and sent amounts and running balances across payments; pending activity before confirmation
  - a block where one transaction spends an output of an earlier one
  - a reorganization that removes a payment, which returns to pending, then restarts from the chainstate and from a full replay that both reproduce the index
  - a staked block: the reward is received, the kernel is sent and received
- A mutation check: with `disconnect` turned off, the reorganization test fails.
- `Api.test.ts`: paging, positions, pending, totals and parameter errors.
- Smoke: after the SIGTERM restart, A's history ends at its balance.
- `Chainstate.test.ts` now builds competing branches with `powBlockOn` and `extendBranch`, moved into the shared integration helpers.
- Headless Chrome against a regtest node that mined, staked and paid a new address twice:
  - pending entries before the block
  - the running balance across coinbases (one including fees), stakes and both payments
  - the second page of 28 entries

**Runs**
- `npm run check`: 33 suites, 338 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS (height 25, 5 PoS blocks).
