const { parentPort, workerData } = require('worker_threads');
const { createHash } = require('crypto');

const { minerAddress, difficulty, previousHash, pendingTransactions, minTimestamp } = workerData;

function calculateHash(timestamp, transactions, previousHash, nonce) {
    // Create a simple stringified version without any sorting
    const data = JSON.stringify({
        timestamp,
        transactions,
        previousHash,
        nonce
    });
    return createHash('sha256').update(data).digest('hex');
}

function mineBlock() {
    const timestamp = Math.max(Date.now(), minTimestamp);
    let nonce = 0;
    const target = '0'.repeat(difficulty);

    while (true) {
        const hash = calculateHash(timestamp, pendingTransactions, previousHash, nonce);
        
        if (nonce % 100000 === 0) {
            parentPort.postMessage({
                type: 'progress',
                progress: nonce,
                currentHash: hash,
                target,
                difficulty
            });
            
            if (global.gc) {
                global.gc();
            }
        }
        
        // Use simple prefix check
        if (hash.substring(0, difficulty) === target) {
            parentPort.postMessage({
                type: 'block',
                data: {
                    timestamp,
                    transactions: pendingTransactions,
                    previousHash,
                    nonce,
                    difficulty,
                    hash
                }
            });
            break;
        }
        
        nonce++;
    }
}

try {
    mineBlock();
} catch (error) {
    parentPort.postMessage({
        type: 'error',
        error: error.message || 'Unknown error occurred'
    });
}