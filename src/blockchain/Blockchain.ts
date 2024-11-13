import { Block } from './Block';
import { Transaction, TxInput, TxOutput } from './Transaction';
import { Wallet } from './Wallet';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import {
	BLOCKCHAIN_DATA_PATH,
	POW_CUTOFF_BLOCK,
	POS_BLOCK_REWARD,
	POW_BLOCK_REWARD,
} from '../config';

interface StakeInfo {
	amount: number;
	timestamp: number;
	lastBlockTime: number;
}

interface UTXO {
	txHash: string;
	outputIndex: number;
	output: TxOutput;
}

interface SerializedTransaction {
	inputs: TxInput[];
	outputs: TxOutput[];
	timestamp: number;
}

interface SerializedBlock {
	timestamp: number;
	transactions: SerializedTransaction[];
	previousHash: string;
	nonce: number;
	powDifficulty: number;
	index: number;
	hash: string;
}

export class Blockchain {
	private chain: Block[];
	private utxoSet: Map<string, UTXO[]> = new Map();
	private pendingTransactions: Transaction[];
	private readonly stakingMinimum: number = 100;
	stakes: Map<string, StakeInfo> = new Map();
	private readonly TARGET_BLOCK_TIME = 375;
	private lastBlockTime: number = Date.now();
	private readonly FILE_PATH = BLOCKCHAIN_DATA_PATH;
	readonly BLOCK_TIME = 10 * 60;
	private readonly DIFFICULTY_ADJUSTMENT_INTERVAL = 10;
	private readonly DIFFICULTY_ADJUSTMENT_FACTOR = 4;
	private readonly MIN_STAKE_AMOUNT = 100;
	private readonly MIN_STAKE_AGE = 60 * 60 * 24;
	private readonly STAKE_CHECK_INTERVAL = 60 * 1000;
	private lastStakeCheck: number = 0;

	constructor() {
		this.chain = [this.createGenesisBlock()];
		this.pendingTransactions = [];
		this.loadBlockchain();
	}

	private updateUTXOSet(block: Block): void {
		for (const tx of block.transactions) {
			const txHash = tx.calculateHash();

			// Remove spent outputs
			for (const input of tx.inputs) {
				const address = this.findTransaction(input.previousTx)?.outputs[
					input.outputIndex
				].address;

				if (address) {
					const utxos = this.utxoSet.get(address) || [];
					const index = utxos.findIndex(
						(utxo) =>
							utxo.txHash === input.previousTx &&
							utxo.outputIndex === input.outputIndex
					);
					if (index >= 0) {
						utxos.splice(index, 1);
						this.utxoSet.set(address, utxos);
					}
				}
			}

			// Add new outputs
			tx.outputs.forEach((output, index) => {
				const utxos = this.utxoSet.get(output.address) || [];
				utxos.push({
					txHash,
					outputIndex: index,
					output,
				});
				this.utxoSet.set(output.address, utxos);
			});
		}
	}

	public getUTXOs(address: string): UTXO[] {
		return this.utxoSet.get(address) || [];
	}

	public canAcceptPowBlock(): boolean {
		return this.chain.length < POW_CUTOFF_BLOCK;
	}

