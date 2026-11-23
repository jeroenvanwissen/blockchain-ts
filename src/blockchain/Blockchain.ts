import { Block } from './Block.js';
import { NULL_HASH, Transaction, type TxInput, type TxOutput } from './Transaction.js';
import { Wallet } from './Wallet.js';
import { BlockStore } from './BlockStore.js';
import { addressFromPublicKey, isValidAddress } from './address.js';
import { outpointKey, UtxoSet, type UTXO } from './UtxoSet.js';
import { requiredBits } from './retarget.js';
import { MAX_TARGET_BITS, POW_LIMIT_BITS } from './target.js';
import * as crypto from 'crypto';
import {
	BLOCKS_DIR,
	MIN_STAKE_AMOUNT,
	POW_CUTOFF_BLOCK,
	POS_BLOCK_REWARD,
	POW_BLOCK_REWARD,
	COIN_MATURITY,
	BLOCK_TIME,
	GENESIS_TIMESTAMP,
	MEDIAN_TIME_SPAN,
	MAX_BLOCK_TRANSACTIONS,
	MAX_FUTURE_BLOCK_TIME,
	UNSTAKE_DELAY,
	MAX_STAKE_AGE_MULTIPLIER,
} from '../config.js';

export interface StakeInfo {
	amount: bigint;
	timestamp: number;
	lastBlockTime: number;
}

export interface PendingUnstake {
	address: string;
	amount: bigint;
	requestHeight: number;
}

import { Mutex } from 'async-mutex';

export interface BlockchainOptions {
	minStakeAge?: number;
	validateDifficulty?: boolean;
	validateTimestamps?: boolean;
	stakeCheckInterval?: number;
	allowPowAfterCutoff?: boolean;
	/** Directory for blk*.dat and index.dat (defaults to BLOCKS_DIR from config) */
	blocksDir?: string;
}

/** Chain state a block is validated against; `utxos` and `stakes` advance as blocks connect. */
interface ConnectContext {
	prevBlocks: Block[]; // chain up to and including the parent block
	utxos: UtxoSet;
	stakes: Map<string, StakeInfo>;
}

export class Blockchain {
	private _lock: Mutex = new Mutex();

	private static readonly MAX_HASH = BigInt('0x' + 'f'.repeat(64));

	private chain: Block[];
	private _utxos = new UtxoSet();
	private _pendingUTXOSpends: Set<string> = new Set();
	private pendingTransactions: Transaction[];
	private _stakes: Map<string, StakeInfo> = new Map();
	private _pendingUnstakes: PendingUnstake[] = [];
	private _blockSignatures: Map<number, Map<string, string>> = new Map();
	private lastBlockTime: number = Date.now();
	private blockStore: BlockStore;
	readonly BLOCK_TIME = BLOCK_TIME;
	private readonly MIN_STAKE_AMOUNT = MIN_STAKE_AMOUNT;
	private readonly SLOT_DURATION = 60 * 1000;
	private readonly _options: Required<BlockchainOptions>;

	constructor(options?: BlockchainOptions) {
		this._options = {
			minStakeAge: 86400,
			validateDifficulty: true,
			validateTimestamps: true,
			stakeCheckInterval: 60 * 1000,
			allowPowAfterCutoff: false,
			blocksDir: BLOCKS_DIR,
			...options,
		};
		this.blockStore = new BlockStore(this._options.blocksDir);
		const genesisBlock = this.createGenesisBlock();
		genesisBlock.cumulativeWeight = Blockchain.blockWeight(genesisBlock);
		this.chain = [genesisBlock];
		this.pendingTransactions = [];

		// Initialize UTXO set with genesis block
		this._utxos.addOutputs(genesisBlock.transactions[0], 0);

		// Load the rest of the blockchain
		this.loadBlockchain();
	}

	/** Chain work contributed by one block (PoW and PoS alike): 2^256 / (target + 1). */
	static blockWeight(block: Block): bigint {
		return block.work();
	}

