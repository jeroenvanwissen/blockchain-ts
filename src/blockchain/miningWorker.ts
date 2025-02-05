import { parentPort, workerData } from 'worker_threads';
import { createHash } from 'crypto';

// Receive data from main thread
const { minerAddress, difficulty, previousHash, pendingTransactions } = workerData;

function calculateHash(timestamp: number, transactions: any[], previousHash: string, nonce: number): string {
    const data = JSON.stringify({ timestamp, transactions, previousHash, nonce });
    return createHash('sha256').update(data).digest('hex');
}

function mineBlock(): void {
    const timestamp = Date.now();
    let nonce = 0;
    const target = '0'.repeat(difficulty);

    while (true) {
        const hash = calculateHash(timestamp, pendingTransactions, previousHash, nonce);
        
        if (hash.startsWith(target)) {
            if (parentPort) {
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
            }
            break;
        }
        
        nonce++;
        
        if (nonce % 100000 === 0 && parentPort) {
            parentPort.postMessage({
                type: 'progress',
                progress: nonce
            });
        }
    }
}

try {
    mineBlock();
} catch (error) {
    if (parentPort) {
        parentPort.postMessage({
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error occurred'
        });
    }
}