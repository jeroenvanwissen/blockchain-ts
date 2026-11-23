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

// Get data directory from command line args
const getDataDirectory = (): string => {
	const args = process.argv.slice(2);
	let dataDirectory = DEFAULT_DATA_DIR;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--data-dir' && args[i + 1]) {
			dataDirectory = args[i + 1];
			break;
		}
	}

	return dataDirectory;
};

// Export configured paths
export const DATA_DIR = getDataDirectory();
export const BLOCKS_DIR = path.join(DATA_DIR, 'blocks');
export const PEER_DATA_PATH = path.join(DATA_DIR, 'peers.json');

// Block storage
export const MAX_BLOCK_FILE_SIZE = 128 * 1024 * 1024; // 128 MB per blk file

// P2P configuration
export const DEFAULT_P2P_PORT = 5001;
export const P2P_PORT = process.env.P2P_PORT
	? parseInt(process.env.P2P_PORT)
	: DEFAULT_P2P_PORT;

// Peer discovery
export const PEER_BROADCAST_INTERVAL = 60_000; // ms between peer list broadcasts
export const MAX_KNOWN_PEERS = 128; // Maximum number of peer addresses to track
export const DEFAULT_SEED_NODES: string[] = [];
export const SEED_NODES: string[] = process.env.SEED_NODES
	? process.env.SEED_NODES.split(',').map(s => s.trim()).filter(Boolean)
	: DEFAULT_SEED_NODES;

// Consensus configuration
export const POW_CUTOFF_BLOCK = 100; // last PoW height; PoS from POW_CUTOFF_BLOCK + 1

// Proof of stake (kernel staking, TASK-0009)
export const STAKE_MIN_AGE = 8 * 60 * 60; // seconds a UTXO must exist before it can stake
export const STAKE_MIN_CONFIRMATIONS = 10; // blocks a UTXO must be buried before it can stake
export const STAKE_TIMESTAMP_GRANULARITY = 16_000; // PoS block timestamps are multiples (ms)
export const STAKE_CHECK_INTERVAL = 1000; // ms between staking attempts (each slot is tried once per tip)

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

// Timestamp rules
export const MEDIAN_TIME_SPAN = 11; // Number of blocks for median time calculation
