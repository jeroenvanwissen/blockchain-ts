# TASK-0017: Wallet send and balance from chain state

Status: done
Priority: P2
Size: medium
Depends on: TASK-0005, TASK-0016
Source: old D4

## Why

A node operator can't send coins: nothing in the node builds a payment from its wallet. The e2e scenario works around this by reading A's wallet file in the test process and signing there. `Wallet` also keeps its own transaction history and UTXO list (`addTransaction`, `getBalance`, `getSpendableOutputs`), which nothing calls and which would drift from the chain if anything did.

## Scope

- The wallet holds keys only; balances and spendable outputs come from the chain's UTXO set. Old wallet files with history fields must still load.
- Payments with one or more recipients: spendable outputs selected until the amount is covered, change back to the wallet, signed, admitted to the mempool and relayed.
- Authenticated wallet endpoints on the API: `GET /wallet` and `POST /wallet/send`. The node writes a random token to `<data dir>/api.cookie` (0600) at startup, and wallet routes require it as a bearer token. Browsers can't add that header cross-origin, so a web page can't trigger a send.
- A CLI (`npm run cli`) for `status`, `balance` and `send`, reading the cookie from the data dir.
- The e2e scenario pays through the node's wallet (CLI) instead of signing in the test process.
- Out of scope: fees (TASK-0018; payments carry no fee yet), wallet encryption (TASK-0024), transaction history.

## Acceptance criteria

- [x] `Wallet` has no transaction or UTXO bookkeeping, and a wallet file written with those fields still loads.
- [x] `POST /wallet/send` builds, signs, admits and relays a payment with one or more outputs, returning its txid; bad input gets 400, insufficient funds 422.
- [x] Wallet routes reject missing or wrong tokens with 401; the cookie file is 0600 and its token is never logged.
- [x] `npm run cli -- send` and `balance` work against a running node; the e2e payment goes through them.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**Wallet**
- `Wallet` now holds only the key pair. Removed: `addTransaction`, `getBalance`, `getSpendableOutputs`, `getTransactionHistory` and the stored history and UTXO lists, none of which had callers.
- The protobuf schema reserves fields 4 and 5, so older wallet files still load. An integration test writes one with the old schema and real protobuf.

**Payments**
- `Blockchain.createPayment(wallet, outputs)` takes 1 to 255 recipients (one output is left for change, under the 256-output consensus cap).
- Coin selection takes spendable outputs (mature, not claimed by the mempool) largest first, stopping at the 256-input cap with a clear error. Change goes back to the wallet.
- `createTransaction` is now a single-recipient wrapper around it.

**API (`ApiServer`)**
- Routes declare a method and whether they act for the wallet. A wrong method gets 405 with `Allow`.
- `GET /wallet` returns the node wallet's balance summary. `POST /wallet/send` with `{ outputs: [{ address, amount }] }` validates the body (400), serializes payments with a mutex so two sends can't select the same outputs, builds, admits and relays, and returns `{ txid }`. Chain-side rejections such as insufficient funds get 422. Bodies must be JSON (415) and at most 64 KB (413).
- Wallet routes need `Authorization: Bearer <token>`, compared in constant time. The node writes a fresh 32-byte token to `<data dir>/api.cookie` (0600) at every start (`src/api/cookie.ts`) and never logs it. Missing or wrong tokens get 401. Without wallet access the routes are 404.

**CLI (`src/cli.ts`, `npm run cli`)**
- Commands: `status`, `balance`, and `send <address> <coins> [<address> <coins> ...]`, which prints the txid.
- Options: `--data-dir` (for the cookie) and `--api`. Amounts are parsed and printed in coins by `src/blockchain/amount.ts` (`parseCoins`, `formatCoins`; up to 8 decimals).

**Scripts**
- Smoke runs `cli status` and `cli balance` against node A, checks that `api.cookie` is 0600, and checks that the token never appears in node or CLI output.
- e2e pays C's 12 outputs with `cli send` from A's wallet once A's API reports enough spendable coins, and reads C's final balance with `cli balance`. The test process no longer opens A's wallet file.

**Runs**
- `npm run check`: 19 suites, 257 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 118 s (height 26, 6 PoS blocks, reorg after the partition).

**Notes**
- A send that selects an output a concurrent stake block also spends can be admitted and then dropped when that block connects. TASK-0019's revalidation should make that visible.
- Payments carry no fee until TASK-0018.