	static computeChainWeights(chain: Block[]): void {
		let cumulativeWork = 0n;
		for (const block of chain) {
			cumulativeWork += Blockchain.blockWeight(block);
			block.cumulativeWeight = cumulativeWork;
		}
	}

	getChainWeight(): bigint {
		return this.getLatestBlock().cumulativeWeight;
	}

	public getUTXOs(address: string): UTXO[] {
		return this._utxos.forAddress(address);
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
		if (coinbaseTx.inputs[0].outputIndex !== block.index) {
			throw new Error('coinbase height does not match block index');
		}
	}

	/**
	 * Inputs of a non-coinbase transaction against `lookup`: each must be unspent, owned by
	 * the signing key, and mature at `height`; inputs must cover outputs. Returns the input sum.
	 */
	private _checkInputs(
		tx: Transaction,
		lookup: (txHash: string, outputIndex: number) => UTXO | undefined,
		height: number,
	): bigint {
		let inputSum = 0n;
		for (const input of tx.inputs) {
			const utxo = lookup(input.previousTx, input.outputIndex);
			if (!utxo) {
				throw new Error('input references a missing or spent output');
			}
			if (addressFromPublicKey(Buffer.from(input.publicKey, 'hex')) !== utxo.output.address) {
				throw new Error('input public key does not own the spent output');
			}
			if (utxo.isCoinbase && height - utxo.blockIndex < COIN_MATURITY) {
				throw new Error('coinbase output has not reached maturity');
			}
			inputSum += utxo.output.amount;
		}
		const outputSum = tx.outputs.reduce((sum, out) => sum + out.amount, 0n);
		if (inputSum < outputSum) {
			throw new Error('output amounts exceed input amounts');
		}
		return inputSum;
	}

	/** Register coinstake-format transactions (zero marker + amount) as stakes. */
	private _applyStakeTransactions(block: Block, stakes: Map<string, StakeInfo>): void {
		for (const tx of block.transactions) {
			if (tx.isCoinbase()) continue;
			if (
				tx.outputs.length >= 2 &&
				tx.outputs[0].amount === 0n &&
				tx.outputs[1].amount >= this.MIN_STAKE_AMOUNT
			) {
				stakes.set(tx.outputs[1].address, {
					amount: tx.outputs[1].amount,
					timestamp: block.timestamp,
					lastBlockTime: block.timestamp,
				});
			}
		}
	}

