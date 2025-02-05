// In Miner.ts
import { Block } from './Block';
import { Transaction, TxInput, TxOutput } from './Transaction';
import { Blockchain } from './Blockchain';
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface WalletData {
	address: string;
	privateKey: string;
	publicKey: string;
}

interface MinedBlock {
	timestamp: number;
	transactions: {
		inputs: TxInput[];
		outputs: TxOutput[];
		timestamp?: number;
	}[];
	previousHash: string;
	nonce: number;
	difficulty: number;
	hash: string;
}

interface MinedBlockMessage {
	type: 'block';
	data: MinedBlock;
}

interface ProgressMessage {
	type: 'progress';
	progress: number;
}

interface ErrorMessage {
	type: 'error';
	error: string;
}

type WorkerMessage = MinedBlockMessage | ProgressMessage | ErrorMessage;

export class Miner {
    private worker: Worker | null = null;
    private mining = false;
    private targetBlockTime: number;
    private difficulty = 4;
    private miningTimeout: NodeJS.Timeout | null = null;
    private minerAddress: string;

    constructor(private blockchain: Blockchain) {
        this.targetBlockTime = blockchain.BLOCK_TIME * 1000;
        this.minerAddress = this.getMinerAddressFromWallet();
    }

    // Remove setSocket method and socket-related code
    
    private getMinerAddressFromWallet(): string {
        try {
            const walletData = fs.readFileSync('data/wallet.json', 'utf-8');
            const wallet = JSON.parse(walletData) as WalletData;
            return wallet.address;
        } catch (error) {
            console.error('Error reading wallet.json:', error);
            throw new Error('Failed to read miner address from wallet.json');
        }
    }

    private scheduleMining(): void {
        if (this.miningTimeout) {
            clearTimeout(this.miningTimeout);
        }
        
        // Schedule next mining attempt after target block time
        this.miningTimeout = setTimeout(() => {
            this.startMining();
        }, this.targetBlockTime);
    }

    public startMining(minerAddress?: string): void {
        if (this.mining) return;
        
        // Check if PoW is still allowed
        if (!this.blockchain.canAcceptPowBlock()) {
            console.log('PoW mining no longer accepted after block 100');
            return;
        }
    
        const lastBlock = this.blockchain.getLatestBlock();
        const timeSinceLastBlock = Date.now() - lastBlock.timestamp;
        
        // Check if enough time has passed since the last block
        if (timeSinceLastBlock < this.targetBlockTime) {
            const delay = this.targetBlockTime - timeSinceLastBlock;
            console.log(`Waiting ${delay}ms before mining next block...`);
            setTimeout(() => this.startMining(minerAddress), delay);
            return;
        }
    
        this.mining = true;
        const addressToUse = minerAddress || this.minerAddress;

        // Create coinbase transaction with 100 coin reward
        const coinbaseTransaction = new Transaction(
            [], // No inputs for coinbase transaction
            [{ address: addressToUse, amount: 100 }] // 100 coin mining reward
        );
    
        try {
            console.log('Starting mining process with address:', addressToUse);
            // Create worker for mining
            this.worker = new Worker(path.join(__dirname, 'miningWorker.cjs'), {
                workerData: {
                    minerAddress: addressToUse,
                    difficulty: this.blockchain.calculateNewDifficulty(),
                    previousHash: this.blockchain.getLatestBlock().hash,
                    pendingTransactions: [coinbaseTransaction, ...this.blockchain.getPendingTransactions()], // Add coinbase first
                    minTimestamp: lastBlock.timestamp + this.targetBlockTime,
                },
            });
    
            // Handle worker messages
            this.worker.on('message', (message: WorkerMessage) => {
                try {
                    if (message.type === 'progress') {
                        console.log('Mining progress:', message);
                        return;
                    }
    
                    if (message.type === 'block') {
                        const minedBlock = message.data;
                        console.log('Block mined:', minedBlock);
    
                        const block = new Block(
                            Number(minedBlock.timestamp),
                            minedBlock.transactions.map(
                                (tx) => new Transaction(tx.inputs, tx.outputs, tx.timestamp)
                            ),
                            String(minedBlock.previousHash),
                            Number(minedBlock.nonce),
                            Number(minedBlock.difficulty),
                            this.blockchain.getChain().length
                        );
    
                        // Set hash manually to avoid recalculation
                        block.hash = minedBlock.hash;
    
                        this.blockchain.addMinedBlock(block);
    
                        if (this.socket) {
                            this.socket.send(
                                JSON.stringify({
                                    type: 'BLOCK',
                                    data: block,
                                })
                            );
                        }
    
                        this.mining = false;
                        this.scheduleMining();
                    }
    
                    if (message.type === 'error') {
                        throw new Error(message.error);
                    }
                } catch (error) {
                    console.error('Error processing mined block:', error);
                    this.mining = false;
                }
            });
    
            this.worker.on('error', (error) => {
                console.error('Mining worker error:', error);
                this.mining = false;
            });
        } catch (error) {
            console.error('Mining error:', error);
            this.mining = false;
        }
    }

    public stopMining(): void {
        this.mining = false;
        if (this.worker) {
            void this.worker.terminate();
            this.worker = null;
        }
        if (this.miningTimeout) {
            clearTimeout(this.miningTimeout);
            this.miningTimeout = null;
        }
    }

    private adjustDifficulty(lastBlockTime: number): void {
        const timeElapsed = Date.now() - lastBlockTime;
        if (timeElapsed < this.targetBlockTime / 2) {
            this.difficulty++;
        } else if (timeElapsed > this.targetBlockTime * 2) {
            this.difficulty = Math.max(1, this.difficulty - 1);
        }
    }
}
