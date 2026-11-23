# TASK-0015: Multi-node end-to-end test

Status: pending
Priority: P1
Size: medium
Depends on: TASK-0004, TASK-0010, TASK-0013, TASK-0014
Source: F-016

## Why

Nothing currently checks that several real nodes agree on a chain. This test is the definition of "the network works".

## Scope

Add `npm run e2e`. It spawns two or three real node processes in temp dirs with accelerated chain params (low last-PoW height, short spacing, short stake age). The scenario:

1. Mine past the PoS cutoff.
2. Stake.
3. Send a transaction.
4. Partition one node, let both sides produce blocks, then reconnect (reorg).
5. Restart a node.

Assert that the tips and UTXO sets converge.

## Acceptance criteria

- [ ] The scenario passes repeatably on a developer machine within a few minutes.
- [ ] Failures print each node's tip, height and last log lines.

## Validation

`npm run e2e` (new).
