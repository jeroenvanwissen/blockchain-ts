import { Blockchain } from './blockchain/Blockchain';
import { Miner } from './blockchain/Miner';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { DATA_DIR } from './config';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// Remove blockchain instance as it's not needed in the miner process
// const blockchain = new Blockchain();

// Create miner instance with empty blockchain (it won't be used)
const miner = new Miner(new Blockchain());

// Start mining
console.log('Starting mining operations...');
miner.startMining();

// Handle process termination
process.on('SIGINT', () => {
    console.log('\nStopping mining...');
    miner.stopMining();
    process.exit(0);
});

// Export only miner for testing
export { miner };
