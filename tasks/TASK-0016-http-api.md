# TASK-0016: Local HTTP API for chain queries

Status: done
Priority: P2
Size: medium
Depends on: TASK-0006
Source: old D3

## Why

A running node can only be inspected through its log output. The smoke and e2e scripts parse logs or open a P2P handshake just to learn a node's tip, and TASK-0017 (wallet send) needs a way to talk to a node.

## Scope

- Read-only HTTP API on Node's built-in `http` module, bound to `127.0.0.1` unless `API_HOST` says otherwise. Port from `API_PORT`, defaulting to the P2P port + 1000.
- Endpoints (GET, JSON, amounts as decimal strings):
  - `/status`: network, height, tip, chain work, phase, mempool size, peer count
  - `/blocks/:heightOrHash`: a block, with whether it's on the active chain and its confirmations
  - `/transactions/:txid`: a confirmed or pending transaction, with its block and confirmations
  - `/addresses/:address` and `/addresses/:address/utxos`: balance, spendable balance and outputs
  - `/mempool`, `/peers`
- Clear 400 / 404 / 405 responses; untrusted path input is validated before use.
- Use the API in the smoke and e2e scripts instead of log parsing or raw handshakes for tips.
- Out of scope: anything that changes state (sending transactions is TASK-0017), authentication, a transaction index.

## Acceptance criteria

- [x] Each endpoint returns the documented data, tested against a real chain over real HTTP.
- [x] Malformed input gets 400, unknown items 404, other methods 405.
- [x] The API listens on loopback by default.
- [x] `npm run smoke` and `npm run e2e` use it.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**`src/api/ApiServer.ts`**
- Built on `http` with no new dependencies. Every node starts it (`index.ts`) on `API_HOST` (default `127.0.0.1`) and `API_PORT` (default P2P port + 1000, so a second node on 5002 gets 6002). `API_PORT=0` picks a free port and logs it.
- If the port is taken, `listen()` rejects; the node logs `[API] could not listen` and keeps running.
- Behavior:
  - GET only (405 with `Allow: GET` otherwise).
  - JSON responses; amounts as decimal strings.
  - Path parameters are checked against strict patterns (height, 64-hex hash, address ≤ 64 characters before Base58 decoding) and get 400 if malformed.
  - Unknown items get 404. Unexpected errors get 500 without details and are logged.

**Supporting changes**
- `Blockchain`:
  - `getBlockByHash` (active or side branch, from the block index)
  - `findTransaction` (mempool, then the active chain from the tip; no transaction index yet)
  - `getSpendableUTXOs` (mature and not claimed by the mempool). `createTransaction` now uses it instead of its own copy of those checks.
- `P2PServer.getPeerInfo`: for each handshaken peer, the address (the dialed URL, or the remote IP plus listen port for inbound), direction and height at handshake.
- `config.ts`: `API_HOST`, `API_PORT`, `API_PORT_OFFSET`.

**Scripts**
- The node harness starts nodes with `API_PORT=0` and reads the URL from the log (`apiUrl`, `apiGet`).
- Smoke checks that B's tip equals A's block at that height and that A's address has a balance, all over the API.
- e2e reads tips from `/status` instead of opening a raw P2P handshake, and checks C's balance through C's own API.

**Tests**
- `integration/Api.test.ts` covers status, blocks (by height and hash, side branch), transactions (pending, then confirmed), balances and outputs (immature coinbases not spendable), error codes, and a taken port.
- `Sync.test.ts` covers `getPeerInfo` over real WebSockets. `config.test.ts` covers the API defaults and env overrides.

**Runs**
- `npm run check`: 18 suites, 241 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 140 s (height 27, 7 PoS blocks, reorgs at the same-slot tie and after the partition).

**Notes**
- Responses carry no CORS headers, so a web page can't read them cross-origin.
- When TASK-0017 adds a state-changing endpoint, it needs protection against requests forged by a local browser (for example a required token or a JSON content type), not just the loopback binding.
