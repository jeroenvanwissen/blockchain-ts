import { Block } from './Block.js';
import { Transaction, type TxInput, type TxOutput } from './Transaction.js';
import { Wallet } from './Wallet.js';
import { BlockStore } from './BlockStore.js';
import * as crypto from 'crypto';
import {
	BLOCKS_DIR,
	POW_CUTOFF_BLOCK,
	POS_BLOCK_REWARD,
	POW_BLOCK_REWARD,
	COIN_MATURITY,
	BLOCK_TIME,
	DIFFICULTY_ADJUSTMENT_INTERVAL,
	MIN_DIFFICULTY,
	MAX_DIFFICULTY_CHANGE_FACTOR,
	MEDIAN_TIME_SPAN,
	MAX_BLOCK_TRANSACTIONS,
	MAX_FUTURE_BLOCK_TIME,
	UNSTAKE_DELAY,
	MAX_STAKE_AGE_MULTIPLIER,
} from '../config.js';

export interface StakeInfo {
	amount: number;
	timestamp: number;
	lastBlockTime: number;
}

export interface PendingUnstake {
	address: string;
	amount: number;
	requestHeight: number;
}

interface UTXO {
	txHash: string;
	outputIndex: number;
	output: TxOutput;
	blockIndex: number;
	isCoinbase: boolean;
}

import { Mutex } from 'async-mutex';

export interface BlockchainOptions {
	minStakeAge?: number;
	minBlockInterval?: number;
	validateDifficulty?: boolean;
	validateTimestamps?: boolean;
	stakeCheckInterval?: number;
	allowPowAfterCutoff?: boolean;
}

export class Blockchain {
	private _lock: Mutex = new Mutex();

	private static readonly MAX_HASH = BigInt('0x' + 'f'.repeat(64));

	private chain: Block[];
	private utxoSet: Map<string, UTXO[]> = new Map();
	private _pendingUTXOSpends: Set<string> = new Set();
	private pendingTransactions: Transaction[];
	private _stakes: Map<string, StakeInfo> = new Map();
	private _pendingUnstakes: PendingUnstake[] = [];
	private _blockSignatures: Map<number, Map<string, string>> = new Map();
	private lastBlockTime: number = Date.now();
	private blockStore: BlockStore;
	readonly BLOCK_TIME = BLOCK_TIME;
	private readonly MIN_STAKE_AMOUNT = 100;
	private readonly SLOT_DURATION = 60 * 1000;
	private readonly _options: Required<BlockchainOptions>;

	constructor(options?: BlockchainOptions) {
		this._options = {
			minStakeAge: 86400,
			minBlockInterval: BLOCK_TIME * 1000,
			validateDifficulty: true,
			validateTimestamps: true,
			stakeCheckInterval: 60 * 1000,
			allowPowAfterCutoff: false,
			...options,
		};
		this.blockStore = new BlockStore(BLOCKS_DIR);
		const genesisBlock = this.createGenesisBlock();
		genesisBlock.cumulativeWeight = Blockchain.blockWeight(genesisBlock);
		this.chain = [genesisBlock];
		this.pendingTransactions = [];

		// Initialize UTXO set with genesis block
		this.updateUTXOSet(genesisBlock);

		// Load the rest of the blockchain
		this.loadBlockchain();
	}

	static blockWeight(block: Block): number {
		if (block.isProofOfStake()) {
			// PoS: use validator's stake amount from coinstake transaction
			return block.transactions[1].outputs[1].amount;
		}
		// PoW: 2^difficulty (exponential, matching Bitcoin)
		return Math.pow(2, block.powDifficulty);
	}

	static computeChainWeights(chain: Block[]): void {
		let cumWeight = 0;
		for (const block of chain) {
			cumWeight += Blockchain.blockWeight(block);
			block.cumulativeWeight = cumWeight;
		}
	}

	getChainWeight(): number {
		return this.getLatestBlock().cumulativeWeight;
	}

	private utxoKey(txHash: string, outputIndex: number): string {
		return `${txHash}:${outputIndex}`;
	}

	private updateUTXOSet(block: Block): void {
		for (const tx of block.transactions) {
			const txHash = tx.calculateHash();
			const isCoinbaseTx = tx.isCoinbase();

			// Remove spent outputs
			for (const input of tx.inputs) {
				const spenderAddress = this.findTransaction(input.previousTx)?.outputs[
					input.outputIndex
				].address;

				if (spenderAddress) {
					const utxos = this.utxoSet.get(spenderAddress) || [];
					this.utxoSet.set(
						spenderAddress,
						utxos.filter(
							(utxo) =>
								utxo.txHash !== input.previousTx ||
								utxo.outputIndex !== input.outputIndex
						)
					);
				}
			}

			// Add new outputs using the stored hash
			tx.outputs.forEach((output: TxOutput, index: number) => {
				const utxos = this.utxoSet.get(output.address) || [];
				utxos.push({
					txHash,
					outputIndex: index,
					output: output,
					blockIndex: block.index,
					isCoinbase: isCoinbaseTx,
				});
				this.utxoSet.set(output.address, utxos);
			});
		}
	}

