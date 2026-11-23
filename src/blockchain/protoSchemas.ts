// Protobuf schemas for on-disk formats. Embedded as strings so they load from any
// working directory and from dist/ (tsc doesn't copy .proto files).

export const BLOCKCHAIN_SCHEMA = `
syntax = "proto3";

message TxInput {
  string previous_tx = 1;
  uint32 output_index = 2;
  string signature = 3;
  string public_key = 4;
}

message TxOutput {
  string address = 1;
  reserved 2; // was double amount
  uint64 amount = 3; // base units
}

message SerializedTransaction {
  repeated TxInput inputs = 1;
  repeated TxOutput outputs = 2;
  int64 timestamp = 3;
  reserved 4; // was random nonce
  uint32 version = 5;
}

message SerializedBlock {
  int64 timestamp = 1;
  repeated SerializedTransaction transactions = 2;
  string previous_hash = 3;
  uint32 nonce = 4;
  reserved 5; // was pow_difficulty (leading hex zeros)
  uint32 index = 6;
  string hash = 7;
  uint32 bits = 8; // compact target
  uint32 version = 9;
  string signature = 10; // PoS block signature (hex), empty for PoW
}

message BlockchainData {
  repeated SerializedBlock blocks = 1;
}
`;

export const BLOCK_INDEX_SCHEMA = `
syntax = "proto3";

message BlockIndexEntry {
  string hash = 1;
  uint32 height = 2;
  uint32 file_number = 3;
  uint64 byte_offset = 4;
  uint32 data_length = 5;
}

message BlockIndex {
  repeated BlockIndexEntry entries = 1;
  uint32 current_file_number = 2;
  uint64 current_file_size = 3;
}
`;

export const WALLET_SCHEMA = `
syntax = "proto3";

message WalletData {
  bytes private_key = 1;
  bytes public_key = 2;
  string address = 3;
  reserved 4, 5; // were transaction history and UTXOs; balances come from the chain (TASK-0017)
}
`;
