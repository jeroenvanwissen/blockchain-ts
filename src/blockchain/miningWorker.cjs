// Worker thread for proof-of-work hashing (CommonJS: loaded by worker_threads).
// Hashes sha256d(prefix ‖ nonce u32 LE) exactly like Block.hashHeader and compares the hex
// digest with the target (both 64 lowercase hex chars, so string order is numeric order).
const { parentPort, workerData } = require('worker_threads');
const { createHash } = require('crypto');

function search({ prefix, targetHex, startNonce, maxNonce }) {
	const header = Buffer.alloc(prefix.length + 4);
	Buffer.from(prefix).copy(header);
	for (let nonce = startNonce; nonce <= maxNonce; nonce++) {
		header.writeUInt32LE(nonce, prefix.length);
		const first = createHash('sha256').update(header).digest();
		const hash = createHash('sha256').update(first).digest('hex');
		if (hash <= targetHex) {
			return { type: 'found', nonce, hash };
		}
	}
	return { type: 'exhausted' };
}

parentPort.postMessage(search(workerData));
