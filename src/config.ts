import * as path from 'path';

// Default data directory
export const DEFAULT_DATA_DIR = './data';

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
export const BLOCKCHAIN_DATA_PATH = path.join(DATA_DIR, 'blockchain_data.json');
export const PEER_DATA_PATH = path.join(DATA_DIR, 'peers.json');

// P2P configuration
export const DEFAULT_P2P_PORT = 5001;
export const P2P_PORT = process.env.P2P_PORT
	? parseInt(process.env.P2P_PORT)
	: DEFAULT_P2P_PORT;

// Consensus configuration
export const POW_CUTOFF_BLOCK = 100;
export const POS_START_BLOCK = 80;
export const MIXED_MODE_START_BLOCK = 80; // New constant for mixed mode

// Coin configuration
export const COIN_MATURITY = 10; // Coins must be at least 10 blocks old
export const POS_BLOCK_REWARD = 10; // Reward for Proof-of-Stake blocks
export const POW_BLOCK_REWARD = 12500; // Reward for mined blocks
