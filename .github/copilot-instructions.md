# Copilot Instructions for blockchain-ts

Purpose

- This repository implements a UTXO-based blockchain in TypeScript with Proof of Work (PoW) transitioning to Proof of Stake (PoS), basic staking, and a WebSocket P2P layer.
- Goals:
  - Maintain a clear PoW→PoS transition at the configured cutoff.
  - Keep chain validity and UTXO correctness under mixed consensus.
  - Improve networking sync and staking ergonomics over time.
  - Provide a solid foundation for educational purposes and future enhancements.
  - Add functional tests for PoW, PoS, and UTXO behavior.

Tech Stack and Conventions

- TypeScript (ESM modules; `"type": "module"`).
- Node.js runtime.
- Jest for unit tests.
- Async Mutex for concurrent chain replacement.
- WebSocket (ws) for P2P.
- File persistence for chain and peers.
- Use existing workspace APIs before introducing new ones.

Project Structure

- Core
  - Blockchain: [`Blockchain`](../src/blockchain/Blockchain.ts)
  - Block: [`Block`](../src/blockchain/Block.ts)
  - Transaction: [`Transaction`](../src/blockchain/Transaction.ts)
  - Wallet: [`Wallet`](../src/blockchain/Wallet.ts)
  - Miner: [`Miner`](../src/blockchain/Miner.ts)
  - Staking: [`StakingService`](../src/blockchain/StakingService.ts)
- Networking
  - P2P Server: [`P2PServer`](../src/networking/P2PServer.ts)
- Config and entry points
  - Config: [`src/config.ts`](../src/config.ts)
  - Node startup: [`src/index.ts`](../src/index.ts)
  - Miner entry: [`src/mine.ts`](../src/mine.ts)
  - Example script: [`src/test-consensus.ts`](../src/test-consensus.ts)
- Tests
  - Blockchain tests: [`src/blockchain/__tests__/Blockchain.test.ts`](../src/blockchain/__tests__/Blockchain.test.ts)
  - Networking tests: [`src/networking/__tests__/P2PServer.test.ts`](../src/networking/__tests__/P2PServer.test.ts)

Consensus Model

- PoW up to cutoff:
  - `POW_CUTOFF_BLOCK` in [`src/config.ts`](../src/config.ts) controls when PoW stops. See [`Blockchain.canAcceptPowBlock`](../src/blockchain/Blockchain.ts).
  - Blocks must satisfy [`Block.isValid`](../src/blockchain/Block.ts) PoW check and timing constraints in [`Blockchain.addMinedBlock`](../src/blockchain/Blockchain.ts).
- PoS after cutoff:
  - Staking via [`Blockchain.stake`](../src/blockchain/Blockchain.ts) and [`Blockchain.unstake`](../src/blockchain/Blockchain.ts).
  - Eligibility checks in `canCreateStakeBlock` within [`Blockchain`](../src/blockchain/Blockchain.ts). Test mode relaxes time checks (`process.env.NODE_ENV === 'test'`).
  - Stake weight: [`Blockchain.calculateStakeWeight`](../src/blockchain/Blockchain.ts).
  - PoS block identification: [`Block.isProofOfStake`](../src/blockchain/Block.ts).

UTXO and Balances

- UTXO model stored in `utxoSet` inside [`Blockchain`](../src/blockchain/Blockchain.ts). Access via:
  - [`Blockchain.getUTXOs`](../src/blockchain/Blockchain.ts)
  - [`Blockchain.getBalance`](../src/blockchain/Blockchain.ts) for confirmed UTXO sum
  - [`Blockchain.getTotalBalance`](../src/blockchain/Blockchain.ts) scans all transactions (historical), used in tests
- Wallet helpers:
  - [`Wallet.getSpendableOutputs`](../src/blockchain/Wallet.ts) selects UTXOs for a target amount.
  - [`Wallet.getBalance`](../src/blockchain/Wallet.ts) returns wallet’s UTXO balance.
  - [`Wallet.getAddress`](../src/blockchain/Wallet.ts) exposes address.

Blocks and Validation

- Block validity:
  - [`Block.isValid`](../src/blockchain/Block.ts) verifies PoW hash integrity and prefix target for PoW blocks.
  - [`Block.isProofOfWork`](../src/blockchain/Block.ts) vs [`Block.isProofOfStake`](../src/blockchain/Block.ts).
- Chain validity:
  - [`Blockchain.isChainValid`](../src/blockchain/Blockchain.ts) checks continuity, transaction validity, PoW/PoS criteria.
- Adding a mined block:
  - [`Blockchain.addMinedBlock`](../src/blockchain/Blockchain.ts) enforces:
    - Transaction validity (`hasValidTransactions`)
    - Minimum block time (see `BLOCK_TIME` in [`Blockchain`](../src/blockchain/Blockchain.ts))
    - Previous hash consistency and index alignment
    - Difficulty rules via block’s stored difficulty

Staking Rules

- Minimums:
  - `MIN_STAKE_AMOUNT = 100`, `MIN_STAKE_AGE = 24h` (production), `COIN_MATURITY = 10` blocks in [`src/config.ts`](../src/config.ts) and enforced in [`Blockchain`](../src/blockchain/Blockchain.ts).
- Validation:
  - Stake transaction format validated in `validateStake` within [`Blockchain`](../src/blockchain/Blockchain.ts).
- Service:
  - [`StakingService`](../src/blockchain/StakingService.ts) periodically attempts to generate a stake block and adds it via [`Blockchain.addMinedBlock`](../src/blockchain/Blockchain.ts).

Networking

- WebSocket server client:
  - [`P2PServer`](../src/networking/P2PServer.ts) manages peer connections, synchronizes chains, and relays transactions/blocks/staking messages.
  - Message types include CHAIN, TRANSACTION, BLOCK, STAKE, UNSTAKE, GET_LATEST_BLOCK, LATEST_BLOCK.
