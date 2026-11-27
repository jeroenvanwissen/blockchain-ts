# TASK-0069: Wallet and API fixes: unlock timeouts, proxied requests, peer IPs, CLI input and remote API

Status: pending
Priority: P2
Size: small
Depends on: none
Source: F-046, F-055 (reassessment 3, 2026-11-27)

## Why

- **Unlock timeout (F-046).** `unlock` passes the timeout to `setTimeout` unclamped (`Wallet.ts:512-515`), and Node runs delays above 2^31−1 ms (about 24.8 days) after 1 ms. The API (`ApiServer.ts:403-407`) and CLI (`cli.ts:334`) accept any whole number. `cli unlock --staking-only --timeout 2592000` reports a wallet unlocked for 30 days, and it locks a millisecond later, so staking stops. Above about 8.6e12 s the reply fails with a 500 after the unlock went through. Reproduced on a running node.
- **Reverse proxy (F-055).** Behind a reverse proxy on the same host, every client looks local to the wallet loopback check (`ApiServer.ts:182`). README says the wallet routes never answer another machine. The token still applies.
- **Peer IPs (F-055).** `/peers` is public and lists inbound peers' IP addresses (`P2PServer.ts:1063-1075`); the explorer shows them.
- **Seed-phrase paste (F-055).** The hidden prompt returns at the first newline in a pasted chunk (`cli.ts:176-181`). Pasting the numbered lines `seed-phrase` prints keeps only the first line, though README says that format works. The checksum prevents a wrong restore.
- **Remote API (F-055).** The CLI sends the token, and passphrases, to any `--api` URL over plain HTTP (`cli.ts:212-235`). The server refuses non-loopback wallet requests, but only after they have crossed the network.
- **Status codes (F-055).** A new address past `MAX_WALLET_ADDRESSES` returns 500 with an ERROR log line (`Wallet.ts:442` throws a plain `Error`). A wallet locked while a payment waits for the send lock returns 422 instead of 423 (`ApiServer.ts:460-469`).

## Scope

- Accept unlock timeouts up to a stated maximum. Re-arm the relock timer in steps for longer ones, or reject longer ones with 400.
- Refuse wallet routes when a request carries `Forwarded`, `X-Forwarded-For` or `Via`, and make README say exactly what the check covers.
- Drop inbound peers' addresses from public `/peers` (keep direction and height), or move peer details behind the token.
- The prompt keeps reading after a newline inside a pasted chunk.
- The CLI refuses wallet commands to a non-loopback `--api`.
- `newAddress` at the limit throws a `WalletError` (409 or 422); the lock check repeated after the send lock is acquired.

## Acceptance criteria

- [ ] An unlock for 30 days stays unlocked (fake timers); an out-of-range timeout gets 400, never 500.
- [ ] A wallet request with a forwarding header gets 403.
- [ ] Public `/peers` holds no inbound IP addresses.
- [ ] A pasted numbered seed phrase restores (CLI test with a TTY-like stdin, or the logic factored out and tested).
- [ ] `cli --api http://<non-loopback> balance` refuses without sending the token.
- [ ] The two status codes are fixed, with tests.

## Validation

`npm run check`, `npm run smoke`, `npm run docker:check` (wallet routes from the host stay refused).
