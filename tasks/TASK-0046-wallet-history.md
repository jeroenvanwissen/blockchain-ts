# TASK-0046: Wallet transaction history

Status: done
Priority: P2
Size: small
Depends on: TASK-0045
Source: owner request (2026-11-24), suggested after TASK-0045

## Why

The address history (TASK-0045) shows one address at a time. A wallet has many addresses (TASK-0041), and change goes to the primary address, so a payment touches several of them. The wallet owner needs one history: what came in, what went out, and the balance after each transaction.

## Scope

- A wallet route that merges the histories of all the wallet's addresses into one entry per transaction, with the net change to the wallet and its balance afterwards.
- Each entry says what kind of transaction it was (received, sent, sent to itself, mined, staked) and, for payments, the recipients and the fee.
- A `cli history` command on top of it, with paging.

## Acceptance criteria

- [x] `GET /wallet/transactions` (behind the API token, loopback only) pages the wallet's history newest first with stable positions, and lists pending transactions separately.
- [x] A transaction that touches several wallet addresses (a payment with change, a payment between own addresses) is one entry with the net change; the last entry's balance equals the wallet balance.
- [x] Entries are typed `receive`, `send`, `self`, `mined`, `reward` or `stake`; payments show their recipients and the fee; coinbase and coinstake entries show whether they are still immature.
- [x] `npm run cli -- history [--limit <n>] [--before <position>]` prints the history and how to page further.

## Validation

`npm run check`, `npm run smoke` (CLI history after a restart, wallet locked), `npm run e2e` (C's history shows the payment it received and its stakes).

## Outcome

**Merged history (`AddressIndex.historyOf`, `Blockchain.getWalletHistory`)**
- Each address history entry now also records the transaction's position in its block (`indexInBlock`).
- `historyOf(addresses)` sums each transaction's entries over the given addresses into one entry, sorts them by height and position in the block, and recomputes the running balance. The result is derived on request from the address index, so nothing new is stored and the chainstate format is unchanged.
- `getPendingActivity` takes a list of addresses and sums each mempool transaction over them (the address route passes one).

**API: `GET /wallet/transactions?before=&limit=`** (behind the token, loopback only)
- Pages like the address history; the paging code is now shared (`historyPage`).
- Each entry has a type:
  - coinbase: `mined` in a PoW block, `reward` in a PoS block
  - coinstake: `stake`
  - otherwise `receive` when the wallet spent nothing, `self` when every output is the wallet's, else `send`
- Other fields:
  - `amount`: the net change to the wallet's balance, fee included
  - `fee`: for sends and self-payments whose inputs are all the wallet's
  - `addresses`: a payment's recipients, otherwise the wallet's own addresses it paid
  - `balance`: the wallet's balance after the transaction
  - `immature`: set on coinbase and coinstake entries with fewer than `COIN_MATURITY` confirmations
- `pending` lists mempool transactions with the same fields.
- A newly watched address (the lookahead grows as addresses are handed out) that already has transactions shifts the positions. That is rare, and the docs say so.

**CLI: `history [--limit <n>] [--before <position>]`**
- One line per transaction: height, local time, type, signed amount, balance after, full txid, then the recipients, fee and `immature`. Pending transactions come first, on the first page only.
- It ends with the command for the next page.
- It needs no passphrase.

**Tests**
- `AddressHistory.test.ts`: one hand-mined block with an outsider's payment to the wallet's second address first, then a payment out (with change) and a payment from the primary address to the second. The order crosses the order in which the addresses list them. Checks one entry per transaction in block order, the exact net change of each (minus the fee for the self-payment), the last balance equal to the wallet's total, duplicate addresses counting once, and a pending self-payment as one entry over both addresses.
- `Api.test.ts`: the route over HTTP (401 without the token; types, amounts, fees, recipients, immature flags, pending, paging, 400 on malformed paging), and on a PoS chain the `reward` and `stake` entries.
- Smoke: after the SIGTERM restart (wallet locked), `cli history` ends at the balance `cli balance` reports.
- e2e: C's `cli history` shows the payment it received at its non-primary address, with the txid and that address. If the converged chain has blocks C staked, the history must show them too. A first version required them every time and failed once: C's blocks can lose their slot or be reorganized away, and e2e checks right after convergence, before C stakes again.

**Found:** pending payments don't survive a restart (the mempool isn't saved and the wallet doesn't rebroadcast). Recorded as TASK-0047.

## Runs

- `npm run check`: 33 suites, 341 tests, lint clean.
- Mutation checks:
  - summing per address instead of per transaction fails 2 tests
  - dropping the in-block tie-break fails the wallet-history test
  - typing every self-payment as `send` fails the API test
- `npm run smoke`: PASS, including `cli history` after the SIGTERM restart (wallet locked) ending at the `cli balance` balance.
- `npm run e2e`: PASS four times with the final check (height 25 or 26). The last run showed 2 blocks staked by C on the final chain, so the stake rows were checked.
- Manual run on a regtest node with `--mine --stake`:
  - a send to an outsider and to the wallet's own new address show as `send` and `self` (pending, then confirmed), with recipients and fees
  - the stake reward includes the wallet's own fees (+10.0000619)
  - the newest balance (227.5) equals `cli balance`
  - paging with `--before` works; a malformed flag prints the usage and exits with 2