	private findTransactionBlock(txHash: string): { tx: Transaction; blockIndex: number } | undefined {
		for (const block of this.chain) {
			const tx = block.transactions.find(
				(t: Transaction) => t.calculateHash() === txHash
			);
			if (tx) return { tx, blockIndex: block.index };
		}
		return undefined;
	}

	private findTransaction(txHash: string): Transaction | undefined {
		return this.findTransactionBlock(txHash)?.tx;
	}

	public getUTXOs(address: string): UTXO[] {
		return this.utxoSet.get(address) || [];
	}

	public canAcceptPowBlock(): boolean {
		if (this._options.allowPowAfterCutoff) return true;
		return this.chain.length <= POW_CUTOFF_BLOCK;
	}

	private validateBlockCoinbase(block: Block): void {
		if (block.transactions.length === 0) {
			throw new Error('block must contain at least one transaction');
		}
		const coinbaseTx = block.transactions[0];
		if (!coinbaseTx.isCoinbase()) {
			throw new Error('first transaction must be coinbase');
		}
		for (let i = 1; i < block.transactions.length; i++) {
			if (block.transactions[i].isCoinbase()) {
				throw new Error('block contains multiple coinbase transactions');
			}
		}
		const expectedReward = block.isProofOfStake()
			? POS_BLOCK_REWARD
			: POW_BLOCK_REWARD;
		if (coinbaseTx.outputs[0].amount !== expectedReward) {
			throw new Error('invalid coinbase reward amount');
		}
	}

	private _addMinedBlockInternal(block: Block): void {
		// Validate block structure and chain continuity
		if (!block.hasValidTransactions()) {
			throw new Error('Block contains invalid transactions');
		}

		// Validate coinbase transaction structure and reward
		this.validateBlockCoinbase(block);

		// Block size limit
		if (block.transactions.length > MAX_BLOCK_TRANSACTIONS) {
			throw new Error('block exceeds maximum transaction count');
		}

		const lastBlock = this.getLatestBlock();

		// Enforce minimum block time
		const timeSinceLastBlock = block.timestamp - lastBlock.timestamp;
		if (
			this._options.minBlockInterval > 0 &&
			timeSinceLastBlock < this._options.minBlockInterval
		) {
			throw new Error('Block created too quickly');
		}

		// Validate timestamp against median time past to prevent manipulation
		if (
			this._options.validateTimestamps &&
			block.timestamp <= this.getMedianTimePast()
		) {
			throw new Error(
				'Block timestamp must be greater than median time past',
			);
		}

		// Reject blocks with timestamps too far in the future
		if (
			this._options.validateTimestamps &&
			block.timestamp > Date.now() + MAX_FUTURE_BLOCK_TIME
		) {
			throw new Error('block timestamp too far in the future');
		}

		if (block.previousHash !== lastBlock.hash) {
			throw new Error('Invalid previous hash');
		}

		if (block.index !== this.chain.length) {
			throw new Error(
				`Invalid block index: expected ${this.chain.length}, got ${block.index}`,
			);
		}

		// Check if PoW is still allowed
		if (block.isProofOfWork() && !this.canAcceptPowBlock()) {
			throw new Error('PoW blocks no longer accepted after block 100');
		}

		// Validate based on block type and difficulty
		if (block.isProofOfWork()) {
			if (this._options.validateDifficulty) {
				if (block.powDifficulty !== this.calculateNewDifficulty()) {
					throw new Error('Invalid block difficulty');
				}
			}
			if (!block.isValid()) {
				throw new Error('Invalid proof of work');
			}
		} else if (block.isProofOfStake()) {
			const stakeTransaction = block.transactions[1];
			if (!this.validateStake(stakeTransaction)) {
				throw new Error('Invalid stake');
			}
			// Verify validator was eligible via stake-weighted lottery
			const validatorAddress = stakeTransaction.outputs[1].address;
			const previousBlock = this.getLatestBlock();
			if (!this.isEligibleValidator(
				validatorAddress,
				block.timestamp,
				previousBlock.hash,
				previousBlock.timestamp,
			)) {
				throw new Error('validator not eligible for this slot');
			}
			// Record block signature for double-sign detection
			if (!this._blockSignatures.has(block.index)) {
				this._blockSignatures.set(block.index, new Map());
			}
			this._blockSignatures.get(block.index)!.set(validatorAddress, block.hash);
		}

		// Update stakes map for any staking transactions in this block
		for (const tx of block.transactions) {
			if (tx.inputs.length === 0) continue; // skip coinbase
			if (tx.outputs.length === 0) continue;

			let stakeAddress: string | null = null;
			let stakeAmount: number | null = null;

			// Coinstake detection: marker output (amount 0) followed by stake amount
			if (
				tx.outputs.length >= 2 &&
				tx.outputs[0].amount === 0 &&
				tx.outputs[1].amount >= this.MIN_STAKE_AMOUNT
			) {
				stakeAddress = tx.outputs[1].address;
				stakeAmount = tx.outputs[1].amount;
			}

			if (stakeAddress && stakeAmount) {
				this._stakes.set(stakeAddress, {
					amount: stakeAmount,
					timestamp: block.timestamp,
					lastBlockTime: block.timestamp,
				});
			}
		}

		// Set cumulative weight before adding to chain
		const previousWeight = this.getLatestBlock().cumulativeWeight;
		block.cumulativeWeight = previousWeight + Blockchain.blockWeight(block);

		this.chain.push(block);
		this.lastBlockTime = block.timestamp;
		this.pendingTransactions = [];
		this._pendingUTXOSpends.clear();

		// Update UTXO set
		this.updateUTXOSet(block);

		// Process matured pending unstakes
		this._pendingUnstakes = this._pendingUnstakes.filter(unstake => {
			if (this.chain.length - unstake.requestHeight >= UNSTAKE_DELAY) {
				const stake = this._stakes.get(unstake.address);
				if (stake) {
					const remaining = stake.amount - unstake.amount;
					if (remaining <= 0) {
						this._stakes.delete(unstake.address);
					} else {
						this._stakes.set(unstake.address, {
							...stake,
							amount: remaining,
						});
					}
				}
				return false; // remove from pending list
			}
			return true; // keep in pending list
		});

		// Persist new block
		this.blockStore.appendBlock(block);
	}

