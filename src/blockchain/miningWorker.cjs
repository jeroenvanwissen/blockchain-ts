// Worker thread for proof-of-work hashing (CommonJS: loaded by worker_threads).
// Hashes `prefix + nonce + '}'` exactly like Block.hashWithNonce, so a found nonce
// produces the hash that validation recomputes.
const { parentPort, workerData } = require('worker_threads');
const { createHash } = require('crypto');

function search({ prefix, difficulty, startNonce, maxNonce }) {
	const target = '0'.repeat(difficulty);
	for (let nonce = startNonce; nonce <= maxNonce; nonce++) {
		const hash = createHash('sha256').update(`${prefix}${nonce}}`).digest('hex');
		if (hash.startsWith(target)) {
			return { type: 'found', nonce, hash };
		}
	}
	return { type: 'exhausted' };
}

parentPort.postMessage(search(workerData));
