# TASK-0029: Chainstate snapshot for fast startup

Status: done
Priority: P3
Size: medium
Depends on: TASK-0012
Source: F-025 (reassessment 2026-11-23); owner asked for it after the deferral

## Why

Every start re-validated the whole active chain: signatures, kernels, every transaction against a rebuilt UTXO set. Measured on a 2,012-block chain with 2,000 payments, validation took about 70% of the 650 ms startup. The cost grows linearly with the chain: about 30 s at 100,000 blocks.

## Scope

- Persist the validated state at a tip: UTXO set, stake modifiers, undo data.
- At startup, take that state when its tip is on the branch being activated, and validate only the newer blocks. Replay from genesis otherwise.
- Never trust a damaged file; offer a way to force a full replay.

## Acceptance criteria

- [x] Starting from the chainstate validates only the blocks after it, and the resulting state equals a full replay.
- [x] A chainstate whose tip is no longer on the best branch, a damaged one, or `--reindex` leads to a full replay.
- [x] Reorgs below the saved tip work after starting from it (undo data restored).
- [x] Measured startup improvement.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**`src/blockchain/chainstate.ts`**
- `writeChainstate` writes `<blocks>/chainstate.json` atomically: a header line `{version, checksum}` (sha256 of the payload), then JSON with the tip, height, outputs, modifiers and per-block undo data. Outputs are stored as 8-field tuples.
- `readChainstate` rejects another version, a checksum mismatch or a malformed shape, with the reason.

**`Blockchain`**
- `saveChainstate()` saves the state at the tip. It runs every `chainstateInterval` blocks (`CHAINSTATE_INTERVAL`, 500) from `_connectTip`, and on clean shutdown from the node's SIGINT handler, after the miner stops. A failed save only logs a warning.
- `_replayChain(blocks, start?)` continues from the saved state when `blocks[start.height]` is the saved tip.
- `loadBlockchain` uses the snapshot for each candidate branch that contains its tip, and logs `chainstate at height H; validated N newer block(s)`. Otherwise it replays from genesis, as before.
- A block after the snapshot that fails validation is marked invalid exactly as in a full replay.
- Options: `useChainstate` (false with `--reindex`) and `chainstateInterval`. `isChainValid()` still replays from genesis, as an independent check.
- The file is protected like the block files it summarizes. The checksum catches damage, not deliberate edits: whoever can write the data dir can also replace the blocks. `--reindex` rebuilds from the blocks.

**Measured** (throwaway benchmark, 2,012 blocks with 2,000 payments)
- Startup: 650 ms with a full replay, 204 ms from the chainstate (about 3.2× faster). Saving took 4 ms.
- The rest of startup is reading and decoding blocks and rebuilding the block and transaction indexes.

**Tests** (`integration/Chainstate.test.ts`)
- Start from a chainstate with 3 newer blocks: only 3 blocks are validated, and the state (outputs, modifiers, undo) equals a full replay.
- Chainstate on a branch that was then reorganized away: full replay, consistent.
- Start from a chainstate, then reorganize below its tip: the old branch's payment returns to the mempool, and the state equals a full replay.
- `useChainstate: false` does a full replay. A tampered file gets "ignoring the saved chainstate: checksum mismatch" and a full replay.
- `chainstateInterval: 5` saves at height 5, and a reopen validates the 2 newer blocks.
- Smoke: node A's restart logs `chainstate at height N; validated 0 newer block(s)` and loads the same tip.

**Runs**
- `npm run check`: 28 suites, 304 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 99 s (height 26, 6 PoS blocks). Restarted nodes start from their saved chainstate, including C, which then reorganizes away from the branch it saved while partitioned.
