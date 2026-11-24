import * as path from 'path';
import * as os from 'os';

// Platform-aware default data directory
export const getDefaultDataDir = (): string => {
	const platform = process.platform;
	if (platform === 'win32') {
		const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
		return path.join(appData, 'blockchain-ts');
	} else if (platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support', 'blockchain-ts');
	} else {
		return path.join(os.homedir(), '.blockchain-ts');
	}
};

export const DEFAULT_DATA_DIR = getDefaultDataDir();

// Data directory: --data-dir, else the DATA_DIR env var (the Docker image sets it), else the default
const getDataDirectory = (): string => {
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--data-dir' && args[i + 1]) return args[i + 1];
	}
	return process.env.DATA_DIR || DEFAULT_DATA_DIR;
};

// Export configured paths
export const DATA_DIR = getDataDirectory();
export const BLOCKS_DIR = path.join(DATA_DIR, 'blocks');
export const PEER_DATA_PATH = path.join(DATA_DIR, 'peers.json');

// Block storage
export const MAX_BLOCK_FILE_SIZE = 128 * 1024 * 1024; // 128 MB per blk file
// The chain database (TASK-0053): the active chain's state and the indexes, updated per block
export const CHAIN_DB_FILENAME = 'chain.db'; // in the blocks directory
export const MEMPOOL_FILENAME = 'mempool.json'; // in the blocks directory: pending transactions saved at shutdown

// P2P configuration
export const DEFAULT_P2P_PORT = 5001;