	public async addMinedBlock(block: Block): Promise<void> {
		const release = await this._lock.acquire();
		try {
			this._addMinedBlockInternal(block);
		} finally {
			release();
		}
	}

	private validateStake(stakeTransaction: Transaction): boolean {
		if (!stakeTransaction.isCoinStake()) {
			return false;
		}

		const stakeInputs = stakeTransaction.inputs;
		const stakeOutput = stakeTransaction.outputs[1];

		// Check minimum stake amount
		if (stakeOutput.amount < this.MIN_STAKE_AMOUNT) {
			return false;
		}

		// Sum input amounts and validate inputs reference existing UTXOs
		let inputSum = 0;
		for (const input of stakeInputs) {
			const prevTx = this.findTransaction(input.previousTx);
			if (!prevTx) {
				return false;
			}
			const prevOutput = prevTx.outputs[input.outputIndex];
			if (!prevOutput) {
				return false;
			}
			// Verify stake ownership consistency
			if (prevOutput.address !== stakeOutput.address) {
				return false;
			}
			inputSum += prevOutput.amount;

			// Verify the referenced UTXO is currently unspent
			const utxos = this.getUTXOs(prevOutput.address);
			const exists = utxos.some(
				(utxo) =>
					utxo.txHash === input.previousTx &&
					utxo.outputIndex === input.outputIndex
			);
			if (!exists) {
				return false;
			}
		}

		// Inputs must cover the staked amount
		if (inputSum < stakeOutput.amount) {
			return false;
		}

		// Stake age: ensure at least minStakeAge seconds have passed since earliest input tx
		if (this._options.minStakeAge > 0) {
			let earliestInputTime = Number.MAX_SAFE_INTEGER;
			for (const input of stakeInputs) {
				const prevTx = this.findTransaction(input.previousTx)!;
				if (prevTx.timestamp < earliestInputTime)
					earliestInputTime = prevTx.timestamp;
			}
			const stakeAge = (Date.now() - earliestInputTime) / 1000;
			if (stakeAge < this._options.minStakeAge) {
				return false;
			}
		}

		return true;
	}

	private _clearPendingTransactionsInternal(): void {
		this.pendingTransactions = [];
		this._pendingUTXOSpends.clear();
	}

	public async clearPendingTransactions(): Promise<void> {
		const release = await this._lock.acquire();
		try {
			this._clearPendingTransactionsInternal();
		} finally {
			release();
		}
	}

	private createGenesisBlock(): Block {
		const timestamp = 1609459200000; // Jan 1, 2021, 00:00:00 UTC
		const genesisTransaction = new Transaction(
			[],
			[{ address: 'genesis', amount: 0 }],
			timestamp,
			0, // deterministic nonce for reproducible genesis hash
		);
		return new Block(timestamp, [genesisTransaction], '0', 0, 4, 0);
	}

	getLatestBlock(): Block {
		return this.chain[this.chain.length - 1];
	}

	public totalNetworkStake(stakes?: Map<string, StakeInfo>): number {
		const stakeMap = stakes ?? this._stakes;
		let total = 0;
		for (const [address] of stakeMap) {
			total += this.calculateStakeWeight(address, stakeMap);
		}
		return total;
	}

