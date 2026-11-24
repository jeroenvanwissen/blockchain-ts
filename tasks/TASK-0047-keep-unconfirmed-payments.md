# TASK-0047: Keep the wallet's unconfirmed payments across restarts

Status: todo
Priority: P2
Size: small
Depends on: TASK-0019
Source: found in TASK-0046 (2026-11-24)

## Why

The mempool lives only in memory and the wallet doesn't rebroadcast its own transactions. While testing `cli history`, two payments made with `cli send` were pending when the node restarted. Afterwards they were gone: not in the mempool, not in the history, and never confirmed. The coins stayed with the sender, but nothing told the user the payment had been dropped. Peers that had already received the transaction keep it only until they restart, and a peer that connects later never gets it, because peers don't exchange mempools.

## Scope

- Save the mempool on shutdown and load it at startup: re-admit each transaction through `addTransaction`, and drop the ones that no longer validate.
- Or, at least, remember the wallet's own unconfirmed transactions and rebroadcast them until they confirm or conflict with the chain.
- Send a new peer the transactions it is missing (an inventory exchange), so a payment reaches nodes that connect later.

## Acceptance criteria

- [ ] A payment pending when the node stops (SIGINT or SIGTERM) is pending again after the restart and confirms afterwards.
- [ ] A saved transaction whose inputs were spent while the node was down is dropped at load without a warning that would fail smoke.
- [ ] Smoke or e2e covers a restart with a pending payment.