function parsePort(name: string, value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be a port number (1 to 65535), not "${value}"`);
	return port;
}
export const P2P_PORT = process.env.P2P_PORT
	? parseInt(process.env.P2P_PORT)
	: DEFAULT_P2P_PORT;
// The port peers should dial, announced in VERSION, when it isn't P2P_PORT: a Docker port
// published under another number, or a router forwarding another port to this machine
export const P2P_EXTERNAL_PORT = process.env.P2P_EXTERNAL_PORT ? parsePort('P2P_EXTERNAL_PORT', process.env.P2P_EXTERNAL_PORT) : P2P_PORT;

// Local HTTP API (TASK-0016): read-only; loopback unless API_HOST says otherwise.
// API_PORT=0 lets the OS pick a free port (logged at startup).
export const API_PORT_OFFSET = 1000; // default API port = P2P port + this
export const API_HOST = process.env.API_HOST || '127.0.0.1';
export const API_PORT = process.env.API_PORT
	? parseInt(process.env.API_PORT)
	: P2P_PORT + API_PORT_OFFSET;
export const API_COOKIE_PATH = path.join(DATA_DIR, 'api.cookie'); // token for the /wallet routes, rewritten at startup
export const MAX_API_BODY_BYTES = 64 * 1024; // larger request bodies get 413

// Peer protocol (TASK-0013)
export const NETWORK_MAGIC = 'blockchain-ts/devnet'; // peers on another network are dropped
export const PROTOCOL_VERSION = 3; // 2: transaction timestamp rules (TASK-0025); 3: 1200 PoW blocks (TASK-0051)
export const HANDSHAKE_TIMEOUT = 10_000; // ms to complete VERSION/VERACK before disconnecting
export const SYNC_BATCH_SIZE = 200; // max blocks per BLOCKS reply
export const MAX_LOCATOR_HASHES = 64; // max hashes accepted in a GET_BLOCKS locator
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024; // larger WebSocket messages close the socket
export const RELAY_SEEN_CACHE_SIZE = 20_000; // recent block hashes / txids remembered for relay
export const MAX_INVENTORY = 5000; // txids in one MEMPOOL or GET_TRANSACTIONS message (highest fee rates first)

// Regression-test network (--regtest): separate network id, short PoW phase, no stake age,
// for end-to-end tests with real node processes
export const REGTEST_NETWORK_MAGIC = 'blockchain-ts/regtest';
export const REGTEST_POW_CUTOFF_BLOCK = 20;
export const REGTEST_STAKE_MIN_AGE = 0;

// Peer discovery
export const PEER_BROADCAST_INTERVAL = 60_000; // ms between peer list broadcasts
export const MAX_KNOWN_PEERS = 128; // Maximum number of peer addresses to track
// Address book (TASK-0039)
export const MAX_ADDRESSES_PER_MESSAGE = 32; // addresses read from one PEERS message, and sent in one
export const MAX_ADDRESS_FAILURES = 5; // consecutive failures before a learned address is dropped
export const ADDRESS_RETRY_BASE = 30_000; // ms before redialing a failed address; doubles per failure
export const ADDRESS_RETRY_MAX = 60 * 60 * 1000; // retry wait cap

// Peer limits and misbehavior (TASK-0020)
export const MAX_INBOUND_PEERS = 32; // further inbound connections are refused
export const MAX_OUTBOUND_PEERS = 8; // the node dials at most this many peers
export const RECONNECT_BASE_DELAY = 1_000; // ms before the first reconnect; doubles per failed attempt
export const RECONNECT_MAX_DELAY = 60_000; // backoff cap
export const MAX_RECONNECT_ATTEMPTS = 10; // then the periodic outbound fill takes over
export const BAN_SCORE = 100; // misbehavior points that get a peer disconnected and banned
export const BAN_DURATION = 24 * 60 * 60 * 1000; // ms
export const BAN_LIST_PATH = path.join(DATA_DIR, 'banned.json'); // bans survive restarts (TASK-0030)
export const GET_BLOCKS_INTERVAL = 100; // ms between block batches served to one peer
export const MAX_PENDING_GET_BLOCKS = 4; // queued block requests per peer; more is flooding
export const BLOCK_JSON_CACHE_SIZE = 2_000; // serialized blocks kept for sync replies
export const DEFAULT_SEED_NODES: string[] = [];
export const SEED_NODES: string[] = process.env.SEED_NODES
	? process.env.SEED_NODES.split(',').map(s => s.trim()).filter(Boolean)
	: DEFAULT_SEED_NODES;

// Consensus configuration
// Last PoW height; PoS from POW_CUTOFF_BLOCK + 1. About 10 hours of 30-second blocks: longer than
// STAKE_MIN_AGE, so the first mined coins can stake before the PoW phase ends (TASK-0051).
export const POW_CUTOFF_BLOCK = 1200;

// Proof of stake (kernel staking, TASK-0009)
export const STAKE_MIN_AGE = 8 * 60 * 60; // seconds a UTXO must exist before it can stake
export const STAKE_MIN_CONFIRMATIONS = 10; // blocks a UTXO must be buried before it can stake
export const STAKE_TIMESTAMP_GRANULARITY = 16_000; // PoS block timestamps are multiples (ms)
export const STAKE_CHECK_INTERVAL = 1000; // ms between staking attempts (each slot is tried once per tip)
export const STAKE_CHECK_OFFSET = 20; // ms past each wall-clock interval boundary that a check runs

// Coin configuration (amounts are bigint base units)
export const COIN = 100_000_000n; // Base units per coin
export const COIN_MATURITY = 10; // Coins must be at least 10 blocks old
export const POS_BLOCK_REWARD = 10n * COIN; // Reward for Proof-of-Stake blocks
export const POW_BLOCK_REWARD = 10n * COIN; // Reward for mined blocks

// Transaction limits
export const MAX_TRANSACTION_INPUTS = 256;
export const MAX_TRANSACTION_OUTPUTS = 256;

// Block limits
export const MAX_BLOCK_TRANSACTIONS = 1000;
export const MAX_BLOCK_SIZE = 1_000_000; // bytes (header, signature, serialized transactions); keeps blocks relayable
export const MAX_MEMPOOL_BYTES = 8 * 1024 * 1024; // pending transactions beyond this evict the lowest fee rates
export const SIGNATURE_CACHE_SIZE = 50_000; // witness hashes whose signatures were verified (TASK-0028)
export const BLOCK_RESERVED_BYTES = 2_000; // template budget kept for header, coinbase and coinstake
// Fees (TASK-0018): fee = inputs − outputs, claimed by the block's coinbase (consensus). The
// minimum is mempool and wallet policy, not a block rule.
export const MIN_RELAY_FEE_PER_KB = 10_000n; // base units per 1000 bytes of serialized transaction (0.0001 coin)
export const MAX_FUTURE_BLOCK_TIME = 2 * 60 * 60 * 1000; // 2 hours in ms

// Block timing and targets
export const BLOCK_TIME = 30; // Target time between blocks in seconds
export const TARGET_SPACING = BLOCK_TIME * 1000; // ms the per-block retarget aims for
export const RETARGET_WINDOW = 16; // N in the Peercoin-style retarget (smoothing)
export const MAX_RETARGET_SPACING = 10 * TARGET_SPACING; // longer gaps count as this much
export const POW_LIMIT = (1n << 240n) - 1n; // easiest PoW target (~65,536 hashes per block)
export const POS_LIMIT = (1n << 236n) - 1n; // easiest PoS target
export const GENESIS_TIMESTAMP = 1609459200000; // Jan 1, 2021, 00:00:00 UTC

// Mining
export const MAX_BLOCK_NONCE = 0xffffffff; // Block nonce is stored as uint32
export const MINER_TIP_POLL_INTERVAL = 500; // ms between checks for a new tip while hashing
export const MINER_RETRY_DELAY = 1000; // ms to wait after a rejected block before retrying

// Wallet configuration
export const WALLET_DATA_FILENAME = 'wallet.dat';
export const MAX_WALLET_BACKUPS = 3; // Maximum number of wallet backup files to keep
// Receiving addresses the wallet watches beyond those it handed out (TASK-0041), so a backup
// still sees coins on addresses created after it (the BIP44 gap limit)
export const WALLET_ADDRESS_LOOKAHEAD = 20;
export const WALLET_DISCOVERY_INTERVAL = 60_000; // ms between checks for used addresses past the lookahead (restored wallets)
export const WALLET_DISCOVERY_GAP = 100; // unused receiving addresses in a row that discovery looks past
export const MAX_WALLET_ADDRESSES = 100_000; // receiving addresses a wallet hands out (bounds load time)
// Wallet encryption (TASK-0024): scrypt KDF + AES-256-GCM. log2(N) = 15, r = 8 → 32 MiB and about
// 0.1 s per unlock attempt. Stored per wallet, so stronger settings apply to newly encrypted ones.
export const WALLET_SCRYPT = { logN: 15, r: 8, p: 1 };
export const MIN_PASSPHRASE_LENGTH = 8;

// Timestamp rules
export const MEDIAN_TIME_SPAN = 11; // Number of blocks for median time calculation
