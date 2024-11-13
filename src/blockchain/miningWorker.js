// In miningWorker.js
const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');

if (!parentPort) {
	throw new Error('Not running in worker thread');
}

// Recreate Block-like structure for mining
class MiningBlock {
	constructor(timestamp, transactions, previousHash, nonce, difficulty, index) {
		this.timestamp = timestamp;
		this.transactions = transactions;
		this.previousHash = previousHash;
		this.nonce = nonce;
		this.difficulty = difficulty;
		this.index = index;
		this.hash = this.calculateHash();
	}

	calculateHash() {
		const data =
			this.previousHash +
			this.timestamp +
			JSON.stringify(this.transactions) +
			this.nonce +
			this.index;
		return crypto.createHash('sha256').update(data).digest('hex');
	}

	isValid() {
		return (
			this.hash.substring(0, this.difficulty) ===
			Array(this.difficulty + 1).join('0')
		);
	}
}

function mineBlock() {
	const { minerAddress, difficulty, previousHash, pendingTransactions } =
		workerData;

	// Create coinbase transaction
	const coinbaseTransaction = {
		inputs: [],
		outputs: [
			{
				address: minerAddress,
				amount: 12500, // POW_BLOCK_REWARD
			},
		],
		timestamp: Date.now(),
	};

	// Create block
	const block = new MiningBlock(
		Date.now(),
		[coinbaseTransaction, ...pendingTransactions],
		previousHash,
		0,
		difficulty,
		0 // Index will be set by blockchain
	);

	// Mine until valid hash found
	console.log('Starting mining process...');
	while (!block.isValid()) {
		block.nonce++;
		block.hash = block.calculateHash();

		// Optional: Report progress every 100000 hashes
		if (block.nonce % 100000 === 0) {
			parentPort.postMessage({
				type: 'progress',
				nonce: block.nonce,
				hash: block.hash,
			});
		}
	}

	console.log('Block mined:', block);
	parentPort.postMessage({ type: 'block', data: block });
}

try {
	mineBlock();
} catch (error) {
	parentPort.postMessage({ type: 'error', error: error.message });
}
