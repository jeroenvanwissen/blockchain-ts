# TASK-0027: Keep wallet routes on loopback

Status: done
Priority: P2
Size: small
Depends on: TASK-0017
Source: F-023 (reassessment 2026-11-23)

## Why

Setting `API_HOST` to a non-loopback address, for example to let a dashboard read chain data, also exposed `POST /wallet/send`, `unlock` and `encrypt` to the network. Those routes were guarded only by the bearer token, and the API is plain HTTP: the token, and the passphrase on unlock, would cross the network readable to anyone on the path.

## Scope

- Wallet routes answer only loopback clients, whatever `API_HOST` is. Chain routes stay public.
- Document that exposing the API exposes only the chain routes.

## Acceptance criteria

- [x] A wallet request from another machine gets 403 even with a valid token; chain routes still answer it.
- [x] Loopback detection covers 127.0.0.0/8, `::1` and their IPv4-mapped forms, and nothing else.

## Validation

`npm run check`, `npm run smoke` (CLI wallet calls over loopback).

## Outcome

- `ApiServer._handle` checks `req.socket.remoteAddress` with `isLoopback` before the token on every `wallet` route. It refuses everything else with 403 "wallet routes only answer requests from this machine".
- `isLoopback` accepts `127.x.y.z`, `::1` and `::ffff:127.x.y.z`. It rejects other addresses, look-alike strings and a missing address.
- README (HTTP API) and AGENTS.md describe the rule.
- Tests (`Api.test.ts`):
  - a request that appears to come from 10.0.0.5 gets 403 on `/wallet` with the right token, and 200 on `/status`
  - table tests for `isLoopback`
- Runs: `npm run check` (26 suites, 293 tests, lint clean) and `npm run smoke` (CLI `balance`, `encrypt-wallet`, `unlock` and `lock` over loopback) pass. e2e isn't affected (no consensus, P2P or staking change).
