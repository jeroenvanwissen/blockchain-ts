// In Miner.ts
import { Block } from './Block';
import { Transaction, TxInput, TxOutput } from './Transaction';
import { Blockchain } from './Blockchain';
import { Worker } from 'worker_threads';
import * as path from 'path';
import WebSocket from 'ws';
import * as fs from 'fs';

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
	private targetBlockTime: number; // Target 30 seconds per block
	private difficulty = 4;
	private socket: WebSocket | null = null;
	private miningTimeout: NodeJS.Timeout | null = null;
	private minerAddress: string;

	constructor(private blockchain: Blockchain) {
		this.targetBlockTime = blockchain.BLOCK_TIME * 1000; // Convert to milliseconds
		this.minerAddress = this.getMinerAddressFromWallet();
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

	public setSocket(socket: WebSocket): void {
		this.socket = socket;
	}

	private scheduleMining(): void {
		if (this.miningTimeout) {
			clearTimeout(this.miningTimeout);
		}

		// Calculate delay based on last block time
		const lastBlock = this.blockchain.getLatestBlock();
		const timeSinceLastBlock = Date.now() - lastBlock.timestamp;
		const delay = Math.max(0, this.targetBlockTime - timeSinceLastBlock);

		this.miningTimeout = setTimeout(() => {
			this.startMining();
		}, delay);
	}

	public startMining(minerAddress?: string): void {
		if (this.mining) return;

		// Check if PoW is still allowed
		if (!this.blockchain.canAcceptPowBlock()) {
			console.log('PoW mining no longer accepted after block 100');
			return;
		}

		this.mining = true;
		const addressToUse = minerAddress || this.minerAddress;

		try {
			console.log('Starting mining process with address:', addressToUse);
			// Create worker for mining
			this.worker = new Worker(path.join(__dirname, 'miningWorker.js'), {
				workerData: {
					minerAddress: addressToUse,
					difficulty: this.blockchain.calculateNewDifficulty(),
					previousHash: this.blockchain.getLatestBlock().hash,
					pendingTransactions: this.blockchain.getPendingTransactions(),
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
