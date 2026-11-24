# TASK-0047: Keep the wallet's unconfirmed payments across restarts

Status: done
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

- [x] A payment pending when the node stops (SIGINT or SIGTERM) is pending again after the restart and confirms afterwards.
- [x] A saved transaction whose inputs were spent while the node was down is dropped at load without a warning that would fail smoke.
- [x] Smoke or e2e covers a restart with a pending payment.

## Outcome

**Saved mempool (`mempoolFile.ts`, `Blockchain.saveMempool`, `_loadMempool`)**
- At shutdown (SIGINT, SIGTERM, `docker stop`) the node writes its pending transactions to `blocks/mempool.json`: JSON with a version, the transactions in arrival order in the wire format, written atomically. It logs `saved N pending transaction(s)`.
- Constructing a `Blockchain` re-admits them through the usual mempool checks (`_addTransactionInternal`). It doesn't matter whether startup used the chainstate or replayed the chain. Transactions confirmed, conflicting or otherwise invalid by now are dropped at debug level. The info line `Mempool loaded: N pending transaction(s), M no longer valid` reports the result, with no warning, so smoke doesn't fail on it.
- A damaged file or one from another version is ignored with a warning.
- A crash still loses pending transactions that no peer has. The file isn't written while the node runs; the coins stay spendable.

**Pending-transaction exchange (`P2PServer`)**
- After the handshake each side sends `MEMPOOL`: the txids of up to `MAX_INVENTORY` (5,000) pending transactions, highest fee rate first.
- The receiver requests the ones it doesn't have (`GET_TRANSACTIONS`) once it has the sender's chain: immediately if it has the sender's tip, otherwise when its sync from that peer finishes (a `BLOCKS` reply without `more`). Until then the inputs may be in blocks it lacks, and the transactions would be rejected.
- Requested transactions arrive as ordinary `TRANSACTION` messages, so they are validated and relayed like any other. They skip the relay's seen-cache, so a transaction rejected while the node was behind is reconsidered.
- Each announced transaction is sent at most once per connection, and only if it was announced to that peer. A connection costs at most one mempool's worth of transactions.
- One `MEMPOOL` per connection is processed. Malformed lists score 10 misbehavior points.
- Nodes from before the exchange ignore the two new message types, so `PROTOCOL_VERSION` stays 2.

**Tests**
- `PendingTransactions.test.ts`, chain level:
  - two pending payments are saved; one input is spent by a block while the node is "down"
  - the restart (from the chainstate and from a full replay) re-admits the other with the expected log line and no warning
  - the arrival order is kept, and the file is written atomically
  - a damaged file is ignored with a warning
- `PendingTransactions.test.ts`, real WebSockets:
  - a peer that starts with only the genesis block receives a payment made before it connected, after it has synced. The payment was pre-marked as seen, as if rejected while behind.
  - two synced peers exchange their pending transactions in both directions
  - only announced transactions are served, each once; malformed lists are penalized
- Smoke: the SIGTERM stop writes `blocks/mempool.json` and reports it.
- e2e, new step 7:
  - C restarts alone and pays A with `cli send`, then restarts with SIGTERM
  - C logs `saved 1 pending transaction(s)` and `Mempool loaded: 1 pending transaction(s)`, and its `cli history` shows the pending send
  - C rejoins behind and without staking; A requests the payment from C's `MEMPOOL` and stakes it into a block
  - all three nodes agree, and C sees the payment confirmed

## Runs

- `npm run check`: 34 suites, 347 tests, lint clean.
- Mutation checks:
  - requesting a peer's transactions before catching up with its chain fails the behind-peer test
  - dropping the seen-cache bypass for requested transactions fails it too
  - serving transactions that weren't announced fails the serving test
  - not sending `MEMPOOL` after the handshake fails 3 tests
- `npm run smoke`: PASS, including the mempool file and log line after the SIGTERM stop.
- `npm run e2e`: PASS three times with step 7 (height 26, 6 PoS blocks; C staked 1 to 3 of them).
- `npm run docker:check`: PASS (clean `docker stop` and a restart from the volume with no warnings; it doesn't check the mempool file itself).