	/**
	 * The single block-validation path, used for new blocks, chain replacement and startup
	 * load. Validates `block` on top of `ctx` and, only if every check passes, applies it to
	 * ctx.utxos and ctx.stakes (nothing is changed when it throws). Consensus checks read time
	 * from block data only; the wall clock is used only for the future-timestamp limit.
	 */
	private _connectBlock(block: Block, ctx: ConnectContext): void {
		const height = ctx.prevBlocks.length;
		const parent = ctx.prevBlocks[height - 1];

		// Structure and linkage (cheap checks first)
		if (block.transactions.length > MAX_BLOCK_TRANSACTIONS) {
			throw new Error('block exceeds maximum transaction count');
		}
		if (block.index !== height) {
			throw new Error(`incorrect block index: expected ${height}, got ${block.index}`);
		}
		if (block.previousHash !== parent.hash) {
			throw new Error('broken link: previous hash does not match');
		}
		if (block.hash !== block.calculateHash()) {
			throw new Error('block hash mismatch');
		}
		this.validateBlockCoinbase(block);

		// Timestamps (block spacing is governed by the retarget, not a minimum interval)
		if (this._options.validateTimestamps) {
			if (block.timestamp <= this.getMedianTimePastForChain(ctx.prevBlocks, height - 1)) {
				throw new Error('block timestamp must be greater than median time past');
			}
			if (block.timestamp > Date.now() + MAX_FUTURE_BLOCK_TIME) {
				throw new Error('block timestamp too far in the future');
			}
		}

		// Target (per-block retarget, separate for PoW and PoS) and consensus type
		if (
			this._options.validateDifficulty &&
			block.bits !== requiredBits(ctx.prevBlocks, height, block.isProofOfStake())
		) {
			throw new Error('incorrect block difficulty');
		}
		if (block.isProofOfWork()) {
			if (!this._options.allowPowAfterCutoff && height > POW_CUTOFF_BLOCK) {
				throw new Error(`PoW blocks no longer accepted after block ${POW_CUTOFF_BLOCK}`);
			}
			if (!block.isValid()) {
				throw new Error('invalid proof of work');
			}
		} else if (!this.validateStake(block.transactions[1], block.timestamp, ctx.utxos)) {
			throw new Error('invalid stake');
		}

		// Transactions, in order, against a block-local view of the UTXO set
		const created = new Map<string, UTXO>();
		const spent = new Map<string, [string, number]>();
		const lookup = (txHash: string, outputIndex: number): UTXO | undefined => {
			const key = outpointKey(txHash, outputIndex);
			if (spent.has(key)) return undefined;
			return created.get(key) ?? ctx.utxos.get(txHash, outputIndex);
		};
		block.transactions.forEach((tx, t) => {
			try {
				for (const output of tx.outputs) {
					if (!isValidAddress(output.address)) throw new Error('invalid output address');
				}
				if (!tx.isCoinbase()) {
					tx.validate(); // structure and signatures
					this._checkInputs(tx, lookup, height);
					for (const input of tx.inputs) {
						spent.set(outpointKey(input.previousTx, input.outputIndex), [
							input.previousTx,
							input.outputIndex,
						]);
					}
				}
			} catch (error) {
				throw new Error(`transaction ${t}: ${(error as Error).message}`);
			}
			const txHash = tx.calculateHash();
			tx.outputs.forEach((output, outputIndex) => {
				created.set(outpointKey(txHash, outputIndex), {
					txHash,
					outputIndex,
					output,
					blockIndex: height,
					isCoinbase: tx.isCoinbase(),
					txTimestamp: tx.timestamp,
				});
			});
		});

		// Stake registrations from this block, then PoS eligibility against them
		const stakes = new Map(ctx.stakes);
		this._applyStakeTransactions(block, stakes);
		if (block.isProofOfStake()) {
			const validatorAddress = block.transactions[1].outputs[1].address;
			if (
				!this.isEligibleValidator(
					validatorAddress,
					block.timestamp,
					parent.hash,
					parent.timestamp,
					stakes,
				)
			) {
				throw new Error('validator not eligible for this slot');
			}
		}

		// Every check passed: apply
		for (const [key, [txHash, outputIndex]] of spent) {
			if (!created.delete(key)) ctx.utxos.remove(txHash, outputIndex);
		}
		for (const utxo of created.values()) ctx.utxos.add(utxo);
		ctx.stakes = stakes;
	}

	/** Validate a whole chain from genesis through _connectBlock and return its state. */
	private _replayChain(blocks: Block[]): { utxos: UtxoSet; stakes: Map<string, StakeInfo> } {
		const genesis = this.createGenesisBlock();
		if (
			blocks.length === 0 ||
			blocks[0].hash !== genesis.hash ||
			blocks[0].calculateHash() !== genesis.hash
		) {
			throw new Error('genesis block hash mismatch');
		}
		const ctx: ConnectContext = {
			prevBlocks: [blocks[0]],
			utxos: new UtxoSet(),
			stakes: new Map(),
		};
		ctx.utxos.addOutputs(blocks[0].transactions[0], 0);
		for (let i = 1; i < blocks.length; i++) {
			try {
				this._connectBlock(blocks[i], ctx);
			} catch (error) {
				throw new Error(`block ${i}: ${(error as Error).message}`);
			}
			ctx.prevBlocks.push(blocks[i]);
		}
		return { utxos: ctx.utxos, stakes: ctx.stakes };
	}

