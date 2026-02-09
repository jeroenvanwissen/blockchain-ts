# Task B5: Binary Data Persistence with Protocol Buffers

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `B5`                                 |
| **Status**       | `[ ]`                                |
| **Priority**     | Medium                               |
| **Dependencies** | None                                 |
| **Branch**       | `feature/b5-binary-persistence`      |

**Goal:**
Replace JSON-based persistence with Protocol Buffers binary format (`.dat` files) for blockchain data and wallet data, improving storage efficiency and parse performance.

**Current Problems:**

1. **Bloated storage:** Pretty-printed JSON (`null, 2`) wastes significant disk space
2. **Slow parsing:** `JSON.parse()` on large chain files is slower than binary deserialization
3. **No schema enforcement:** JSON allows arbitrary shapes — no compile-time guarantees on persisted data

**Scope:**

```
src/blockchain/
├── Blockchain.ts                       # MODIFY — save/load using protobuf
├── Wallet.ts                           # MODIFY — save/load using protobuf
├── __tests__/Blockchain.test.ts        # MODIFY — update fs mocks for binary data
├── __tests__/Wallet.test.ts            # MODIFY — update fs mocks for binary data
src/
├── config.ts                           # MODIFY — change file extensions to .dat
proto/
├── blockchain.proto                    # CREATE — protobuf schema for chain data
├── wallet.proto                        # CREATE — protobuf schema for wallet data
```

**Implementation:**

1. **Add dependency:** `npm install protobufjs`
2. **Define schemas:** Create `.proto` files for `SerializedBlock`, `SerializedTransaction`, `TxInput`, `TxOutput`, and `WalletData`
3. **Generate types:** Use `protobufjs` static code generation or runtime reflection to load schemas
4. **Update `Blockchain.saveBlockchain()`:** Encode chain as protobuf binary, write to `blockchain_data.dat`
5. **Update `Blockchain.loadBlockchain()`:** Read binary file, decode with protobuf, reconstruct chain
6. **Update `Wallet.saveWallet()`:** Encode wallet data as protobuf binary, write to `wallet.dat`
7. **Update `Wallet.loadWallet()`:** Read binary file, decode with protobuf, reconstruct wallet
8. **Update `config.ts`:** Change `BLOCKCHAIN_DATA_PATH` and wallet default path from `.json` to `.dat`
9. **Update tests:** Adjust fs mocks to work with binary buffers instead of JSON strings

**Proto Schema (draft):**

```protobuf
syntax = "proto3";

message TxInput {
  string previous_tx = 1;
  uint32 output_index = 2;
  string signature = 3;
}

message TxOutput {
  string address = 1;
  double amount = 2;
}

message SerializedTransaction {
  repeated TxInput inputs = 1;
  repeated TxOutput outputs = 2;
  int64 timestamp = 3;
  uint32 nonce = 4;
}

message SerializedBlock {
  int64 timestamp = 1;
  repeated SerializedTransaction transactions = 2;
  string previous_hash = 3;
  uint32 nonce = 4;
  uint32 pow_difficulty = 5;
  uint32 index = 6;
  string hash = 7;
}

message BlockchainData {
  repeated SerializedBlock blocks = 1;
}
```

```protobuf
syntax = "proto3";

message WalletTransaction {
  string hash = 1;
  int64 timestamp = 2;
  string type = 3;
  double amount = 4;
  string other_party = 5;
}

message WalletUtxo {
  string tx_hash = 1;
  uint32 output_index = 2;
  double amount = 3;
}

message WalletData {
  bytes private_key = 1;
  bytes public_key = 2;
  string address = 3;
  repeated WalletTransaction transactions = 4;
  repeated WalletUtxo utxos = 5;
}
```

**Acceptance Criteria:**

- [ ] `protobufjs` added as dependency
- [ ] `.proto` schema files created for blockchain and wallet data
- [ ] `Blockchain.saveBlockchain()` writes binary `.dat` file
- [ ] `Blockchain.loadBlockchain()` reads binary `.dat` file
- [ ] `Wallet.saveWallet()` writes binary `.dat` file
- [ ] `Wallet.loadWallet()` reads binary `.dat` file
- [ ] No `JSON.stringify` / `JSON.parse` remains for blockchain or wallet persistence (save, load, tests)
- [ ] No `.json` file references remain for blockchain or wallet data in config, source, or tests
- [ ] Backup files use `.dat` extension
- [ ] Peers file (`peers.json`) remains JSON (human-editable, small data)
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`
- [ ] Lint passes: `npm run lint`

**Verification Commands:**

```bash
npm run build
npm test
npm run lint
# Test: start node — should create and load .dat files
# Test: verify .dat files are smaller than equivalent .json would be
```
