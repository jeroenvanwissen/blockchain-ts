import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { Blockchain } from './blockchain/Blockchain.js';
import { Miner } from './blockchain/Miner.js';
import { P2PServer } from './networking/P2PServer.js';
import { StakingService } from './blockchain/StakingService.js';
import { Wallet } from './blockchain/Wallet.js';
import { DATA_DIR, P2P_PORT, PEER_DATA_PATH, SEED_NODES } from './config.js';

// miningWorker.cjs sits next to Miner (copied to dist/ by tsc via allowJs)
const MINING_WORKER_PATH = fileURLToPath(
	new URL('./blockchain/miningWorker.cjs', import.meta.url),
);

// Ensure the data directory exists
if (!fs.existsSync(DATA_DIR)) {
	fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Parse command line arguments
const args = process.argv.slice(2);
let cliPeers: string[] = [];
args.forEach((arg, index) => {
	if (arg === '--peers' && args[index + 1]) {
		cliPeers = args[index + 1].split(',');
	}
});
const isMining = args.includes('--mine');

let blockchain: Blockchain;
try {
	// Create blockchain instance
	blockchain = new Blockchain();
} catch (error) {
	console.error('Failed to load blockchain:', error);
	process.exit(1);
}
const loadedTip = blockchain.getLatestBlock();
console.log(
	`Chain loaded: height ${loadedTip.index}, tip ${loadedTip.hash.slice(0, 16)}`,
);

// Initialize wallet
const wallet = new Wallet();
console.log('Wallet initialized with address:', wallet.address);

// Create P2P server
const p2pServer = new P2PServer(blockchain, P2P_PORT, PEER_DATA_PATH);

const stakingService = new StakingService(blockchain, wallet.address, wallet);
stakingService.start();

// Start P2P server
p2pServer.listen();

// Load peers from peer data file
let filePeers: string[] = [];
try {
	if (!fs.existsSync(PEER_DATA_PATH)) {
		fs.writeFileSync(PEER_DATA_PATH, JSON.stringify([]));
	}
	const data = fs.readFileSync(PEER_DATA_PATH, 'utf-8');
	filePeers = JSON.parse(data);
} catch (error) {
	console.error('Error reading peer data file:', error);
}

// Combine peers from seed nodes, command line, and file
const allPeers = [...new Set([...SEED_NODES, ...cliPeers, ...filePeers])];

// Register all known peers before connecting
p2pServer.loadInitialPeers(allPeers);

// Connect to all peers
p2pServer.connectToPeers(allPeers);

console.log('Blockchain node started. Listening for peers...');

// Optional proof-of-work mining (--mine); rewards go to this node's wallet
const miner = new Miner(blockchain, wallet.address, MINING_WORKER_PATH, (block) =>
	p2pServer.broadcastBlock(block),
);
if (isMining) {
	console.log('Mining enabled');
	miner.start();
}

// Handle process termination
process.on('SIGINT', () => {
	console.log('\nStopping blockchain node...');
	void miner.stop().finally(() => process.exit(0));
});

// Export for testing
export { blockchain, p2pServer, wallet, miner };