- Chain replacement safety:
  - `replaceLock: Mutex` in [`Blockchain`](../src/blockchain/Blockchain.ts) helps serialize replacements during sync.

Configuration

- Paths: [`src/config.ts`](../src/config.ts) defines data directory, file paths, and ports.
- Consensus:
  - `POW_CUTOFF_BLOCK = 100`
  - `POS_START_BLOCK = 90`, `MIXED_MODE_START_BLOCK = 80` (project currently enforces PoW cutoff at 100; keep consistent when changing)
- Rewards:
  - `POW_BLOCK_REWARD = 12500`, `POS_BLOCK_REWARD = 10`
- Timing:
  - `BLOCK_TIME = 10 * 60` (seconds). Tests typically space blocks by 11 minutes.

Build, Run, Test

- Scripts (see `package.json`):
  - Dev: `npm run dev`
  - Start: `npm start`
  - Mine: `npm run mine`
  - Build: `npm run build`
  - Test: `npm test`
- Node startup (Mac examples):
  - Single node: `npm run dev`
  - Custom port: `P2P_PORT=5002 npm run dev`
  - Peers via CLI: `npm run dev -- --peers ws://localhost:5001,ws://localhost:5002`
    - Note: peers are read from `--peers` arg and from the peer data file; `P2P_PORT` comes from env.
- Data directory:
  - Defaults to `./data`. Override with `--data-dir <path>`.

Testing Notes

- Tests rely on fake timers and mocked `Date.now` to satisfy block spacing and stake age:
  - See cases in [`Blockchain.test.ts`](../src/blockchain/__tests__/Blockchain.test.ts) for PoW generation, PoS transition, and stake weight evolution.
  - In test mode, `canCreateStakeBlock` skips time gating.
- Networking tests mock chain replacement and stake handling in [`P2PServer.test.ts`](../src/networking/__tests__/P2PServer.test.ts).

Coding Guidelines for Copilot

- Prefer existing APIs:
  - Use [`Blockchain.getUTXOs`](../src/blockchain/Blockchain.ts), [`Blockchain.getBalance`](../src/blockchain/Blockchain.ts), [`Blockchain.stake`](../src/blockchain/Blockchain.ts), [`Blockchain.addMinedBlock`](../src/blockchain/Blockchain.ts), [`Block.isValid`](../src/blockchain/Block.ts), [`Transaction.signTransaction`](../src/blockchain/Transaction.ts) rather than creating duplicates.
- Imports and modules:
  - ESM imports only (no require). Maintain file-local helpers vs. adding global utilities.
- Persistence and concurrency:
  - Respect `replaceLock` when proposing chain sync changes.
- Error handling:
  - Keep error messages consistent with existing patterns and tests.
- Tests:
  - Update or add Jest tests under `src/**/__tests__/**` when changing behavior or adding features.
  - Use fake timers and explicit timestamps to satisfy `BLOCK_TIME` constraints in tests.
- Code blocks in PRs or docs:
  - Use four backticks fences.
  - If modifying/creating files, include a line comment with `filepath:` and the absolute repo path.
  - Use `// ...existing code...` markers to show context when suggesting patches.

Common Tasks for Copilot

- Explain or review code in the active editor (e.g., walk through [`Blockchain.isChainValid`](../src/blockchain/Blockchain.ts) or [`Block.isValid`](../src/blockchain/Block.ts)).
- Propose fixes to:
  - Chain timing validation in [`Blockchain.addMinedBlock`](../src/blockchain/Blockchain.ts)
  - Stake validation in `validateStake`
  - P2P sync robustness in [`P2PServer`](../src/networking/P2PServer.ts)
- Generate unit tests for:
  - PoW→PoS transition timing
  - UTXO spend and change handling
  - Stake age and minimum stake enforcement
- Scaffold features:
  - Additional P2P message handling (e.g., peer discovery) aligned with existing types.
  - Improved miner worker orchestration in [`Miner`](../src/blockchain/Miner.ts) as needed.

Non-Goals

- No production-grade cryptography or wallet management beyond the simplified model here.
- No mainnet connectivity or real economic security; this is an educational/experimental implementation.

Known Pitfalls

- Block time enforcement: `BLOCK_TIME` is enforced in [`Blockchain.addMinedBlock`](../src/blockchain/Blockchain.ts); tests typically use 11-minute spacing.
- Stake weight uses `lastBlockTime - timestamp`; ensure updates to `lastBlockTime` are coherent when changing stake logic.
- Mixed consensus constants: keep `POW_CUTOFF_BLOCK`, `POS_START_BLOCK`, `MIXED_MODE_START_BLOCK` coherent if modified.

Example Prompts

- “Explain how [`Blockchain.stake`](../src/blockchain/Blockchain.ts) constructs staking transactions and updates `stakes`.”
- “Add a unit test proving PoS blocks are rejected if created within `BLOCK_TIME` of the previous block.”
- “Refactor [`P2PServer`](../src/networking/P2PServer.ts) chain replacement to validate with `replaceLock` and clear pending transactions on adoption.”
- “Implement a helper on [`Blockchain`](../src/blockchain/Blockchain.ts) to compute matured UTXO balance, respecting `COIN_MATURITY`.”

Security and Safety

- Do not introduce code that logs private keys or sensitive material.
- Keep address validation via [`Blockchain.validateAddress`](../src/blockchain/Blockchain.ts) for inputs that claim to be addresses.

Alignment with TODO

- See [`TODO`](../TODO) for networking enhancements (peer storage/sync), blockchain features (consensus/validation), and API ideas. Proposals should reference and tick items off
