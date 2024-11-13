const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');

// Reconstruct block from worker data
const blockData = workerData.blockData;
const difficulty = workerData.difficulty;
const target = Array(difficulty + 1).join('0');

let shouldStop = false;

// Mining function
function mineBlock(block) {
	while (!shouldStop) {
		// Calculate hash with current nonce
		const data =
			block.index +
			block.previousHash +
			block.timestamp +
			JSON.stringify(block.transactions) +
			block.nonce +
			block.miner +
			(block.validatorStake || ''); // Added validatorStake to match Block.ts

		const hash = crypto.createHash('sha256').update(data).digest('hex');

		// Check if hash meets difficulty requirement
		if (hash.substring(0, difficulty) === target) {
			block.hash = hash;
			parentPort.postMessage({ success: true, block });
			return;
		}

		block.nonce++;

		// Every 100000 attempts, report progress
		if (block.nonce % 100000 === 0) {
			parentPort.postMessage({
				success: false,
				progress: {
					nonce: block.nonce,
					currentHash: hash,
				},
			});
		}
	}
}

// Start mining
mineBlock(blockData);

console.log('Worker started');

// Handle termination
parentPort.on('message', (message) => {
	if (message === 'stop') {
		shouldStop = true;
		process.exit(0);
	}
});