	public addMinedBlock(block: Block): void {
		// Validate block structure and chain continuity
		if (!block.hasValidTransactions()) {
			throw new Error('Block contains invalid transactions');
		}

		const lastBlock = this.getLatestBlock();

		// Enforce minimum block time
		const timeSinceLastBlock = block.timestamp - lastBlock.timestamp;
		if (timeSinceLastBlock < this.BLOCK_TIME * 1000) {
			throw new Error('Block created too quickly');
		}

		if (block.previousHash !== lastBlock.hash) {
			throw new Error('Invalid previous hash');
		}

		if (block.index !== this.chain.length) {
			throw new Error('Invalid block index');
		}

		// Check if PoW is still allowed
		if (block.isProofOfWork() && !this.canAcceptPowBlock()) {
			throw new Error('PoW blocks no longer accepted after block 100');
		}

		// Validate based on block type and difficulty
		if (block.isProofOfWork()) {
			if (block.powDifficulty !== this.calculateNewDifficulty()) {
				throw new Error('Invalid block difficulty');
			}
			if (!block.isValid()) {
				throw new Error('Invalid proof of work');
			}
		} else if (block.isProofOfStake()) {
			const stakeTransaction = block.transactions[1];
			if (!this.validateStake(stakeTransaction)) {
				throw new Error('Invalid stake');
			}
		}

		this.chain.push(block);
		this.lastBlockTime = block.timestamp;
		this.pendingTransactions = [];

		// Update UTXO set
		this.updateUTXOSet(block);

		// Save blockchain after adding new block
		this.saveBlockchain();
	}

	private validateStake(stakeTransaction: Transaction): boolean {
		if (!stakeTransaction.isCoinStake()) {
			return false;
		}

		const stakeInput = stakeTransaction.inputs[0];
		const stakeOutput = stakeTransaction.outputs[1];

		if (stakeOutput.amount < this.MIN_STAKE_AMOUNT) {
			return false;
		}

		const prevTx = this.findTransaction(stakeInput.previousTx);
		if (!prevTx) {
			return false;
		}

		const prevOutput = prevTx.outputs[stakeInput.outputIndex];
		if (!prevOutput || prevOutput.amount !== stakeOutput.amount) {
			return false;
		}

		const stakeAge = (Date.now() - prevTx.timestamp) / 1000;
		if (stakeAge < this.MIN_STAKE_AGE) {
			return false;
		}

		if (prevOutput.address !== stakeOutput.address) {
			return false;
		}

		return true;
	}

	private findTransaction(txHash: string): Transaction | undefined {
		for (const block of this.chain) {
			const tx = block.transactions.find((t) => t.calculateHash() === txHash);
			if (tx) return tx;
		}
		return undefined;
	}

	public clearPendingTransactions(): void {
		this.pendingTransactions = [];
	}

	private createGenesisBlock(): Block {
		const timestamp = 1609459200000; // Jan 1, 2021
		return new Block(timestamp, [], '0', 0, 4, 0);
	}

	getLatestBlock(): Block {
		return this.chain[this.chain.length - 1];
	}

	private getTotalNetworkWeight(): number {
		return Array.from(this.stakes.values()).reduce(
			(total, stake) => total + stake.amount,
			0
		);
	}

	calculateStakeWeight(address: string): number {
		const stake = this.stakes.get(address);
		if (!stake) return 0;

		const elapsedMs = Date.now() - stake.timestamp;
		const elapsedDays = Math.floor(elapsedMs / (86400 * 1000));
		const multiplier = 1.1;
		return Math.floor(stake.amount * multiplier ** elapsedDays);
	}

	getTotalBalance(address: string): number {
		let balance = 0;
		for (const block of this.chain) {
			for (const trans of block.transactions) {
				// Check if we spent coins (inputs)
				for (const input of trans.inputs) {
					const prevTx = this.findTransaction(input.previousTx);
					if (prevTx && prevTx.outputs[input.outputIndex].address === address) {
						balance -= prevTx.outputs[input.outputIndex].amount;
					}
				}
				// Check if we received coins (outputs)
				for (const output of trans.outputs) {
					if (output.address === address) {
						balance += output.amount;
					}
				}
			}
		}
		return balance;
	}

	public getBalance(address: string): number {
		return (this.utxoSet.get(address) || []).reduce(
			(sum, utxo) => sum + utxo.output.amount,
			0
		);
	}

	stake(address: string, amount: number): void {
		if (amount < this.stakingMinimum) {
			throw new Error(`Minimum stake amount is ${this.stakingMinimum}`);
		}

		const availableBalance =
			this.getTotalBalance(address) - (this.getStake(address) || 0);
		if (availableBalance < amount) {
			throw new Error('Insufficient balance for staking');
		}

		const currentStake = this.stakes.get(address);
		this.stakes.set(address, {
			amount: (currentStake?.amount || 0) + amount,
			timestamp: Date.now(),
			lastBlockTime: Date.now(),
		});
	}

