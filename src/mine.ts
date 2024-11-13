import { Blockchain } from './blockchain/Blockchain';
import { Miner } from './blockchain/Miner';
import { Block } from './blockchain/Block';
import * as crypto from 'crypto';
import * as fs from 'fs';
import WebSocket from 'ws';
import { DATA_DIR, PEER_DATA_PATH } from './config';

// Parse command line arguments for peers
const args = process.argv.slice(2);
let cliPeers: string[] = [];
args.forEach((arg, index) => {
	if (arg === '--peers' && args[index + 1]) {
		cliPeers = args[index + 1].split(',');
	}
});

// Ensure the data directory exists
if (!fs.existsSync(DATA_DIR)) {
	fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Generate a key pair for the miner
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: {
		type: 'spki',
		format: 'pem',
	},
	privateKeyEncoding: {
		type: 'pkcs8',
		format: 'pem',
	},
});

// Create blockchain instance
const blockchain = new Blockchain();

// Create miner instance
const miner = new Miner(blockchain);

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

// Combine peers from command line and file, ensuring at least one peer
const allPeers = [...new Set([...cliPeers, ...filePeers])];
if (allPeers.length === 0) {
	console.error(
		'Error: No peers specified. Please provide at least one peer using --peers option'
	);
	process.exit(1);
}

// Connect to the first available peer
let connectedToPeer = false;
const connectToPeer = async (peer: string) => {
	if (connectedToPeer) return;

	// Ensure the peer address includes a protocol
	if (!/^wss?:\/\//.test(peer)) {
		peer = `ws://${peer}`;
	}

	const socket = new WebSocket(peer);

	socket.on('open', () => {
		console.log(`Connected to peer: ${peer}`);
		connectedToPeer = true;

		// // Set up message handling
		// socket.on('message', (data: WebSocket.Data) => {
		// 	try {
		// 		const message = JSON.parse(data.toString());

		// 		switch (message.type) {
		// 			case 'CHAIN':
		// 				blockchain.replaceChain(message.data);
		// 				break;
		// 			case 'TRANSACTION':
		// 				blockchain.addTransaction(message.data);
		// 				break;
		// 			case 'NEW_BLOCK':
		// 				const blockData = message.data;
		// 				// Reconstruct the Block instance
		// 				const block = new Block(
		// 					blockData.index,
		// 					blockData.timestamp,
		// 					blockData.transactions,
		// 					blockData.previousHash,
		// 					blockData.miner,
		// 					blockData.consensusType,
		// 					blockData.validatorStake,
		// 					blockData.hash
		// 				);
		// 				block.nonce = blockData.nonce;

		// 				const latestBlock = blockchain.getLatestBlock();
		// 				if (block.previousHash === latestBlock.hash) {
		// 					try {
		// 						const newChain = [...blockchain.getChain(), block];
		// 						blockchain.replaceChain(newChain);
		// 					} catch (error) {
		// 						console.log('Error adding new block:', error);
		// 					}
		// 				}
		// 				break;
		// 		}
		// 	} catch (error) {
		// 		console.log('Error parsing message:', error);
		// 	}
		// });

		// Set the socket in the miner for broadcasting new blocks
		miner.setSocket(socket);

		// Start mining
		console.log('Starting mining operations...');
		miner.startMining();
	});

	socket.on('error', (error) => {
		console.log(`Connection failed to peer: ${peer}`);
		console.error(error);
		// Try next peer if available
		const nextPeerIndex = allPeers.indexOf(peer) + 1;
		if (nextPeerIndex < allPeers.length) {
			connectToPeer(allPeers[nextPeerIndex]);
		} else {
			console.error('Failed to connect to any peers. Exiting...');
			process.exit(1);
		}
	});

	socket.on('close', () => {
		console.log('Connection to peer closed. Attempting to reconnect...');
		connectedToPeer = false;
		setTimeout(() => connectToPeer(peer), 5000); // Try to reconnect after 5 seconds
	});
};

// Start connecting to peers
connectToPeer(allPeers[0]);

// Handle process termination
process.on('SIGINT', () => {
	console.log('\nStopping mining...');
	miner.stopMining();
	process.exit(0);
});

// Export for testing
export { blockchain, miner };
