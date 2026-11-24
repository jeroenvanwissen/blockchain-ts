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

// The wallet's secrets encrypted with a passphrase (TASK-0024): AES-256-GCM under a scrypt-derived
// key, with the wallet's public keys as additional authenticated data
message EncryptedKey {
  bytes salt = 1;
  bytes nonce = 2;
  bytes ciphertext = 3;
  bytes auth_tag = 4;
  uint32 scrypt_log_n = 5;
  uint32 scrypt_r = 6;
  uint32 scrypt_p = 7;
}

// An HD wallet (TASK-0041): receiving addresses are m/0'/0/i from the seed. Wallets made before
// it had one random key (fields 1 to 3); an upgraded one keeps that key as its primary address.
message WalletData {
  bytes private_key = 1; // the single key of an older wallet; empty when encrypted
  bytes public_key = 2; // its public key
  string address = 3; // its address
  reserved 4, 5; // were transaction history and UTXOs; balances come from the chain (TASK-0017)
  EncryptedKey encrypted_key = 6; // the seed, then the single key if any, encrypted
  bytes seed = 7; // empty when encrypted
  bytes account_public_key = 8; // m/0' public key and chain code: receiving addresses can be
  bytes account_chain_code = 9; // derived while the wallet is locked
  uint32 receive_count = 10; // receiving addresses handed out
  uint32 seed_format = 11; // 1: the seed is BIP39 entropy (a 24-word phrase); 0: a raw BIP32 seed (before TASK-0049)
}
`;