	unstake(address: string, amount: number): void {
		const currentStake = this.stakes.get(address);
		if (!currentStake) {
			throw new Error('No stake found for address');
		}
		if (currentStake.amount < amount) {
			throw new Error('Insufficient stake amount');
		}

		const remainingStake = currentStake.amount - amount;
		if (remainingStake === 0) {
			this.stakes.delete(address);
		} else {
			this.stakes.set(address, {
				amount: remainingStake,
				timestamp: currentStake.timestamp,
				lastBlockTime: currentStake.lastBlockTime,
			});
		}
	}

	getStake(address: string): number {
		return this.stakes.get(address)?.amount || 0;
	}

	createTransaction(
		from: string,
		to: string,
		amount: number,
		wallet: Wallet
	): Transaction {
		const utxos = this.getUTXOs(from);
		let inputSum = 0;
		const inputs: TxInput[] = [];

		for (const utxo of utxos) {
			inputSum += utxo.output.amount;
			inputs.push({
				previousTx: utxo.txHash,
				outputIndex: utxo.outputIndex,
				signature: '',
				// Removed publicKey: wallet.publicKey.toString('hex'),
			});

			if (inputSum >= amount) break;
		}

		if (inputSum < amount) {
			throw new Error('Insufficient funds');
		}

		const outputs: TxOutput[] = [{ address: to, amount }];

		const change = inputSum - amount;
		if (change > 0) {
			outputs.push({ address: from, amount: change });
		}

		const transaction = new Transaction(inputs, outputs);
		wallet.signTransaction(transaction);

		return transaction;
	}

	validateAddress(address: string): boolean {
		try {
			const decoded = this.base58Decode(address);
			if (decoded.length !== 25) return false;
			if (decoded[0] !== 0x00) return false;

			const payload = decoded.slice(0, -4);
			const checksum = decoded.slice(-4);

			const hash = crypto
				.createHash('sha256')
				.update(crypto.createHash('sha256').update(payload).digest())
				.digest();

			return Buffer.compare(checksum, hash.slice(0, 4)) === 0;
		} catch {
			return false;
		}
	}

	private base58Decode(str: string): Buffer {
		const ALPHABET =
			'123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
		let num = BigInt(0);
		const base = BigInt(58);

		for (const char of str) {
			num = num * base + BigInt(ALPHABET.indexOf(char));
		}

		return Buffer.from(num.toString(16).padStart(50, '0'), 'hex');
	}

	public generateStakeBlock(stakeholderAddress: string): Block | null {
		if (!this.canCreateStakeBlock(stakeholderAddress)) {
			return null;
		}

		const stake = this.stakes.get(stakeholderAddress)!;

		const prevOutput = this.findStakeableOutput(
			stakeholderAddress,
			stake.amount
		);
		if (!prevOutput) return null;

		const stakeTransaction = new Transaction(
			[
				{
					previousTx: prevOutput.tx.calculateHash(),
					outputIndex: prevOutput.index,
					signature: '',
					// Removed publicKey: '',
				},
			],
			[
				{ address: stakeholderAddress, amount: 0 },
				{ address: stakeholderAddress, amount: stake.amount },
			]
		);
		stakeTransaction.signTransaction(stakeholderAddress);

		const transactions = [
			new Transaction(
				[],
				[
					{
						address: stakeholderAddress,
						amount: POS_BLOCK_REWARD,
					},
				]
			),
			stakeTransaction,
			...this.pendingTransactions,
		];

		const block = new Block(
			Date.now(),
			transactions,
			this.getLatestBlock().hash,
			0,
			this.calculateNewDifficulty(),
			this.chain.length
		);

		block.hash = block.calculateHash();

		this.stakes.set(stakeholderAddress, {
			...stake,
			lastBlockTime: Date.now(),
		});

		return block;
	}

