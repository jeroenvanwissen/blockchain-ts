# TASK-0012: Block tree, chain-work selection and reorganizations

Status: pending
Priority: P1
Size: large
Depends on: TASK-0006, TASK-0007
Source: F-010, old C1

## Why

Fork handling swaps in a full received chain and rewrites storage with `BlockStore.replaceAll` (`src/blockchain/Blockchain.ts:1269-1459`). Side branches aren't kept. Validation differs from the add-block path.

## Scope

- Block index keyed by hash: height, cumulative work, validation status, stake modifier.
- Store side-branch blocks.
- Select the tip by most work.
- Reorg by disconnecting blocks with undo data and connecting the new branch through the TASK-0006 path.
- Return disconnected transactions to the mempool.
- `BlockStore` stays append-only for all branches; remove `replaceAll`.

## Acceptance criteria

- [ ] With two competing branches, the one with more work wins, and the UTXO set equals a fresh rebuild.
- [ ] Reorging back and forth leaves identical state.
- [ ] A restart restores the active tip.

## Validation

`npm test` (integration tests with temp dirs).
