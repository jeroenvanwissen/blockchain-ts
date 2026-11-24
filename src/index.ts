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
	BAN_LIST_PATH,
	DATA_DIR,
	NETWORK_MAGIC,
	P2P_EXTERNAL_PORT,
	P2P_PORT,
	PEER_DATA_PATH,
	REGTEST_NETWORK_MAGIC,
	REGTEST_POW_CUTOFF_BLOCK,
	REGTEST_STAKE_MIN_AGE,
	SEED_NODES,
	WALLET_DISCOVERY_INTERVAL,
} from './config.js';
import { logger } from './logger.js';

const log = logger('Node');

// miningWorker.cjs sits next to Miner (copied to dist/ by tsc via allowJs)
const MINING_WORKER_PATH = fileURLToPath(
	new URL('./blockchain/miningWorker.cjs', import.meta.url),
);
// The block explorer's static files (copied to dist/ by npm run build)
const EXPLORER_DIR = fileURLToPath(new URL('./api/explorer/', import.meta.url));

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
// --reindex: rebuild the chain database from the stored blocks, validating every block
const isReindex = args.includes('--reindex');
const chainOptions = {
	...(isRegtest ? { powCutoffBlock: REGTEST_POW_CUTOFF_BLOCK, minStakeAge: REGTEST_STAKE_MIN_AGE } : {}),
	...(isReindex ? { reindex: true } : {}),
};

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
log.info(
	`Wallet initialized with address: ${wallet.address}${wallet.isEncrypted() ? ' (encrypted, locked: unlock with cli unlock)' : ''}`,
);

// Watch every address the wallet has used, also past the lookahead: a wallet restored from its
// seed phrase finds them as the chain arrives
const discoverAddresses = () => {
	const found = wallet.discoverUsedAddresses((address) => blockchain.hasAddressHistory(address));
	if (found > 0) log.info(`wallet: found ${found} more address(es) in use; ${wallet.issuedCount()} handed out`);
};
discoverAddresses();
setInterval(discoverAddresses, WALLET_DISCOVERY_INTERVAL).unref();

// Create P2P server
const networkMagic = isRegtest ? REGTEST_NETWORK_MAGIC : NETWORK_MAGIC;
const p2pServer = new P2PServer(blockchain, P2P_PORT, PEER_DATA_PATH, {
	networkMagic,
	banListPath: BAN_LIST_PATH,
	externalPort: P2P_EXTERNAL_PORT,
});
if (isRegtest) log.info('Regtest network');

// Proof-of-stake block production with this node's wallet; started below with --stake
const staking = new StakingService(blockchain, wallet, (block) => p2pServer.broadcastBlock(block));

// HTTP API (loopback by default). Chain routes are public; /wallet routes need the token that
// is written to api.cookie on every start (never logged)
const api = new ApiServer(
	blockchain,
	p2pServer,
	{ host: API_HOST, port: API_PORT, network: networkMagic, explorerDir: EXPLORER_DIR },
	{
		wallet,
		token: writeApiCookie(API_COOKIE_PATH),
		broadcast: (transaction) => p2pServer.broadcastTransaction(transaction),
		staking,
	},
);
api
	.listen()
	.then(() => log.info(`API listening on http://${API_HOST}:${api.port()} (block explorer at /)`))
	.catch((error: Error) => log.error(`API could not listen on ${API_HOST}:${API_PORT}:`, error.message));


// Start P2P server; a node that can't accept peers stops instead of running half-alive
p2pServer.listen().catch((error: Error) => {
	log.error(`P2P server could not listen on port ${P2P_PORT}: ${error.message}`);
	void shutdown(1);
});

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

// Seed and command-line peers are the operator's (always kept); peers.json holds learned ones
const configuredPeers = [...new Set([...SEED_NODES, ...cliPeers])];
p2pServer.loadInitialPeers(configuredPeers, filePeers);

// Dial the configured peers, then fill the remaining outbound slots from the address book
p2pServer.connectToPeers(configuredPeers);
p2pServer.fillOutbound();

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
if (isStaking) {
	log.info('Staking enabled');
	staking.start();
}

// Stop cleanly on SIGINT (Ctrl+C) and SIGTERM (systemd, Docker, kill): stop producing blocks,
// save the pending transactions (re-admitted at the next start), close peers and the API, then
// the chain database (each block was already written to it as it connected).
// A second signal exits at once.
let stopping = false;
async function shutdown(code = 0): Promise<void> {
	if (stopping) process.exit(code || 1);
	stopping = true;
	log.info('Stopping blockchain node...');
	staking.stop();
	await miner.stop().catch(() => {});
	const saved = blockchain.saveMempool();
	if (saved !== null) log.info(`saved ${saved} pending transaction(s)`);
	await Promise.allSettled([p2pServer.close(), api.close()]);
	blockchain.close();
	process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// Export for testing
export { api, blockchain, p2pServer, wallet, miner, staking };