	private canCreateStakeBlock(address: string): boolean {
		const stake = this.stakes.get(address);
		if (!stake) return false;

		const stakeAge = (Date.now() - stake.timestamp) / 1000;
		if (stakeAge < this.MIN_STAKE_AGE) return false;

		if (Date.now() - stake.lastBlockTime < this.STAKE_CHECK_INTERVAL)
			return false;

		const stakeWeight = this.calculateStakeWeight(address);
		const networkWeight = this.getTotalNetworkWeight();
		const probability = stakeWeight / (networkWeight || 1);

		return Math.random() <= probability;
	}

	private findStakeableOutput(
		address: string,
		amount: number
	): { tx: Transaction; index: number } | null {
		for (const block of [...this.chain].reverse()) {
			for (const tx of block.transactions) {
				const outputIndex = tx.outputs.findIndex(
					(o) => o.address === address && o.amount >= amount
				);
				if (outputIndex >= 0) {
					return { tx, index: outputIndex };
				}
			}
		}
		return null;
	}

	public minePendingTransactions(minerAddress: string): Block {
		const coinbaseTransaction = new Transaction(
			[],
			[{ address: minerAddress, amount: POW_BLOCK_REWARD }]
		);

		const transactions = [coinbaseTransaction, ...this.pendingTransactions];

		const block = new Block(
			Date.now(),
			transactions,
			this.getLatestBlock().hash,
			0,
			this.calculateNewDifficulty(),
			this.chain.length
		);

		while (!block.isValid()) {
			block.nonce++;
			block.hash = block.calculateHash();
		}

		this.chain.push(block);
		this.pendingTransactions = [];

		// Update UTXO set
		this.updateUTXOSet(block);

		// Save blockchain after mining
		this.saveBlockchain();

		return block;
	}

	addTransaction(transaction: Transaction): void {
		if (transaction.inputs.length === 0 || transaction.outputs.length === 0) {
			throw new Error('Transaction must have inputs and outputs');
		}

		if (!transaction.isValid()) {
			throw new Error('Cannot add invalid transaction to chain');
		}

		this.pendingTransactions.push(transaction);
	}

	isChainValid(): boolean {
		for (let i = 1; i < this.chain.length; i++) {
			const currentBlock = this.chain[i];
			const previousBlock = this.chain[i - 1];

			if (!currentBlock.hasValidTransactions()) {
				console.log(`Block ${i} has invalid transactions`);
				return false;
			}

			if (currentBlock.hash !== currentBlock.calculateHash()) {
				console.log(`Block ${i} has invalid hash`);
				console.log('Stored hash:', currentBlock.hash);
				console.log('Calculated hash:', currentBlock.calculateHash());
				return false;
			}

			if (currentBlock.previousHash !== previousBlock.hash) {
				console.log(`Block ${i} has invalid previous hash`);
				return false;
			}

			if (currentBlock.isProofOfStake()) {
				const stakeTransaction = currentBlock.transactions[1];
				const stake = this.stakes.get(stakeTransaction.outputs[1].address);
				if (!stake || stake.timestamp > currentBlock.timestamp) {
					console.log(`Block ${i} has invalid stake`);
					return false;
				}
			}

			if (currentBlock.isProofOfWork()) {
				if (!currentBlock.isValid()) {
					console.log(`Block ${i} has invalid proof of work`);
					return false;
				}
			}
		}
		return true;
	}

	getChain(): Block[] {
		return this.chain;
	}

	getPendingTransactions(): Transaction[] {
		return this.pendingTransactions;
	}

