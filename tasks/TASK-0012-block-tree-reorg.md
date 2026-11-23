# TASK-0012: Block tree, chain-work selection and reorganizations

Status: done
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

- [x] With two competing branches, the one with more work wins, and the UTXO set equals a fresh rebuild.
- [x] Reorging back and forth leaves identical state.
- [x] A restart restores the active tip.

## Validation

`npm test` (integration tests with temp dirs).

## Outcome

**Block index:** `Blockchain._index` maps hash → `{ block, height, work, isInvalid }` for every known block. The active chain stays in `chain`, with its UTXO set, stake modifiers and undo data (`_undo`: the outputs each block spent).

**Acceptance** (`addMinedBlock` → `_acceptBlock`, which returns `'connected' | 'reorganized' | 'side'`)
- It rejects known blocks, hash mismatches, unknown parents, branches containing a known-invalid block, and wrong heights.
- A block that extends the tip is fully validated (`_connectTip` → `_connectBlock`), indexed and stored.
- Any other block passes cheap header checks: size, consensus type for its height, PoW meeting its target, and bits as required for its own branch. It's then indexed and stored as a side block.
- If its branch has more work than the tip, `_activateBranch` disconnects back to the fork point (`_disconnectTip` uses the undo data) and connects the branch with full validation.
- If a branch block fails, it's marked invalid and the old chain is reconnected.

**Mempool:** after a new tip or a reorg, pending transactions and those from disconnected blocks are re-checked (`_readmitTransactions`). A peer's block no longer wipes unrelated pending transactions.

**Storage**
- Every accepted block is appended; `BlockStore.replaceAll` is gone. `getBlockByHeight` returns the most recently stored block at that height.
- At startup the node rebuilds the tree from storage, then activates the branch with the most work that passes full replay. If a branch fails, it marks the failing block invalid and tries the next best. A stored invalid block no longer stops the node from starting.

**Chain replacement:** `replaceChain` keeps its API and errors (weight, genesis, index and link checks), but feeds blocks through `_acceptBlock`, so peers' chains cause normal reorgs.

**P2P:** blocks with a known parent are accepted at any height, and side-branch blocks are logged as such. A block is only "ahead" when its parent is unknown; TASK-0013 adds fetching of missing blocks.

**Limits (noted for later):**
- PoS side blocks are only header-checked until activated, so cheap junk side blocks can be stored. Peer misbehavior scoring belongs to TASK-0020.
- A failed reorg returns to the old chain even if a valid prefix of the new branch has more work.

**Tests:** new `src/__tests__/integration/Reorg.test.ts`:
- a lighter side branch is stored but not activated;
- a heavier branch wins, its payment returns to the mempool, and the state equals a fresh replay;
- reorging back and forth stays consistent and the payment is confirmed again;
- a restart restores the tip with side blocks on disk;
- an invalid block in the heavier branch leaves the old chain intact, and its descendants are rejected;
- pending transactions survive a peer block.

`npm test`: 15 suites, 209 tests.
