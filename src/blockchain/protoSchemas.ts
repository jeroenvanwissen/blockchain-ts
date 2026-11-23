// Protobuf schemas for on-disk formats. Embedded as strings so they load from any
// working directory and from dist/ (tsc doesn't copy .proto files).

export const BLOCKCHAIN_SCHEMA = `
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
`;