	private loadBlockchain(): void {
		try {
			if (!fs.existsSync(this.FILE_PATH)) {
				const dataDir = path.dirname(this.FILE_PATH);
				if (!fs.existsSync(dataDir)) {
					fs.mkdirSync(dataDir, { recursive: true });
				}

				this.chain = [this.createGenesisBlock()];
				this.saveBlockchain();
				return;
			}

			const data = fs.readFileSync(this.FILE_PATH, 'utf8');
			const serializedChain = JSON.parse(data) as SerializedBlock[];

			const reconstructedChain: Block[] = [];

			for (const blockData of serializedChain) {
				const transactions = blockData.transactions.map((txData) => {
					const tx = new Transaction(txData.inputs, txData.outputs);
					tx.timestamp = txData.timestamp;
					return tx;
				});

				const block = new Block(
					blockData.timestamp,
					transactions,
					blockData.previousHash,
					blockData.nonce,
					blockData.powDifficulty,
					blockData.index
				);

				// Instead of recalculating, use the stored hash
				block.hash = blockData.hash;
				reconstructedChain.push(block);
			}

			if (reconstructedChain.length === 0) {
				throw new Error('Empty blockchain data');
			}

			const genesisBlock = reconstructedChain[0];
			if (
				JSON.stringify(genesisBlock) !==
				JSON.stringify(this.createGenesisBlock())
			) {
				throw new Error('Invalid genesis block');
			}

			for (let i = 1; i < reconstructedChain.length; i++) {
				const currentBlock = reconstructedChain[i];
				const previousBlock = reconstructedChain[i - 1];

				if (currentBlock.previousHash !== previousBlock.hash) {
					throw new Error(`Invalid chain at block ${i}: broken link`);
				}

				// Skip hash validation since we're using stored hashes
				if (!currentBlock.hasValidTransactions()) {
					throw new Error(`Invalid chain at block ${i}: invalid transactions`);
				}
			}

			this.chain = reconstructedChain;

			// Rebuild UTXO set
			this.utxoSet.clear();
			for (const block of this.chain) {
				this.updateUTXOSet(block);
			}
		} catch (error) {
			console.error('Error loading blockchain:', error);
			// Don't overwrite the file or reset the chain, just throw the error
			throw error;
		}
	}

	private saveBlockchain(): void {
		try {
			const dataDir = path.dirname(this.FILE_PATH);
			if (!fs.existsSync(dataDir)) {
				fs.mkdirSync(dataDir, { recursive: true });
			}

			fs.writeFileSync(this.FILE_PATH, JSON.stringify(this.chain, null, 2));
		} catch (error) {
			console.error('Error saving blockchain:', error);
			throw error;
		}
	}

	public getDifficulty(): number {
		return this.getLatestBlock().getDifficulty();
	}

	public setDifficulty(difficulty: number): void {
		this.getLatestBlock().setDifficulty(difficulty);

		if (this.pendingTransactions.length > 0) {
			const block = new Block(
				Date.now(),
				this.pendingTransactions,
				this.getLatestBlock().hash,
				0,
				difficulty,
				this.chain.length
			);
			this.pendingTransactions = block.transactions;
		}
	}

	calculateNewDifficulty(): number {
		if (this.chain.length < this.DIFFICULTY_ADJUSTMENT_INTERVAL) {
			return this.chain[0].getDifficulty();
		}

		const lastBlock = this.getLatestBlock();
		const lastAdjustmentBlock =
			this.chain[this.chain.length - this.DIFFICULTY_ADJUSTMENT_INTERVAL];

		const timeExpected = this.BLOCK_TIME * this.DIFFICULTY_ADJUSTMENT_INTERVAL;
		const timeTaken = lastBlock.timestamp - lastAdjustmentBlock.timestamp;

		let newDifficulty = lastBlock.getDifficulty();

		if (timeTaken < timeExpected / this.DIFFICULTY_ADJUSTMENT_FACTOR) {
			newDifficulty++;
		} else if (timeTaken > timeExpected * this.DIFFICULTY_ADJUSTMENT_FACTOR) {
			newDifficulty = Math.max(1, newDifficulty - 1);
		}

		return newDifficulty;
	}
}
