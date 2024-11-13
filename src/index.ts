import { Blockchain } from './blockchain/Blockchain';
import { P2PServer } from './networking/P2PServer';
import { StakingService } from './blockchain/StakingService';
import { Wallet } from './blockchain/Wallet';
import * as fs from 'fs';
import { DATA_DIR, P2P_PORT, PEER_DATA_PATH } from './config';

// Ensure the data directory exists
if (!fs.existsSync(DATA_DIR)) {
	fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Parse command line arguments for peers
const args = process.argv.slice(2);
let cliPeers: string[] = [];
args.forEach((arg, index) => {
	if (arg === '--peers' && args[index + 1]) {
		cliPeers = args[index + 1].split(',');
	}
});

let blockchain: Blockchain;
try {
	// Create blockchain instance
	blockchain = new Blockchain();
} catch (error) {
	console.error('Failed to load blockchain:', error);
	process.exit(1);
}

// Initialize wallet
const wallet = new Wallet();
console.log('Wallet initialized with address:', wallet.address);

// Create P2P server
const p2pServer = new P2PServer(blockchain, P2P_PORT, PEER_DATA_PATH);

const stakingService = new StakingService(blockchain, wallet.address);
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

// Combine peers from command line and file
const allPeers = [...new Set([...cliPeers, ...filePeers])];

// Connect to all peers
p2pServer.connectToPeers(allPeers);

console.log('Blockchain node started. Listening for peers...');

// Handle process termination
process.on('SIGINT', () => {
	console.log('\nStopping blockchain node...');
	process.exit(0);
});

// Export for testing
export { blockchain, p2pServer, wallet };
