# Project assessment: blockchain-ts

Date: 2026-11-23
Scope: whole repository at `feature/d1-peer-discovery` (`eb0e8bf`): `src/`, `proto/`, build and test config, docs. Focus: does a node work end to end.
Confidence: all source files read. Build, tests and lint were run. The node and the standalone miner were run as real processes against temporary data directories. Consensus attack scenarios were run as scripts against a scratch copy that had two one-line import/decode patches (needed to get past F-001 and F-002). Nothing in the repository was modified for these runs.

## Summary

The code has the outline of a hybrid PoW/PoS node: blocks, UTXO tracking, a wallet, chunked block storage, WebSocket peers and a mining worker. All 161 unit tests pass and the TypeScript build is clean. As shipped, though, the node crashes on first start and again on restart. Nothing in the system can produce a block the node accepts. Once those crashes are patched, the consensus rules are not enforced: signatures are never verified, block transactions are not checked against the UTXO set, and stake state lives in node memory rather than on chain. The unit tests miss all of this because they mock `fs` and `protobufjs`, run through ts-jest's CommonJS interop and fake the clock. The next work should come in this order: make the node start and mine, enforce consensus in one validation path, then rebuild PoS around UTXO stake kernels.

## Key findings

Severity is the impact if left unfixed. Priority: P0 now, P1 next, P2 planned, P3 later.