	private _addMinedBlockInternal(block: Block): void {
		const ctx: ConnectContext = { prevBlocks: this.chain, utxos: this._utxos, stakes: this._stakes };
		this._connectBlock(block, ctx);
		this._stakes = ctx.stakes;

		// Record PoS block signatures for double-sign detection (node-local, see TASK-0011)
		if (block.isProofOfStake()) {
			const validatorAddress = block.transactions[1].outputs[1].address;
			if (!this._blockSignatures.has(block.index)) {
				this._blockSignatures.set(block.index, new Map());
			}
			this._blockSignatures.get(block.index)!.set(validatorAddress, block.hash);
		}

		block.cumulativeWeight = this.getLatestBlock().cumulativeWeight + Blockchain.blockWeight(block);
		this.chain.push(block);
		this.lastBlockTime = block.timestamp;
		this.pendingTransactions = [];
		this._pendingUTXOSpends.clear();

		// Process matured pending unstakes
		this._pendingUnstakes = this._pendingUnstakes.filter((unstake) => {
			if (this.chain.length - unstake.requestHeight >= UNSTAKE_DELAY) {
				const stake = this._stakes.get(unstake.address);
				if (stake) {
					const remaining = stake.amount - unstake.amount;
					if (remaining <= 0n) {
						this._stakes.delete(unstake.address);
					} else {
						this._stakes.set(unstake.address, { ...stake, amount: remaining });
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

	/**
	 * Coinstake checks that need the UTXO set before the block is applied. Stake age is
	 * measured at the block's timestamp, not the wall clock.
	 */
	private validateStake(stakeTransaction: Transaction, blockTimestamp: number, utxos: UtxoSet): boolean {
		if (!stakeTransaction.isCoinStake()) {
			return false;
		}
		const stakeOutput = stakeTransaction.outputs[1];
		if (stakeOutput.amount < this.MIN_STAKE_AMOUNT) {
			return false;
		}

		let inputSum = 0n;
		let earliestInputTime = Number.MAX_SAFE_INTEGER;
		for (const input of stakeTransaction.inputs) {
			const utxo = utxos.get(input.previousTx, input.outputIndex);
			// Must be unspent and owned by the staker
			if (!utxo || utxo.output.address !== stakeOutput.address) {
				return false;
			}
			inputSum += utxo.output.amount;
			earliestInputTime = Math.min(earliestInputTime, utxo.txTimestamp);
		}
		if (inputSum < stakeOutput.amount) {
			return false;
		}
		if (
			this._options.minStakeAge > 0 &&
			(blockTimestamp - earliestInputTime) / 1000 < this._options.minStakeAge
		) {
			return false;
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
		const coinbase = Transaction.coinbase('genesis', 0n, 0, GENESIS_TIMESTAMP);
		return new Block(GENESIS_TIMESTAMP, [coinbase], NULL_HASH, 0, POW_LIMIT_BITS, 0);
	}

	getLatestBlock(): Block {
		return this.chain[this.chain.length - 1];
	}

	public totalNetworkStake(stakes?: Map<string, StakeInfo>): bigint {
		const stakeMap = stakes ?? this._stakes;
		let total = 0n;
		for (const [address] of stakeMap) {
			total += this.calculateStakeWeight(address, stakeMap);
		}
		return total;
	}

	calculateStakeWeight(address: string, stakes?: Map<string, StakeInfo>): bigint {
		const stakeMap = stakes ?? this._stakes;
		const stake = stakeMap.get(address);
		if (!stake) return 0n;

		// Guard against negative elapsed time from corrupted timestamps
		const elapsedMs = Math.max(0, stake.lastBlockTime - stake.timestamp);
		const elapsedDays = Math.floor(elapsedMs / (24 * 60 * 60 * 1000));

		// Base weight is the stake amount
		let weight = stake.amount;

		// Apply multiplier for each day (10% increase per day), bounded
		if (elapsedDays > 0) {
			const rawMultiplier = Math.pow(1.1, elapsedDays);
			const cappedMultiplier = Math.min(rawMultiplier, MAX_STAKE_AGE_MULTIPLIER);
			// Fixed-point multiply (6 decimals) to stay in bigint base units
			weight = (weight * BigInt(Math.floor(cappedMultiplier * 1_000_000))) / 1_000_000n;
		}

		return weight;
	}

	getTotalBalance(address: string): bigint {
		const confirmed = new Map<string, Transaction>();
		let balance = 0n;
		for (const block of this.chain) {
			for (const trans of block.transactions) {
				confirmed.set(trans.calculateHash(), trans);
				// Coins spent (a coinbase input spends nothing)
				for (const input of trans.isCoinbase() ? [] : trans.inputs) {
					const prevOutput = confirmed.get(input.previousTx)?.outputs[input.outputIndex];
					if (prevOutput?.address === address) balance -= prevOutput.amount;
				}
				// Coins received
				for (const output of trans.outputs) {
					if (output.address === address) balance += output.amount;
				}
			}
		}
		return balance;
	}

	public getBalance(address: string): bigint {
		return this.getUTXOs(address).reduce((sum, utxo) => sum + utxo.output.amount, 0n);
	}

	async stake(address: string, amount: bigint, wallet?: Wallet): Promise<void> {
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
				let inputSum = 0n;
				const inputs: TxInput[] = [];

				for (const utxo of utxos) {
					// Skip UTXOs claimed by pending transactions and immature coinbase UTXOs
					if (this._pendingUTXOSpends.has(outpointKey(utxo.txHash, utxo.outputIndex))) {
						continue;
					}
					if (utxo.isCoinbase && this.chain.length - utxo.blockIndex < COIN_MATURITY) {
						continue;
					}
					inputSum += utxo.output.amount;
					inputs.push({
						previousTx: utxo.txHash,
						outputIndex: utxo.outputIndex,
						publicKey: '',
					signature: '',
					});
					if (inputSum >= amount) break;
				}

				const outputs: TxOutput[] = [
					{ address: address, amount: 0n }, // Coinstake marker
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

	async unstake(address: string, amount: bigint): Promise<void> {
		const release = await this._lock.acquire();
		try {
			const currentStake = this._stakes.get(address);
			if (!currentStake) {
				throw new Error('No stake found for address');
			}

			// Account for already-pending unstake amounts
			const pendingAmount = this._pendingUnstakes
				.filter(u => u.address === address)
				.reduce((sum, u) => sum + u.amount, 0n);
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

	getStake(address: string): bigint {
		return this._stakes.get(address)?.amount ?? 0n;
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
		amount: bigint,
		wallet: Wallet
	): Transaction {
		if (!this.validateAddress(from)) {
			throw new Error('invalid sender address');
		}
		if (!this.validateAddress(to)) {
			throw new Error('invalid recipient address');
		}

		const utxos = this.getUTXOs(from);
		let inputSum = 0n;
		const inputs: TxInput[] = [];

		for (const utxo of utxos) {
			// Skip UTXOs already claimed by pending transactions
			if (this._pendingUTXOSpends.has(outpointKey(utxo.txHash, utxo.outputIndex))) {
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
				publicKey: '',
					signature: '',
			});

			if (inputSum >= amount) break;
		}

		if (inputSum < amount) {
			throw new Error('Insufficient funds');
		}

		const outputs: TxOutput[] = [{ address: to, amount }];

		const change = inputSum - amount;
		if (change > 0n) {
			outputs.push({ address: from, amount: change });
		}

		const transaction = new Transaction(inputs, outputs);
		wallet.signTransaction(transaction);

		return transaction;
	}

	validateAddress(address: string): boolean {
		return isValidAddress(address);
	}

	public generateStakeBlock(stakeholderAddress: string, wallet: Wallet): Block | null {
		if (!this.canCreateStakeBlock(stakeholderAddress)) {
			return null;
		}

		const stake = this._stakes.get(stakeholderAddress)!;

		// Gather inputs from UTXOs to cover the stake amount
		const utxos = this.getUTXOs(stakeholderAddress);
		let accumulated = 0n;
		const inputs: TxInput[] = [];
		for (const utxo of utxos) {
			// Skip UTXOs claimed by pending transactions (they go in the same block) and
			// immature coinbase UTXOs
			if (this._pendingUTXOSpends.has(outpointKey(utxo.txHash, utxo.outputIndex))) {
				continue;
			}
			if (utxo.isCoinbase && this.chain.length - utxo.blockIndex < COIN_MATURITY) {
				continue;
			}
			accumulated += utxo.output.amount;
			inputs.push({
				previousTx: utxo.txHash,
				outputIndex: utxo.outputIndex,
				publicKey: '',
					signature: '',
			});
			if (accumulated >= stake.amount) break;
		}
		if (accumulated < stake.amount) {
			return null; // insufficient funds to create stake block
		}

		const outputs: TxOutput[] = [
			{ address: stakeholderAddress, amount: 0n }, // marker output
			{ address: stakeholderAddress, amount: stake.amount },
		];
		// Add change if needed
		const change = accumulated - stake.amount;
		if (change > 0n) {
			outputs.push({ address: stakeholderAddress, amount: change });
		}

		const stakeTransaction = new Transaction(inputs, outputs);
		wallet.signTransaction(stakeTransaction);

		const transactions = [
			Transaction.coinbase(stakeholderAddress, POS_BLOCK_REWARD, this.chain.length),
			stakeTransaction,
			...this.pendingTransactions,
		];

		const block = new Block(
			Date.now(),
			transactions,
			this.getLatestBlock().hash,
			0,
			this.getRequiredBits(true),
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
		if (totalStake === 0n || stakeWeight === 0n) return false;

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
			(Blockchain.MAX_HASH * stakeWeight * BigInt(timeSinceLastBlock)) /
			(totalStake * BigInt(this.BLOCK_TIME));

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

	/** Earliest timestamp the next block may carry (strictly after the median time past). */
	public getNextBlockMinTimestamp(): number {
		return this.getMedianTimePast() + 1;
	}

	/**
	 * Compact target the next block must carry. With difficulty validation off (tests) any
	 * target is accepted, so templates use the easiest one and need no real mining.
	 */
	public getRequiredBits(proofOfStake = false): number {
		if (!this._options.validateDifficulty) return MAX_TARGET_BITS;
		return requiredBits(this.chain, this.chain.length, proofOfStake);
	}

	/** Unsolved PoW block on the current tip: coinbase to `rewardAddress` plus pending transactions. */
	public createBlockTemplate(rewardAddress: string, timestamp: number = Date.now()): Block {
		const coinbase = Transaction.coinbase(rewardAddress, POW_BLOCK_REWARD, this.chain.length, timestamp);
		const block = new Block(
			timestamp,
			[coinbase, ...this.pendingTransactions],
			this.getLatestBlock().hash,
			0,
			this.getRequiredBits(false),
			this.chain.length,
		);
		// The target follows the block's type; a pending stake tx makes it look like PoS (F-007)
		if (block.isProofOfStake()) {
			block.bits = this.getRequiredBits(true);
			block.hash = block.calculateHash();
		}
		return block;
	}

	public async minePendingTransactions(minerAddress: string, wallet?: Wallet): Promise<Block> {
		// Switch to PoS only after cutoff block has been added (length > POW_CUTOFF_BLOCK)
		const isPoSPhase = this.chain.length > POW_CUTOFF_BLOCK;

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
		const block = this.createBlockTemplate(minerAddress, timestamp);
		// A pending stake tx can make the block look like PoS (F-007); only PoW blocks need a nonce
		if (block.isProofOfWork()) block.solve();

		// Use common path for validation/persistence
		await this.addMinedBlock(block);
		return block;
	}

	private _addTransactionInternal(transaction: Transaction): void {
		if (transaction.inputs.length === 0 || transaction.outputs.length === 0) {
			throw new Error('Transaction must have inputs and outputs');
		}
		if (transaction.isCoinbase()) {
			throw new Error('coinbase transactions are only valid in blocks');
		}

		// Structural validation (signatures, duplicates, amounts, size limits)
		transaction.validate();

		for (const output of transaction.outputs) {
			if (!this.validateAddress(output.address)) {
				throw new Error('invalid output address');
			}
		}

		// Same input rules as block validation, at the next block's height
		this._checkInputs(
			transaction,
			(txHash, outputIndex) => this._utxos.get(txHash, outputIndex),
			this.chain.length,
		);

		for (const input of transaction.inputs) {
			if (this._pendingUTXOSpends.has(outpointKey(input.previousTx, input.outputIndex))) {
				throw new Error('utxo already spent by pending transaction');
			}
		}
		for (const input of transaction.inputs) {
			this._pendingUTXOSpends.add(outpointKey(input.previousTx, input.outputIndex));
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
		try {
			this._replayChain(this.chain);
			return true;
		} catch (error) {
			console.log(`[Blockchain] chain invalid: ${(error as Error).message}`);
			return false;
		}
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
				this._utxos = new UtxoSet();
				this._utxos.addOutputs(this.chain[0].transactions[0], 0);
				return;
			}

			// Revalidate the stored chain with the same rules as blocks from peers
			let state: ReturnType<Blockchain['_replayChain']>;
			try {
				state = this._replayChain(blocks);
			} catch (error) {
				throw new Error(`invalid stored chain: ${(error as Error).message}`);
			}

			this.chain = blocks;
			Blockchain.computeChainWeights(this.chain);
			this._utxos = state.utxos;
			this._stakes = state.stakes;
		} catch (error) {
			console.error('Error loading blockchain:', error);
			throw error;
		}
	}

	getMedianTimePast(): number {
		return this.getMedianTimePastForChain(this.chain, this.chain.length - 1);
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

	public async replaceChain(newChain: Block[]): Promise<void> {
		const release = await this._lock.acquire();
		try {
			// Compare by cumulative weight, not length
			Blockchain.computeChainWeights(newChain);
			const newWeight = newChain[newChain.length - 1].cumulativeWeight;
			if (newWeight <= this.getChainWeight()) {
				throw new Error('received chain does not have more weight than current chain');
			}

			let state: ReturnType<Blockchain['_replayChain']>;
			try {
				state = this._replayChain(newChain);
			} catch (error) {
				throw new Error(`Invalid chain: ${(error as Error).message}`);
			}

			const oldChain = this.chain;
			this.chain = newChain;
			this._utxos = state.utxos;
			this._stakes = state.stakes;

			// Re-admit pending transactions and those from orphaned blocks that are still
			// valid on the new chain (confirmed or conflicting ones are rejected)
			const forkIndex = oldChain.findIndex(
				(block, i) => i >= newChain.length || block.hash !== newChain[i].hash,
			);
			const orphaned =
				forkIndex > 0
					? oldChain
							.slice(forkIndex)
							.flatMap((block) => block.transactions)
							.filter((tx) => !tx.isCoinbase() && !tx.isCoinStake())
					: [];
			const candidates = [...this.pendingTransactions, ...orphaned];
			this.pendingTransactions = [];
			this._pendingUTXOSpends.clear();
			for (const tx of candidates) {
				try {
					this._addTransactionInternal(tx);
				} catch {
					// No longer valid on the new chain
				}
			}

			// Persist the new chain
			this.blockStore.replaceAll(this.chain);
		} finally {
			release();
		}
	}
}
