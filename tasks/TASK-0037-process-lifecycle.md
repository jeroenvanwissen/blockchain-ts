# TASK-0037: Graceful shutdown on SIGTERM; fail fast when the P2P port is taken

Status: done
Priority: P2
Size: small
Depends on: none
Source: F-031, F-032 (reassessment 2, 2026-11-23)

## Why

- The node handled only SIGINT. SIGTERM, which systemd, Docker and a plain `kill` send, ended it without saving the chainstate, stopping the mining worker, or closing peers and the API.
- `P2PServer.listen()` only resolved on success and merely logged errors. A node whose P2P port was taken kept running, dialing out but never accepting peers.

## Scope

- One shutdown path for SIGINT, SIGTERM and fatal startup errors.
- `listen()` reports a bind failure, and the node exits with an error instead of running half-alive.

## Acceptance criteria

- [x] SIGTERM stops the node cleanly and saves the chainstate (the restart validates 0 newer blocks).
- [x] A node whose P2P port is taken logs why and exits with code 1.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

- `P2PServer.listen()` rejects on an error before `listening` (EADDRINUSE, EACCES). After that, errors are logged as before.
- `src/index.ts` `shutdown(code)`:
  - stops staking, waits for the miner, saves the chainstate, closes the P2P server and the API, then exits
  - is registered for SIGINT and SIGTERM, and called with code 1 when the P2P server can't listen
  - a second signal during shutdown exits at once
- `nodeHarness.stopNode(node, signal)` can send SIGTERM.
- README (Step 1, Port Already in Use) and AGENTS.md describe the behavior.

**Tests**
- `PeerPolicy.test.ts`: a second `P2PServer` on a taken port rejects `listen()` with EADDRINUSE; the first is unaffected.
- Smoke:
  - a node started on node A's P2P port exits with code 1 and logs `P2P server could not listen on port ...`
  - node A is now stopped with SIGTERM, and its restart starts from the chainstate it saved (`validated 0 newer block(s)`)

**Runs**
- `npm run check`: 28 suites, 305 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 88 s (height 26, 6 PoS blocks).