| ID | Finding and evidence | Severity | Priority | Confidence | Next step |
| --- | --- | --- | --- | --- | --- |
| F-001 | **Node crashes on first start.** `import * as secp256k1` yields `{ default }` under native ESM, so `secp256k1.privateKeyVerify` is undefined (`src/blockchain/Wallet.ts:2,72`, same pattern in `src/blockchain/Transaction.ts:1`). Live run: `TypeError: secp256k1.privateKeyVerify is not a function`. `secp256k1` is also only a devDependency (`package.json:35`). | Critical | P0 | verified | TASK-0001 |
| F-002 | **Node crashes on restart.** protobufjs `toObject` omits empty repeated fields without `arrays: true`, so a coinbase's `inputs` comes back `undefined` (`src/blockchain/BlockStore.ts:228,285`). Restarting on an existing data dir fails in `Transaction.isCoinbase`. | Critical | P0 | verified | TASK-0001 |
| F-003 | **No working block production.** `src/index.ts` runs only `StakingService`, which needs registered stake and a chain past height 100. The standalone miner pays a 100-coin reward against a consensus value of 10 (`src/blockchain/Miner.ts:162`). Live run with imports patched: the node logged `invalid coinbase reward amount` for every mined block. The miner also builds its own `Blockchain` on the node's data dir, so difficulty and block index go stale (`Miner.ts:168,238`). It hardcodes `ws://localhost:5001` (`Miner.ts:72`) and uses a `once('message')` reply handler that can catch an unrelated message and stop mining (`Miner.ts:109`). | Critical | P0 | verified | TASK-0004 |
| F-004 | **Signatures are never verified.** Inputs carry no public key. `Transaction.verifySignature` is never called outside tests. Validation only checks that the signature string is non-empty (`Transaction.ts:62-88`, `src/blockchain/Blockchain.ts:937-1010`). Script: a transaction spending another wallet's UTXO with signature `"ff"` was accepted and mined. | Critical | P0 | verified | TASK-0005 |
| F-005 | **Block transactions are not validated against the UTXO set.** `_addMinedBlockInternal` and `replaceChain` only call `hasValidTransactions()`, which checks for non-empty signatures (`Blockchain.ts:204-356,1311-1314`). `updateUTXOSet` silently skips unknown inputs and still credits outputs (`Blockchain.ts:121-158`). Script: a mined block containing a transaction that spends a non-existent output and pays 1,000,000 was accepted, and the balance was credited. | Critical | P0 | verified | TASK-0006 |
| F-006 | **Stake state is node-local, not derived from the chain.** `_stakes` changes through local calls (`stake()` without a transaction, `unstake()`, slashing) and through unauthenticated `STAKE`/`UNSTAKE` peer messages (`Blockchain.ts:520-660`, `src/networking/P2PServer.ts:486-506`). It is never rebuilt on load (`Blockchain.ts:1101-1166`). Script: after a restart the stake reads 0 instead of 100, and the restarted node rejects the next valid PoS block (`validator not eligible for this slot`). | Critical | P0 | verified | TASK-0009, TASK-0011 |
| F-007 | **Block type is misclassified.** A block counts as PoS whenever `tx[1]` looks like a coinstake (`src/blockchain/Block.ts:83-89`). Calling `stake()` puts such a transaction in the mempool, which turns the next PoW-phase block into "PoS". That skips the PoW loop (`Blockchain.ts:927`), and validation then fails with `Invalid stake`. Failed blocks don't clear the mempool, so mining stalls. Nothing rejects PoS blocks before the cutoff. Script: two mining attempts failed, and after the clock moved forward a block with no proof of work was accepted as PoS at height 15. | High | P1 | verified | TASK-0009 |
| F-008 | **Difficulty unit and retarget don't match.** Difficulty counts leading hex zeros (16x work per step) but is adjusted linearly (`Blockchain.ts:1199-1232`). Script: 11 blocks at 15 s against a 30 s target moved difficulty from 4 to 8, which is 65,536x more work. In the default config the 30 s `minBlockInterval` equals the target (`Blockchain.ts:220-227`), so difficulty can never rise. Chain weight uses `2^difficulty` (`Blockchain.ts:101`). | High | P1 | verified | TASK-0007, TASK-0008 |
| F-009 | **PoS inflation and weight are attacker-chosen.** `validateStake` only checks `inputs ≥ outputs[1]`, so the change output `outputs[2]` is unbounded (`Blockchain.ts:409-412`). PoS block weight equals the coinstake amount (`Blockchain.ts:96-100`). | High | P1 | likely (code reading) | TASK-0009 |
| F-010 | **Validation depends on the code path and the wall clock.** `validateStake` uses `Date.now()` for stake age (`Blockchain.ts:414-426`). `replaceChain` applies different PoS checks from `_addMinedBlockInternal`. Loading from disk does no consensus validation. Different nodes, or the same node at different times, can disagree about the same chain. | High | P1 | verified (code reading) | TASK-0006, TASK-0012 |
| F-011 | **Hashing isn't canonical.** The txid is `JSON.stringify` of an object that includes signatures, so signing changes the txid (`Transaction.ts:32-49`). The block hash omits difficulty, height and a merkle root (`Block.ts:24-46`). The peer transaction handler drops `timestamp` and `nonce`, so the txid changes in transit (`P2PServer.ts:479`). | High | P1 | verified (code reading) | TASK-0005, TASK-0007, TASK-0014 |
| F-012 | Amounts are floating-point `number` values stored as protobuf `double` (`Transaction.ts:13`, `proto/blockchain.proto:11`). | Medium | P1 | verified | TASK-0005 |
| F-013 | **Sync protocol gaps.** Every new connection receives the full chain (`P2PServer.ts:279`). Nodes don't handle `LATEST_BLOCK`, so an out-of-order block triggers a request whose reply is ignored (`P2PServer.ts:339-367,459-466`). There is no handshake or network/genesis check, and no transaction relay. | Medium | P1 | verified (code reading) | TASK-0013, TASK-0014 |
| F-014 | `Block.calculateHash` logs twice per call (`Block.ts:43,45`), including every nonce attempt. One test run produced 82,925 hash log pairs (829k log lines, 56 s). | Medium | P0 | verified | TASK-0002 |
| F-015 | **Runtime paths.** Proto files are resolved from `process.cwd()` (`src/config.ts:80-82`); started from another directory, the node fails with `ENOENT .../proto/blockchain.proto`. The wallet always goes to `./data/wallet.dat` and ignores `--data-dir` (`Wallet.ts:53`), so the node and miner share it. The documented `PEERS` env var doesn't exist; the code reads `--peers` and `SEED_NODES`. | Medium | P0 | verified | TASK-0001 |
| F-016 | **Tests don't exercise the runtime.** `Blockchain.test.ts` mocks `fs` and `protobufjs`. ts-jest compiles to CommonJS, which hides F-001. Fake timers hide clock dependence. 161 green tests sit alongside a node that cannot start. | High | P0 | verified | TASK-0003 |
| F-017 | `npm run lint` fails with 41 errors. | Low | P2 | verified | TASK-0021 |
| F-018 | Dead or stale files: `index.js`, `lib/`, `jest.config.js` (a duplicate using CommonJS syntax in an ESM package), empty `tsc.out`, `src/test-consensus.ts`. The package is named `blockchain-js`. `@types/ws` and `@fastone/eslint-config` are runtime dependencies. `winston` is unused. | Low | P2 | verified | TASK-0022 |
| F-019 | **Docs overstate status.** The old backlog marked A1 (transaction signing), A2 (double spend) and C2 (block validation) done, but verification and block-level checks are missing. README lists signature verification, double-spend prevention and "difficulty every 10 blocks" (it's a sliding window recomputed every block). | Medium | P1 | verified | README status note added; tasks above |
| F-020 | The address hash is RIPEMD160 over the hex string of SHA-256 via `crypto-js`, not over the bytes (`Wallet.ts:81-84`). Node's `crypto` has `ripemd160` built in. | Low | P1 | verified | TASK-0005 |

## Architecture and documentation

Observed: one process per node. `Blockchain` holds chain, UTXO map, mempool and stake map behind an `async-mutex` lock. `BlockStore` appends protobuf blocks to `blk*.dat` with an index. `P2PServer` speaks JSON over WebSocket. `Miner` is a separate process using a worker thread.

Mismatch with intent: the PoS design ("stake-weighted lottery over registered stakes, delayed unstaking, slashing") can't be made consistent across nodes without putting stake registration on chain. Proven PoS chains in the Peercoin/BlackCoin family avoid registration altogether. Any mature UTXO can stake. Eligibility is a kernel hash over the stake modifier, the UTXO's outpoint and time, and the block time, compared against `target × value`. The block carries a coinstake transaction and is signed by the staker's key. All state is derived from the chain. The backlog adopts that model (TASK-0009 to TASK-0011). That removes the stake map, unstake delay and slashing features. Owner confirmation is requested in the open questions.

## Validation performed

| Check | Result | Evidence |
| --- | --- | --- |
| `npm run build` | pass | tsc exit 0 |
| `npm test` | pass: 5 suites, 161 tests, 56 s | jest summary; 829,326 log lines |
| `npm run lint` | fail: 41 errors | eslint summary |
| Start node (`tsx src/index.ts --data-dir <tmp>`) | crash | F-001 stack trace |
| Restart node on same data dir | crash | F-002 stack trace |
| Node + standalone miner, imports patched, ~50 s | no blocks accepted | 2× `invalid coinbase reward amount` |
| Forged-signature spend (script) | accepted | F-004 |
| Block minting from a non-existent input (script) | accepted, +1,000,000 | F-005 |
| `stake()` during PoW phase (script) | mining stalls, then a non-PoW block accepted at height 15 | F-007 |
| Restart with stake (script) | stake lost; next PoS block rejected | F-006 |
| Retarget at 2× speed, `minBlockInterval: 0` (script) | difficulty 4 → 8 | F-008 |
| Start from a directory other than the repo root | crash `ENOENT proto/...` | F-015 |
| Dependency audit | not run | — |
| Two-node sync | not run (the chain can't grow past genesis, so there's nothing to sync) | — |

## Recommended sequence

1. **Node runs:** TASK-0001 (start/restart), TASK-0002 (logging), TASK-0003 (real-runtime tests), TASK-0004 (node mines). Done when a fresh node mines blocks, restarts and keeps them, all under an automated smoke test.
2. **Consensus enforced:** TASK-0005 (transaction format + signature verification), TASK-0006 (one block-validation path). Done when the F-004 and F-005 scenarios are regression tests that fail to attack.
3. **PoW header and retarget:** TASK-0007, TASK-0008.
4. **UTXO PoS:** TASK-0011 (remove stake map), TASK-0009 (kernel + coinstake + block signature), TASK-0010 (staker loop).
5. **Network:** TASK-0012 (block tree and reorgs), TASK-0013 (handshake + incremental sync), TASK-0014 (relay), TASK-0015 (multi-node end-to-end test).
6. **Usable:** API, wallet send, fees, mempool, peer limits (TASK-0016 to TASK-0020).

Each format change (transactions, header) invalidates existing data and needs a new genesis. That is acceptable only while no persistent network exists.

## Open questions

- **Chain reset:** OK to break stored data and genesis at each format change until the formats settle? (Assumed yes.)
- **PoS model:** confirm replacing registered stakes, unstake delay and slashing with UTXO kernel staking. Slashing has no equivalent in that model.
- **PoS reward:** fixed per block (current 10) or coin-age based? This affects TASK-0009.
- **Standalone miner:** remove it in favor of an in-node miner, or keep it with a proper block-template protocol? TASK-0004 assumes in-node mining first.
- **Wire format:** keep JSON over WebSocket for messages (with canonical binary hashing) or move to binary messages? TASK-0013 assumes JSON for now.
