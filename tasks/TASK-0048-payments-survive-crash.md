# TASK-0048: Pending payments survive a crash

Status: done
Priority: P2
Size: small
Depends on: TASK-0047
Source: owner request (2026-11-24), the limit noted in TASK-0047

## Why

TASK-0047 saves the mempool at shutdown. A node that crashes, runs out of memory or is killed with SIGKILL never reaches that point. A payment it sent and no peer has yet is gone, and nothing tells the user. The coins stay in the wallet, but the user believes the payment was made.

## Scope

- Save the mempool right after the wallet sends a payment, as well as at shutdown.
- Keep the shutdown log line; the save after a send logs nothing at info level.

## Acceptance criteria

- [x] A payment sent with `cli send` is still pending after the node is killed with SIGKILL and restarted.
- [x] e2e covers the crash, and still covers a clean stop with the payment pending.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

- `POST /wallet/send` saves the mempool (`Blockchain.saveMempool`) right after the payment is admitted and before it is relayed. A crash at any point after the API answers leaves the payment in `blocks/mempool.json`. The file is replaced atomically, so a crash during the write leaves the previous version.
- `saveMempool` returns the number saved (null after a logged failure) and no longer logs on success. The node's shutdown logs `saved N pending transaction(s)` as before.
- Transactions the node only relays for others are still saved at shutdown only. After a crash, the peers that have them pass them on again through the `MEMPOOL` exchange (TASK-0047).
- The write isn't fsynced: a power cut right after a send can still lose it. A process crash or SIGKILL can't.
- Tests:
  - `Api.test.ts`: a chain reopened from the same data dir right after `POST /wallet/send` has the payment pending. Without the save, that test fails.
  - e2e step 7:
    1. C pays A and is killed with SIGKILL; after the restart it logs `Mempool loaded: 1 pending transaction(s)` and its `cli history` shows the pending send.
    2. It then stops with SIGTERM (`saved 1 pending transaction(s)`) and loads the payment again when it rejoins.
    3. A stakes the payment into a block.
  - `nodeHarness.stopNode` accepts SIGKILL.

## Runs

- `npm run check`: 34 suites, 347 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS twice (heights 26 and 27).