	calculateStakeWeight(address: string, stakes?: Map<string, StakeInfo>): number {
		const stakeMap = stakes ?? this._stakes;
		const stake = stakeMap.get(address);
		if (!stake) return 0;

		// Guard against negative elapsed time from corrupted timestamps
		const elapsedMs = Math.max(0, stake.lastBlockTime - stake.timestamp);
		const elapsedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));

		// Base weight is the stake amount
		let weight = stake.amount;

		// Apply multiplier for each day (10% increase per day), bounded
		if (elapsedDays > 0) {
			const rawMultiplier = Math.pow(1.1, elapsedDays);
			const cappedMultiplier = Math.min(rawMultiplier, MAX_STAKE_AGE_MULTIPLIER);
			weight = Math.floor(weight * cappedMultiplier);
		}

		return weight;
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

	async stake(address: string, amount: number, wallet?: Wallet): Promise<void> {
		const release = await this._lock.acquire();
		try {
			if (!this.validateAddress(address)) {
				throw new Error('invalid staking address');
			}

			if (amount < this.MIN_STAKE_AMOUNT) {
				throw new Error(`Minimum stake amount is ${this.MIN_STAKE_AMOUNT}`);
			}

			const availableBalance = this.getBalance(address);
			if (availableBalance < amount) {
				throw new Error('Insufficient balance for staking');
			}

			if (wallet) {
				// Create a staking transaction in coinstake format (zero marker + amount)
				const utxos = this.getUTXOs(address);
				let inputSum = 0;
				const inputs: TxInput[] = [];

				for (const utxo of utxos) {
					// Skip immature coinbase UTXOs
					if (utxo.isCoinbase && this.chain.length - utxo.blockIndex < COIN_MATURITY) {
						continue;
					}
					inputSum += utxo.output.amount;
					inputs.push({
						previousTx: utxo.txHash,
						outputIndex: utxo.outputIndex,
						signature: '',
					});
					if (inputSum >= amount) break;
				}

				const outputs: TxOutput[] = [
					{ address: address, amount: 0 },      // Coinstake marker
					{ address: address, amount: amount },  // Staked amount
				];

				// Add change output if necessary
				if (inputSum > amount) {
					outputs.push({
						address: address,
						amount: inputSum - amount, // Return change
					});
				}

				const stakingTx = new Transaction(inputs, outputs);
				wallet.signTransaction(stakingTx);
				// Add the transaction to pending pool (internal, lock already held)
				this._addTransactionInternal(stakingTx);
			}

			// Register the stake so a PoS block can be created
			if (!this._stakes.has(address)) {
				this._stakes.set(address, {
					amount,
					timestamp: Date.now(),
					lastBlockTime: this.getLatestBlock().timestamp,
				});
			}
		} finally {
			release();
		}
	}

	async unstake(address: string, amount: number): Promise<void> {
		const release = await this._lock.acquire();
		try {
			const currentStake = this._stakes.get(address);
			if (!currentStake) {
				throw new Error('No stake found for address');
			}

			// Account for already-pending unstake amounts
			const pendingAmount = this._pendingUnstakes
				.filter(u => u.address === address)
				.reduce((sum, u) => sum + u.amount, 0);
			if (currentStake.amount - pendingAmount < amount) {
				throw new Error('Insufficient stake amount');
			}

			// Queue the unstake — actual removal after UNSTAKE_DELAY blocks
			this._pendingUnstakes.push({
				address,
				amount,
				requestHeight: this.chain.length,
			});
		} finally {
			release();
		}
	}

	getStake(address: string): number {
		return this._stakes.get(address)?.amount || 0;
	}

	getStakeInfo(address: string): StakeInfo | undefined {
		const info = this._stakes.get(address);
		return info ? { ...info } : undefined;
	}

	getPendingUnstakes(address?: string): PendingUnstake[] {
		if (address) {
			return this._pendingUnstakes.filter(u => u.address === address);
		}
		return [...this._pendingUnstakes];
	}

	async submitDoubleSignEvidence(
		height: number,
		blockHash1: string,
		blockHash2: string,
		validatorAddress: string,
	): Promise<void> {
		const release = await this._lock.acquire();
		try {
			if (blockHash1 === blockHash2) {
				throw new Error('block hashes must be different');
			}
			const signatures = this._blockSignatures.get(height);
			const knownHash = signatures?.get(validatorAddress);
			if (!knownHash) {
				throw new Error('no known block signature for validator at this height');
			}
			// One of the hashes must match the known signature
			if (knownHash !== blockHash1 && knownHash !== blockHash2) {
				throw new Error('neither block hash matches known signature');
			}
			// Slash: remove the validator's stake entirely
			this._stakes.delete(validatorAddress);
			// Remove any pending unstakes for the slashed validator
			this._pendingUnstakes = this._pendingUnstakes.filter(
				u => u.address !== validatorAddress,
			);
		} finally {
			release();
		}
	}

	createTransaction(
		from: string,
		to: string,
		amount: number,
		wallet: Wallet
	): Transaction {
		if (!this.validateAddress(from)) {
			throw new Error('invalid sender address');
		}
		if (!this.validateAddress(to)) {
			throw new Error('invalid recipient address');
		}

		const utxos = this.getUTXOs(from);
		let inputSum = 0;
		const inputs: TxInput[] = [];

		for (const utxo of utxos) {
			// Skip UTXOs already claimed by pending transactions
			if (this._pendingUTXOSpends.has(this.utxoKey(utxo.txHash, utxo.outputIndex))) {
				continue;
			}
			// Skip immature coinbase UTXOs
			if (utxo.isCoinbase && this.chain.length - utxo.blockIndex < COIN_MATURITY) {
				continue;
			}
			inputSum += utxo.output.amount;
			inputs.push({
				previousTx: utxo.txHash,
				outputIndex: utxo.outputIndex,
				signature: '',
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

	public generateStakeBlock(stakeholderAddress: string, wallet: Wallet): Block | null {
		if (!this.canCreateStakeBlock(stakeholderAddress)) {
			return null;
		}

		const stake = this._stakes.get(stakeholderAddress)!;

		// Gather inputs from UTXOs to cover the stake amount
		const utxos = this.getUTXOs(stakeholderAddress);
		let accumulated = 0;
		const inputs: TxInput[] = [];
		for (const utxo of utxos) {
			// Skip immature coinbase UTXOs
			if (utxo.isCoinbase && this.chain.length - utxo.blockIndex < COIN_MATURITY) {
				continue;
			}
			accumulated += utxo.output.amount;
			inputs.push({
				previousTx: utxo.txHash,
				outputIndex: utxo.outputIndex,
				signature: '',
			});
			if (accumulated >= stake.amount) break;
		}
		if (accumulated < stake.amount) {
			return null; // insufficient funds to create stake block
		}

		const outputs: TxOutput[] = [
			{ address: stakeholderAddress, amount: 0 }, // marker output
			{ address: stakeholderAddress, amount: stake.amount },
		];
		// Add change if needed
		const change = accumulated - stake.amount;
		if (change > 0) {
			outputs.push({ address: stakeholderAddress, amount: change });
		}

		const stakeTransaction = new Transaction(inputs, outputs);
		wallet.signTransaction(stakeTransaction);

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

		return block;
	}

	public isEligibleValidator(
		address: string,
		timestamp: number,
		previousBlockHash: string,
		previousBlockTimestamp: number,
		stakes?: Map<string, StakeInfo>,
	): boolean {
		const stakeWeight = this.calculateStakeWeight(address, stakes);
		const totalStake = this.totalNetworkStake(stakes);
		if (totalStake === 0 || stakeWeight === 0) return false;

		// Deterministic slot derived from timestamp
		const slotNumber = Math.floor(timestamp / this.SLOT_DURATION);

		// Deterministic hash from previous block, validator address, and time slot
		const selectionData = previousBlockHash + address + slotNumber.toString();
		const selectionHash = crypto
			.createHash('sha256')
			.update(selectionData)
			.digest('hex');
		const hashValue = BigInt('0x' + selectionHash);

		// Time since last block in seconds (minimum 1 to avoid zero target)
		const timeSinceLastBlock = Math.max(
			1,
			Math.floor((timestamp - previousBlockTimestamp) / 1000),
		);

		// target = MAX_HASH * stakeWeight * timeSinceLastBlock / (totalStake * BLOCK_TIME)
		// Higher stake weight → higher target → more likely to win
		// More time since last block → higher target → block guaranteed eventually
		const target =
			(Blockchain.MAX_HASH * BigInt(stakeWeight) * BigInt(timeSinceLastBlock)) /
			(BigInt(totalStake) * BigInt(this.BLOCK_TIME));

		return hashValue < target;
	}

	private canCreateStakeBlock(address: string): boolean {
		const stake = this._stakes.get(address);
		if (!stake) {
			return false;
		}

		if (this._options.minStakeAge > 0) {
			const stakeAge = (Date.now() - stake.timestamp) / 1000;
			if (stakeAge < this._options.minStakeAge) {
				return false;
			}
		}

		if (this._options.stakeCheckInterval > 0) {
			if (Date.now() - stake.lastBlockTime < this._options.stakeCheckInterval) {
				return false;
			}
		}

		// Stake-weighted lottery
		const latestBlock = this.getLatestBlock();
		return this.isEligibleValidator(
			address,
			Date.now(),
			latestBlock.hash,
			latestBlock.timestamp,
		);
	}

	public async minePendingTransactions(minerAddress: string, wallet?: Wallet): Promise<Block> {
		// Switch to PoS only after cutoff block has been added (length > POW_CUTOFF_BLOCK)
		const isPoSPhase = this.chain.length > POW_CUTOFF_BLOCK;
		const lastBlock = this.getLatestBlock();

		// Always use Date.now() for timestamp so tests can control time
		const timestamp = Date.now();

		if (isPoSPhase && wallet) {
			const stake = this._stakes.get(minerAddress);
			if (stake) {
				const stakeBlock = this.generateStakeBlock(minerAddress, wallet);
				if (!stakeBlock) {
					throw new Error('Failed to generate stake block');
				}
				stakeBlock.timestamp = timestamp;
				stakeBlock.hash = stakeBlock.calculateHash();
				await this.addMinedBlock(stakeBlock);
				return stakeBlock;
			}
			// Fallback to PoW if miner has no stake (mainly for test scenarios)
		}

		// PoW phase
		const coinbaseTransaction = new Transaction(
			[],
			[{ address: minerAddress, amount: POW_BLOCK_REWARD }]
		);

		const transactions = [coinbaseTransaction, ...this.pendingTransactions];

		const block = new Block(
			timestamp,
			transactions,
			lastBlock.hash,
			0,
			this._options.validateDifficulty ? this.calculateNewDifficulty() : 1,
			this.chain.length
		);

		while (!block.isValid()) {
			block.nonce++;
			block.hash = block.calculateHash();
		}

		// Use common path for validation/persistence
		await this.addMinedBlock(block);
		return block;
	}

	private _addTransactionInternal(transaction: Transaction): void {
		if (transaction.inputs.length === 0 || transaction.outputs.length === 0) {
			throw new Error('Transaction must have inputs and outputs');
		}

		// Structural validation (signatures, duplicates, amounts, size limits)
		transaction.validate();

		// Validate all output addresses
		for (const output of transaction.outputs) {
			if (!this.validateAddress(output.address)) {
				throw new Error('invalid output address');
			}
		}

		// Verify all inputs reference existing UTXOs and calculate input sum
		let inputSum = 0;
		for (const input of transaction.inputs) {
			const result = this.findTransactionBlock(input.previousTx);
			if (!result) {
				throw new Error('input references non-existent transaction');
			}
			const prevOutput = result.tx.outputs[input.outputIndex];
			if (!prevOutput) {
				throw new Error('input references non-existent output');
			}

			// Verify the UTXO is unspent
			const utxos = this.getUTXOs(prevOutput.address);
			const utxoExists = utxos.some(
				(utxo) =>
					utxo.txHash === input.previousTx &&
					utxo.outputIndex === input.outputIndex
			);
			if (!utxoExists) {
				throw new Error('input references spent or non-existent utxo');
			}

			inputSum += prevOutput.amount;

			// Check coinbase maturity
			if (
				result.tx.isCoinbase() &&
				this.chain.length - result.blockIndex < COIN_MATURITY
			) {
				throw new Error('coinbase output has not reached maturity');
			}
		}

		// Verify input sum covers output sum
		const outputSum = transaction.outputs.reduce(
			(sum, out) => sum + out.amount, 0
		);
		if (inputSum < outputSum) {
			throw new Error('output amounts exceed input amounts');
		}

		// Check each input against pending UTXO spends
		for (const input of transaction.inputs) {
			const key = this.utxoKey(input.previousTx, input.outputIndex);
			if (this._pendingUTXOSpends.has(key)) {
				throw new Error('utxo already spent by pending transaction');
			}
		}

		// Track all inputs as pending spends
		for (const input of transaction.inputs) {
			this._pendingUTXOSpends.add(
				this.utxoKey(input.previousTx, input.outputIndex)
			);
		}

		this.pendingTransactions.push(transaction);
	}

	async addTransaction(transaction: Transaction): Promise<void> {
		const release = await this._lock.acquire();
		try {
			this._addTransactionInternal(transaction);
		} finally {
			release();
		}
	}

	isChainValid(): boolean {
		// Rebuild stake state incrementally to validate each block against its context
		const validationStakes = new Map<string, StakeInfo>();

		for (let i = 1; i < this.chain.length; i++) {
			const currentBlock = this.chain[i];
			const previousBlock = this.chain[i - 1];

			if (!currentBlock.hasValidTransactions()) {
				console.log(`Block ${i} has invalid transactions`);
				return false;
			}

			if (currentBlock.hash !== currentBlock.calculateHash()) {
				console.log(`Block ${i} has invalid hash`);
				return false;
			}

			if (currentBlock.previousHash !== previousBlock.hash) {
				console.log(`Block ${i} has invalid previous hash`);
				return false;
			}

			// Update validation stakes from this block's transactions
			// (must happen before PoS check — stake can be registered in same block)
			for (const tx of currentBlock.transactions) {
				if (tx.inputs.length === 0) continue;
				if (tx.outputs.length === 0) continue;

				let stakeAddress: string | null = null;
				let stakeAmount: number | null = null;

				if (
					tx.outputs.length >= 2 &&
					tx.outputs[0].amount === 0 &&
					tx.outputs[1].amount >= this.MIN_STAKE_AMOUNT
				) {
					stakeAddress = tx.outputs[1].address;
					stakeAmount = tx.outputs[1].amount;
				}

				if (stakeAddress && stakeAmount) {
					validationStakes.set(stakeAddress, {
						amount: stakeAmount,
						timestamp: currentBlock.timestamp,
						lastBlockTime: currentBlock.timestamp,
					});
				}
			}

			if (currentBlock.isProofOfStake()) {
				const stakeTransaction = currentBlock.transactions[1];
				const validatorAddress = stakeTransaction.outputs[1].address;
				const stake = validationStakes.get(validatorAddress);
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
		return [...this.pendingTransactions];
	}

	private loadBlockchain(): void {
		try {
			const blocks = this.blockStore.loadAllBlocks();

			if (blocks.length === 0) {
				// No stored blocks — persist genesis and return
				this.chain = [this.createGenesisBlock()];
				Blockchain.computeChainWeights(this.chain);
				this.blockStore.appendBlock(this.chain[0]);
				this.utxoSet.clear();
				this.updateUTXOSet(this.chain[0]);
				return;
			}

			// Validate genesis block (field-by-field + full hash verification)
			const genesisBlock = blocks[0];
			const expectedGenesis = this.createGenesisBlock();

			if (
				genesisBlock.timestamp !== expectedGenesis.timestamp ||
				genesisBlock.previousHash !== expectedGenesis.previousHash ||
				genesisBlock.index !== expectedGenesis.index ||
				genesisBlock.transactions.length !==
					expectedGenesis.transactions.length ||
				genesisBlock.transactions[0].outputs[0].address !==
					expectedGenesis.transactions[0].outputs[0].address ||
				genesisBlock.transactions[0].outputs[0].amount !==
					expectedGenesis.transactions[0].outputs[0].amount
			) {
				throw new Error('Invalid genesis block');
			}

			// Verify genesis block hash integrity
			if (genesisBlock.hash !== expectedGenesis.hash) {
				throw new Error('Invalid genesis block: hash mismatch');
			}

			// Validate chain continuity
			for (let i = 1; i < blocks.length; i++) {
				const currentBlock = blocks[i];
				const previousBlock = blocks[i - 1];

				if (currentBlock.previousHash !== previousBlock.hash) {
					throw new Error(`Invalid chain at block ${i}: broken link`);
				}

				if (!currentBlock.hasValidTransactions()) {
					throw new Error(`Invalid chain at block ${i}: invalid transactions`);
				}
			}

			this.chain = blocks;

			// Compute cumulative weights
			Blockchain.computeChainWeights(this.chain);

			// Rebuild UTXO set
			this.utxoSet.clear();
			for (const block of this.chain) {
				this.updateUTXOSet(block);
			}
		} catch (error) {
			console.error('Error loading blockchain:', error);
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

	getMedianTimePast(): number {
		const count = Math.min(this.chain.length, MEDIAN_TIME_SPAN);
		const startIndex = this.chain.length - count;
		const timestamps: number[] = [];
		for (let i = startIndex; i < this.chain.length; i++) {
			timestamps.push(this.chain[i].timestamp);
		}
		timestamps.sort((a, b) => a - b);
		return timestamps[Math.floor(timestamps.length / 2)];
	}

	calculateNewDifficulty(): number {
		if (this.chain.length <= DIFFICULTY_ADJUSTMENT_INTERVAL) {
			return this.chain[0].getDifficulty();
		}

		const lastIndex = this.chain.length - 1;
		const firstIndex = lastIndex - DIFFICULTY_ADJUSTMENT_INTERVAL;

		// Use direct block timestamps for the interval
		const timeTaken = Math.max(
			1,
			this.chain[lastIndex].timestamp - this.chain[firstIndex].timestamp,
		);
		const timeExpected =
			BLOCK_TIME * 1000 * DIFFICULTY_ADJUSTMENT_INTERVAL;

		const oldDifficulty = this.chain[lastIndex].getDifficulty();

		// Proportional adjustment: newDifficulty = old * (expected / actual)
		let newDifficulty = Math.round(
			oldDifficulty * (timeExpected / timeTaken),
		);

		// Clamp: no more than 4x change in either direction
		const maxDifficulty = oldDifficulty * MAX_DIFFICULTY_CHANGE_FACTOR;
		const minDifficulty = Math.ceil(
			oldDifficulty / MAX_DIFFICULTY_CHANGE_FACTOR,
		);
		newDifficulty = Math.min(newDifficulty, maxDifficulty);
		newDifficulty = Math.max(newDifficulty, minDifficulty);

		// Enforce minimum difficulty floor
		return Math.max(MIN_DIFFICULTY, newDifficulty);
	}

	private getMedianTimePastForChain(chain: Block[], upToIndex: number): number {
		const count = Math.min(upToIndex + 1, MEDIAN_TIME_SPAN);
		const startIndex = upToIndex + 1 - count;
		const timestamps: number[] = [];
		for (let i = startIndex; i <= upToIndex; i++) {
			timestamps.push(chain[i].timestamp);
		}
		timestamps.sort((a, b) => a - b);
		return timestamps[Math.floor(timestamps.length / 2)];
	}

	private calculateDifficultyForChain(chain: Block[], atIndex: number): number {
		if (atIndex <= DIFFICULTY_ADJUSTMENT_INTERVAL) {
			return chain[0].getDifficulty();
		}
		const lastIndex = atIndex - 1;
		const firstIndex = lastIndex - DIFFICULTY_ADJUSTMENT_INTERVAL;
		const timeTaken = Math.max(
			1,
			chain[lastIndex].timestamp - chain[firstIndex].timestamp,
		);
		const timeExpected = BLOCK_TIME * 1000 * DIFFICULTY_ADJUSTMENT_INTERVAL;
		const oldDifficulty = chain[lastIndex].getDifficulty();
		let newDifficulty = Math.round(
			oldDifficulty * (timeExpected / timeTaken),
		);
		const maxDiff = oldDifficulty * MAX_DIFFICULTY_CHANGE_FACTOR;
		const minDiff = Math.ceil(
			oldDifficulty / MAX_DIFFICULTY_CHANGE_FACTOR,
		);
		newDifficulty = Math.min(newDifficulty, maxDiff);
		newDifficulty = Math.max(newDifficulty, minDiff);
		return Math.max(MIN_DIFFICULTY, newDifficulty);
	}

	public async replaceChain(newChain: Block[]): Promise<void> {
		const release = await this._lock.acquire();
		try {
			// Compute cumulative weights for the new chain
			Blockchain.computeChainWeights(newChain);

			// Compare by cumulative weight, not length
			const newWeight = newChain[newChain.length - 1].cumulativeWeight;
			const currentWeight = this.getChainWeight();
			if (newWeight <= currentWeight) {
				throw new Error('received chain does not have more weight than current chain');
			}

			// Verify genesis block hash integrity
			const expectedGenesis = this.createGenesisBlock();
			if (newChain[0].hash !== expectedGenesis.hash) {
				throw new Error('Invalid chain: genesis block hash mismatch');
			}

			// Build stakes incrementally for PoS validation
			const validationStakes = new Map<string, StakeInfo>();

			// Validate chain integrity
			for (let i = 1; i < newChain.length; i++) {
				const block = newChain[i];
				const previousBlock = newChain[i - 1];

				// Validate block index continuity
				if (block.index !== i) {
					throw new Error('Invalid chain: incorrect block index');
				}

				// Validate block linkage
				if (block.previousHash !== previousBlock.hash) {
					throw new Error('Invalid chain: broken link');
				}

				// Validate block hash matches recalculated hash
				if (block.hash !== block.calculateHash()) {
					throw new Error('Invalid chain: block hash mismatch');
				}

				// Validate block transactions
				if (!block.hasValidTransactions()) {
					throw new Error('Invalid chain: invalid transactions');
				}

				// Validate coinbase
				this.validateBlockCoinbase(block);

				// Block size limit
				if (block.transactions.length > MAX_BLOCK_TRANSACTIONS) {
					throw new Error('Invalid chain: block exceeds maximum transaction count');
				}

				// Timestamp validations
				if (this._options.validateTimestamps) {
					if (block.timestamp > Date.now() + MAX_FUTURE_BLOCK_TIME) {
						throw new Error('Invalid chain: block timestamp too far in the future');
					}

					if (this._options.minBlockInterval > 0 &&
						block.timestamp - previousBlock.timestamp < this._options.minBlockInterval) {
						throw new Error('Invalid chain: block created too quickly');
					}

					const medianTimePast = this.getMedianTimePastForChain(newChain, i - 1);
					if (block.timestamp <= medianTimePast) {
						throw new Error('Invalid chain: block timestamp must be greater than median time past');
					}
				}

				// Update validation stakes from this block's transactions
				for (const tx of block.transactions) {
					if (tx.inputs.length === 0) continue;
					if (tx.outputs.length === 0) continue;

					let stakeAddress: string | null = null;
					let stakeAmount: number | null = null;

					if (
						tx.outputs.length >= 2 &&
						tx.outputs[0].amount === 0 &&
						tx.outputs[1].amount >= this.MIN_STAKE_AMOUNT
					) {
						stakeAddress = tx.outputs[1].address;
						stakeAmount = tx.outputs[1].amount;
					}

					if (stakeAddress && stakeAmount) {
						validationStakes.set(stakeAddress, {
							amount: stakeAmount,
							timestamp: block.timestamp,
							lastBlockTime: block.timestamp,
						});
					}
				}

				// Validate PoW blocks
				if (block.isProofOfWork()) {
					if (!block.isValid()) {
						throw new Error('Invalid chain: invalid proof of work');
					}
					if (i > POW_CUTOFF_BLOCK) {
						throw new Error('Invalid chain: PoW block after cutoff');
					}
					if (this._options.validateDifficulty) {
						const expectedDifficulty = this.calculateDifficultyForChain(newChain, i);
						if (block.powDifficulty !== expectedDifficulty) {
							throw new Error('Invalid chain: incorrect block difficulty');
						}
					}
				}

				// Validate PoS blocks
				if (block.isProofOfStake()) {
					const stakeTransaction = block.transactions[1];
					const validatorAddress = stakeTransaction.outputs[1].address;
					const stake = validationStakes.get(validatorAddress);
					if (!stake || stake.amount < this.MIN_STAKE_AMOUNT) {
						throw new Error('Invalid chain: invalid stake');
					}
					// Verify validator was eligible via stake-weighted lottery
					if (!this.isEligibleValidator(
						validatorAddress,
						block.timestamp,
						previousBlock.hash,
						previousBlock.timestamp,
						validationStakes,
					)) {
						throw new Error('Invalid chain: validator not eligible for this slot');
					}
				}
			}

			// Save old chain for orphan transaction recovery
			const oldChain = this.chain;

			// Replace the chain
			this.chain = newChain;

			// Reset and rebuild UTXO set
			this.utxoSet.clear();
			for (const block of this.chain) {
				this.updateUTXOSet(block);
			}

			// Clear pending transactions that are now in the chain
			const chainTxHashes = new Set(
				this.chain.flatMap((block) =>
					block.transactions.map((tx: Transaction) => tx.calculateHash())
				)
			);
			this.pendingTransactions = this.pendingTransactions.filter(
				(tx) => !chainTxHashes.has(tx.calculateHash())
			);

			// Rebuild pending UTXO spends from remaining pending transactions
			this._pendingUTXOSpends.clear();
			for (const tx of this.pendingTransactions) {
				for (const input of tx.inputs) {
					this._pendingUTXOSpends.add(
						this.utxoKey(input.previousTx, input.outputIndex)
					);
				}
			}

			// Re-add transactions from orphaned blocks back to pending pool
			const forkIndex = oldChain.findIndex((block, i) =>
				i >= newChain.length || block.hash !== newChain[i].hash
			);
			if (forkIndex > 0) {
				for (let i = forkIndex; i < oldChain.length; i++) {
					for (const tx of oldChain[i].transactions) {
						if (tx.isCoinbase() || tx.isCoinStake()) continue;
						if (chainTxHashes.has(tx.calculateHash())) continue;
						try {
							this._addTransactionInternal(tx);
						} catch {
							// Transaction no longer valid in new chain context
						}
					}
				}
			}

			// Persist the new chain
			this.blockStore.replaceAll(this.chain);
		} finally {
			release();
		}
	}
}
