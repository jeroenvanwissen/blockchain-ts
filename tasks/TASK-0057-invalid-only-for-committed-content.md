# TASK-0057: A block is marked invalid only for content its hash commits to, never for the clock

Status: pending
Priority: P1
Size: medium
Depends on: TASK-0056
Source: F-036, F-041 (reassessment 3, 2026-11-27)

## Why

Blocks are marked invalid by hash (`Blockchain._activateBranch`, `markInvalid`), and the mark is permanent. Two kinds of failure don't say anything about the block that hash names:

- **Content the hash doesn't cover (F-036).** The PoS block signature isn't hashed (`Block.ts:50`, `:201`). A block with its last transaction duplicated has the same merkle root, so the same hash (`Block.ts:17-29`). A relayed copy with a junk signature or a duplicated transaction is stored as a side block (`_checkSideBlock` checks neither). When its branch activates, the copy fails, and the real block's hash is marked invalid. The real block is then refused as `block already known`, its children score +50 each, and the node stays on the losing branch and bans honest peers. This was reproduced for the PoS signature, the duplicated transaction and a signature added to a PoW block, and it survives restart and `--reindex`. A copy that extends the tip is rejected, but its hash stays in P2P's seen-cache, so the real block is ignored until the next sync.
- **The clock (F-041).** "Block timestamp too far in the future" is checked in `_connectBlock` against `Date.now()`. A future-dated side block fails when its branch activates, and is marked invalid for good. A node that saw it later accepts it, so slightly different clocks split nodes, contrary to AGENTS.md.

## Scope

- Reject, before a block is stored on any path:
  - a PoS block whose signature doesn't verify against the kernel input's public key;
  - a PoW block that carries a signature;
  - a block with a duplicated transaction (txid or witness hash).

  These need no chain context.
- Don't cache "invalid" for a block that is only too far in the future. Refuse it (benign, as now) without storing it or marking it, so it is accepted when it is no longer too new. Check the future limit before storing, on the side path too.
- P2P: don't let a rejected copy keep the real block out. Mark a block seen only once it is accepted, or key the seen-cache on something that covers the signature.
- Keep the guarantee that a StorageError never marks a block invalid.

## Acceptance criteria

- [ ] A copy of an honest block with a junk signature, sent first, is rejected; the real block is then accepted on every path (extending the tip, side branch, reorganization, sync batch). PoS and PoW.
- [ ] The same for a copy with its last transaction duplicated.
- [ ] A block too far in the future is refused without an invalid mark, and accepted (with its descendants) once the clock has passed it; its descendants don't score.
- [ ] Regression tests for the three scenarios in `ConsensusAttacks.test.ts`.
- [ ] AGENTS.md describes the rule: invalid marks only for failures of content the hash commits to.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e` (consensus and P2P change).

## Notes

Bitcoin Core handles the duplicated-transaction case by refusing "mutated" blocks without caching them as invalid. The same idea, applied to the signature, also covers the PoS case.
