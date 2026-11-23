# TASK-0018: Transaction fees

Status: done
Priority: P2
Size: medium
Depends on: TASK-0006
Source: old E1

## Why

Transactions paid no fee and nothing rewarded including them. Any value left between inputs and outputs was destroyed, because the coinbase had to pay exactly the block reward, and the mempool accepted free transactions of any size.

## Scope

- Fee = inputs − outputs. A block's coinbase pays exactly the block reward plus the fees of its transactions (PoW and PoS; in the BlackCoin model fees go to the block producer).
- Minimum relay fee as mempool and wallet policy: 0.0001 coin per 1000 bytes of serialized transaction. Not a block rule.
- Wallet payments pay the minimum fee for their size; block templates and stake blocks claim the pending fees.
- Out of scope: fee-rate ordering and eviction (TASK-0019), fee estimation beyond the minimum.

## Acceptance criteria

- [x] A block whose coinbase claims more or less than reward + fees is rejected; templates and stake blocks claim exactly that.
- [x] The mempool rejects transactions below the minimum relay fee; blocks may still contain them.
- [x] `createPayment`, `POST /wallet/send` and `cli send` pay the minimum fee and report it.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**Consensus (`Blockchain._connectBlock`)**
- `_checkInputs` returns each transaction's fee. Fees are summed over the block, including the coinstake, which `createStakeBlock` builds without a fee.
- After the transactions are validated, `_checkCoinbaseReward` requires the coinbase to pay exactly reward + fees. The exact rule keeps the "zero reward" rejection meaningful and means a producer can't burn fees by mistake.
- No format change, so no new genesis. Existing chains still load: the node's wallet never created transactions with leftover value.

**Policy**
- `MIN_RELAY_FEE_PER_KB` = 10,000 base units in `config.ts`. `minRelayFee(size)` in `src/blockchain/fees.ts` rounds up. `Transaction.size()` is the serialized size including witness data.
- `BlockchainOptions.minRelayFeePerKb` can override the rate.
- `_addTransactionInternal` rejects fees below the minimum, which also applies when transactions are re-admitted after a reorg.

**Producers**
- `createBlockTemplate` (the miner) and `createStakeBlock` set the coinbase to reward + the pending transactions' fees.

**Wallet**
- `createPayment` returns `{ transaction, fee }`.
- It sizes a draft with fixed-length placeholder witness data (33-byte key, 64-byte signature), so the fee is exactly the minimum for the signed size.
- It adds inputs (largest first) until the amount plus fee is covered. Leftover value too small to pay for a change output goes to the fee.
- `POST /wallet/send` returns `{ txid, fee }`. `cli send` prints the txid on stdout and the fee on stderr.

**Tests**
- `integration/Fees.test.ts` covers:
  - the relay minimum at, and 1 base unit below, the boundary
  - coinbase claims of exactly reward + fees accepted, and ±1 rejected
  - a zero-fee transaction valid inside a block
  - a PoS block claiming fees
  - `createPayment` paying the exact minimum, and folding leftover change into the fee
- `Blockchain.test` setups now fund senders with 9 coins from a 10-coin coinbase so payments can cover the fee. Balance assertions include the exact fee.
- The API payment test checks the reported fee, the change, and the next coinbase claiming the fee.

**Runs**
- `npm run check`: 20 suites, 262 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 113 s (height 25, 5 PoS blocks). A's fee-paying CLI payment was relayed, mined with the fee in the coinbase, and accepted by every node.
