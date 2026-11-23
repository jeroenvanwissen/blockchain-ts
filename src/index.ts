import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { ApiServer } from './api/ApiServer.js';
import { writeApiCookie } from './api/cookie.js';
import { Blockchain } from './blockchain/Blockchain.js';
import { Miner } from './blockchain/Miner.js';
import { P2PServer } from './networking/P2PServer.js';
import { StakingService } from './blockchain/StakingService.js';
import { Wallet } from './blockchain/Wallet.js';
import {
	API_COOKIE_PATH,
	API_HOST,
	API_PORT,
	DATA_DIR,
	NETWORK_MAGIC,
	P2P_PORT,
	PEER_DATA_PATH,
	REGTEST_NETWORK_MAGIC,
	REGTEST_POW_CUTOFF_BLOCK,
	REGTEST_STAKE_MIN_AGE,
	SEED_NODES,
} from './config.js';
import { logger } from './logger.js';

const log = logger('Node');

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
const isStaking = args.includes('--stake');
// Regression-test network: own network id, short PoW phase, no minimum stake age
const isRegtest = args.includes('--regtest');
const chainOptions = isRegtest
	? { powCutoffBlock: REGTEST_POW_CUTOFF_BLOCK, minStakeAge: REGTEST_STAKE_MIN_AGE }
	: {};

let blockchain: Blockchain;
try {
	// Create blockchain instance
	blockchain = new Blockchain(chainOptions);
} catch (error) {
	log.error('Failed to load blockchain:', error);
	process.exit(1);
}
const loadedTip = blockchain.getLatestBlock();
log.info(
	`Chain loaded: height ${loadedTip.index}, tip ${loadedTip.hash.slice(0, 16)}`,
);

// Initialize wallet
const wallet = new Wallet();
log.info('Wallet initialized with address:', wallet.address);

// Create P2P server
const networkMagic = isRegtest ? REGTEST_NETWORK_MAGIC : NETWORK_MAGIC;
const p2pServer = new P2PServer(blockchain, P2P_PORT, PEER_DATA_PATH, { networkMagic });
if (isRegtest) log.info('Regtest network');

// HTTP API (loopback by default). Chain routes are public; /wallet routes need the token that
// is written to api.cookie on every start (never logged)
const api = new ApiServer(
	blockchain,
	p2pServer,
	{ host: API_HOST, port: API_PORT, network: networkMagic },
	{
		wallet,
		token: writeApiCookie(API_COOKIE_PATH),
		broadcast: (transaction) => p2pServer.broadcastTransaction(transaction),
	},
);
api
	.listen()
	.then(() => log.info(`API listening on http://${API_HOST}:${api.port()}`))
	.catch((error: Error) => log.error(`API could not listen on ${API_HOST}:${API_PORT}:`, error.message));


// Start P2P server
void p2pServer.listen();

// Load peers from peer data file
let filePeers: string[] = [];
try {
	if (!fs.existsSync(PEER_DATA_PATH)) {
		fs.writeFileSync(PEER_DATA_PATH, JSON.stringify([]));
	}
	const data = fs.readFileSync(PEER_DATA_PATH, 'utf-8');
	filePeers = JSON.parse(data);
} catch (error) {
	log.error('Error reading peer data file:', error);
}

// Combine peers from seed nodes, command line, and file
const allPeers = [...new Set([...SEED_NODES, ...cliPeers, ...filePeers])];

// Register all known peers before connecting
p2pServer.loadInitialPeers(allPeers);

// Connect to all peers
p2pServer.connectToPeers(allPeers);

log.info('Blockchain node started. Listening for peers...');

// Optional proof-of-work mining (--mine); rewards go to this node's wallet
const miner = new Miner(blockchain, wallet.address, MINING_WORKER_PATH, (block) =>
	p2pServer.broadcastBlock(block),
);
if (isMining) {
	log.info('Mining enabled');
	miner.start();
}

// Optional proof-of-stake block production (--stake) with this node's wallet
const staking = new StakingService(blockchain, wallet, (block) => p2pServer.broadcastBlock(block));
if (isStaking) {
	log.info('Staking enabled');
	staking.start();
}

// Handle process termination
process.on('SIGINT', () => {
	log.info('Stopping blockchain node...');
	staking.stop();
	void miner.stop().finally(() => process.exit(0));
});

// Export for testing
export { api, blockchain, p2pServer, wallet, miner, staking };
