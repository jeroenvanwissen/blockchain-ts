// In Miner.ts
import { Block } from './Block';
import { Transaction, TxInput, TxOutput } from './Transaction';
import { Blockchain } from './Blockchain';
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import WebSocket from 'ws';

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
        nonce?: number;
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
    private wsClient: WebSocket | null = null;

    constructor(private blockchain: Blockchain) {
        this.targetBlockTime = blockchain.BLOCK_TIME * 1000;
        this.minerAddress = this.getMinerAddressFromWallet();
        this.connectToNode();
    }

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

    private connectToNode(): void {
        this.wsClient = new WebSocket('ws://localhost:5001');
        
        this.wsClient.on('open', () => {
            console.log('Connected to blockchain node');
            this.startMining(); // Start mining when connected
        });

        this.wsClient.on('error', (error) => {
            console.error('WebSocket error:', error);
        });

        this.wsClient.on('close', () => {
            console.log('Disconnected from blockchain node, attempting to reconnect...');
            this.mining = false; // Stop mining when disconnected
            setTimeout(() => this.connectToNode(), 5000);
        });
    }

    public startMining(minerAddress?: string): void {
        if (this.mining) return;
        
        // Check WebSocket connection first
        if (!this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
            console.log('No connection to blockchain node, skipping mining');
            return;
        }
        
        // First, request the latest block from the node
        this.wsClient.send(JSON.stringify({
            type: 'GET_LATEST_BLOCK'
        }));

        // Add handler for the latest block response
        this.wsClient.once('message', (data) => {
            const response = JSON.parse(data.toString());
            console.log('Received response:', response);
            
            if (response.type === 'LATEST_BLOCK') {
                const lastBlock = response.data;
                console.log('Using previous hash:', lastBlock.hash);
                this.startMiningWithLastBlock(lastBlock, minerAddress);
            } else if (response.type === 'CHAIN') {
                // If we receive the full chain, use the last block
                const chain = response.data;
                if (chain && chain.length > 0) {
                    const lastBlock = chain[chain.length - 1];
                    console.log('Using previous hash from chain:', lastBlock.hash);
                    this.startMiningWithLastBlock(lastBlock, minerAddress);
                } else {
                    console.log('Received empty chain');
                    this.mining = false;
                }
            } else {
                console.log('Unexpected response type:', response.type);
                this.mining = false;
            }
        });
    }

    private startMiningWithLastBlock(lastBlock: any, minerAddress?: string): void {
        // Check if PoW is still allowed
        if (!this.blockchain.canAcceptPowBlock()) {
            console.log('PoW mining no longer accepted after block 100');
            return;
        }

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
        const now = Date.now();
        const coinbaseTransaction = new Transaction(
            [],
            [{ address: addressToUse, amount: 100 }],
            now
        );

        try {
            console.log('Starting mining process with address:', addressToUse);
            const currentDifficulty = this.blockchain.calculateNewDifficulty();
            
            // Ensure we have the hash from the last block
            if (!lastBlock.hash) {
                throw new Error('Invalid last block: missing hash');
            }
            
            console.log('Mining with previous hash:', lastBlock.hash);
            
            this.worker = new Worker(path.join(__dirname, 'miningWorker.cjs'), {
                workerData: {
                    minerAddress: addressToUse,
                    difficulty: currentDifficulty,
                    previousHash: lastBlock.hash, // Use the hash from the latest block
                    pendingTransactions: [coinbaseTransaction, ...this.blockchain.getPendingTransactions()],
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
    
                        // Create transactions with exact data from mined block
                        const transactions = minedBlock.transactions.map(tx => {
                            // Create a new Transaction instance with the exact data
                            const transaction = new Transaction(
                                tx.inputs,
                                tx.outputs,
                                tx.timestamp,
                                tx.nonce // Pass the original timestamp
                            );

                            // Ensure the transaction properties match exactly
                            transaction.timestamp = tx.timestamp;
                            if (tx.nonce !== undefined) {
                                transaction.nonce = tx.nonce;
                            }

                            // Make it immutable after setting all properties
                            Object.freeze(transaction);
                            
                            return transaction;
                        });

                        console.log('Reconstructed transactions:', JSON.stringify(transactions, null, 2));
                        console.log('block transactions:', transactions);

                        const block = new Block(
                            Number(minedBlock.timestamp),
                            transactions,
                            String(minedBlock.previousHash),
                            Number(minedBlock.nonce),
                            Number(minedBlock.difficulty),
                            this.blockchain.getChain().length
                        );
    
                        // Set hash manually to avoid recalculation
                        block.hash = minedBlock.hash;

                        console.log('block tx.Nonce:', block.transactions[0].nonce);
                        console.log('block tx.Timestamp:', block.transactions[0].timestamp);
    
                        // Instead of adding to blockchain directly, send through WebSocket
                        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
                            this.wsClient.send(JSON.stringify({
                                type: 'BLOCK',
                                data: block
                            }));
                            console.log('Block sent to blockchain node');
                        } else {
                            console.error('WebSocket not connected, cannot send block');
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
    private scheduleMining(): void {
        if (this.miningTimeout) {
            clearTimeout(this.miningTimeout);
        }
        
        // Only schedule next mining if we have a connection
        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            this.miningTimeout = setTimeout(() => {
                this.startMining();
            }, this.targetBlockTime);
        }
    }

    public stopMining(): void {
        this.mining = false;
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        if (this.miningTimeout) {
            clearTimeout(this.miningTimeout);
            this.miningTimeout = null;
        }
        if (this.wsClient) {
            this.wsClient.close();
            this.wsClient = null;
        }
    }
}
