import { Mutex } from 'async-mutex';
import { Block } from './Block.js';
import { NULL_HASH, Transaction, type TxInput, type TxOutput } from './Transaction.js';
import { Wallet } from './Wallet.js';
import { BlockStore } from './BlockStore.js';
import { addressFromPublicKey, isValidAddress } from './address.js';
import { outpointKey, UtxoSet, type UTXO } from './UtxoSet.js';
import { requiredBits } from './retarget.js';
import { MAX_TARGET_BITS, POW_LIMIT_BITS } from './target.js';
import {
	GENESIS_STAKE_MODIFIER,
	kernelHash,
	meetsKernelTarget,
	nextStakeModifier,
} from './kernel.js';
import { secp256k1 } from './secp256k1.js';
import {
	BLOCKS_DIR,
	POW_CUTOFF_BLOCK,
	POS_BLOCK_REWARD,
	POW_BLOCK_REWARD,
	COIN_MATURITY,
	BLOCK_TIME,
	GENESIS_TIMESTAMP,
	MEDIAN_TIME_SPAN,
	MAX_BLOCK_TRANSACTIONS,
	MAX_FUTURE_BLOCK_TIME,
	STAKE_MIN_AGE,
	STAKE_MIN_CONFIRMATIONS,
	STAKE_TIMESTAMP_GRANULARITY,
} from '../config.js';

export interface BlockchainOptions {
	/** Seconds a UTXO must exist before it can stake (default STAKE_MIN_AGE) */
	minStakeAge?: number;
	validateDifficulty?: boolean;
	validateTimestamps?: boolean;
	/** Last PoW height; PoS from the next block (default POW_CUTOFF_BLOCK) */
	powCutoffBlock?: number;
	/** Directory for blk*.dat and index.dat (defaults to BLOCKS_DIR from config) */
	blocksDir?: string;
}

/** Chain state a block is validated against; `utxos` advances as blocks connect. */
interface ConnectContext {
	prevBlocks: Block[]; // chain up to and including the parent block
	utxos: UtxoSet;
	modifiers: string[]; // stake modifier after each block in prevBlocks
}

export class Blockchain {
	private _lock: Mutex = new Mutex();

	private chain: Block[];
	private _utxos = new UtxoSet();
	private _modifiers: string[] = [GENESIS_STAKE_MODIFIER]; // stake modifier after each block
	private _pendingUTXOSpends: Set<string> = new Set();
	private pendingTransactions: Transaction[];
	private lastBlockTime: number = Date.now();
	private blockStore: BlockStore;
	readonly BLOCK_TIME = BLOCK_TIME;
	private readonly _options: Required<BlockchainOptions>;

	constructor(options?: BlockchainOptions) {
		this._options = {
			minStakeAge: STAKE_MIN_AGE,
			validateDifficulty: true,
			validateTimestamps: true,
			powCutoffBlock: POW_CUTOFF_BLOCK,
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
		return this.chain.length <= this._options.powCutoffBlock;
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
			if (utxo.isCoinstake && height - utxo.blockIndex < COIN_MATURITY) {
				throw new Error('coinstake output has not reached maturity');
			}
			inputSum += utxo.output.amount;
		}
		const outputSum = tx.outputs.reduce((sum, out) => sum + out.amount, 0n);
		if (inputSum < outputSum) {
			throw new Error('output amounts exceed input amounts');
		}
		return inputSum;
	}

	/**
	 * The single block-validation path, used for new blocks, chain replacement and startup
	 * load. Validates `block` on top of `ctx` and, only if every check passes, applies it to
	 * ctx.utxos (nothing is changed when it throws) and returns the block's stake modifier. Consensus checks read time
	 * from block data only; the wall clock is used only for the future-timestamp limit.
	 */
	private _connectBlock(block: Block, ctx: ConnectContext): string {
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
		let proof = block.hash; // feeds the next stake modifier
		if (block.isProofOfWork()) {
			if (height > this._options.powCutoffBlock) {
				throw new Error(`PoW blocks no longer accepted after block ${this._options.powCutoffBlock}`);
			}
			if (block.signature) {
				throw new Error('PoW blocks must not carry a block signature');
			}
			if (!block.isValid()) {
				throw new Error('invalid proof of work');
			}
		} else {
			proof = this._checkProofOfStake(block, height, ctx);
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
				if (t >= 2 && tx.isCoinStake()) {
					throw new Error('coinstake is only valid as the second transaction of a PoS block');
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
			const isCoinstake = t === 1 && block.isProofOfStake();
			tx.outputs.forEach((output, outputIndex) => {
				if (output.amount === 0n) return; // e.g. the coinstake marker: nothing to spend
				created.set(outpointKey(txHash, outputIndex), {
					txHash,
					outputIndex,
					output,
					blockIndex: height,
					isCoinbase: tx.isCoinbase(),
					isCoinstake,
					txTimestamp: tx.timestamp,
				});
			});
		});

		// Every check passed: apply
		for (const [key, [txHash, outputIndex]] of spent) {
			if (!created.delete(key)) ctx.utxos.remove(txHash, outputIndex);
		}
		for (const utxo of created.values()) ctx.utxos.add(utxo);
		return nextStakeModifier(proof, ctx.modifiers[height - 1]);
	}

	/**
	 * Proof-of-stake rules for a block at `height`, against the UTXO set before the block.
	 * Returns the kernel hash (it feeds the next stake modifier).
	 */
	private _checkProofOfStake(block: Block, height: number, ctx: ConnectContext): string {
		if (height <= this._options.powCutoffBlock) {
			throw new Error(`PoS blocks not accepted before block ${this._options.powCutoffBlock + 1}`);
		}
		if (block.timestamp % STAKE_TIMESTAMP_GRANULARITY !== 0) {
			throw new Error(`PoS block timestamp must be a multiple of ${STAKE_TIMESTAMP_GRANULARITY} ms`);
		}
		const coinstake = block.transactions[1];
		if (coinstake.timestamp !== block.timestamp) {
			throw new Error('coinstake timestamp must equal the block timestamp');
		}

		const kernelInput = coinstake.inputs[0];
		const kernel = ctx.utxos.get(kernelInput.previousTx, kernelInput.outputIndex);
		if (!kernel) {
			throw new Error('kernel input is missing or spent');
		}
		const staker = kernel.output.address;
		if (coinstake.outputs[1].address !== staker) {
			throw new Error('coinstake must return the stake to the kernel owner');
		}
		if (height - kernel.blockIndex < STAKE_MIN_CONFIRMATIONS) {
			throw new Error('kernel input does not have enough confirmations');
		}
		if (
			block.timestamp < kernel.txTimestamp ||
			block.timestamp - kernel.txTimestamp < this._options.minStakeAge * 1000
		) {
			throw new Error('kernel input is too young to stake');
		}

		const hash = kernelHash(
			ctx.modifiers[height - 1],
			kernel.txTimestamp,
			kernelInput.previousTx,
			kernelInput.outputIndex,
			block.timestamp,
		);
		if (!meetsKernelTarget(hash, block.bits, kernel.output.amount)) {
			throw new Error('kernel does not meet the stake target');
		}

		// The block is signed by the staker: the kernel input's key, which must own the kernel
		const publicKey = kernelInput.publicKey;
		if (
			!/^[0-9a-f]{66}$/.test(publicKey) ||
			addressFromPublicKey(Buffer.from(publicKey, 'hex')) !== staker
		) {
			throw new Error('kernel input public key does not own the stake');
		}
		let isSigned = false;
		try {
			isSigned =
				/^[0-9a-f]{128}$/.test(block.signature) &&
				secp256k1.ecdsaVerify(
					Buffer.from(block.signature, 'hex'),
					Buffer.from(block.hash, 'hex'),
					Buffer.from(publicKey, 'hex'),
				);
		} catch {
			isSigned = false;
		}
		if (!isSigned) {
			throw new Error('invalid block signature');
		}
		return hash;
	}

	/** Validate a whole chain from genesis through _connectBlock and return its state. */
	private _replayChain(blocks: Block[]): { utxos: UtxoSet; modifiers: string[] } {
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
			modifiers: [GENESIS_STAKE_MODIFIER],
		};
		ctx.utxos.addOutputs(blocks[0].transactions[0], 0);
		for (let i = 1; i < blocks.length; i++) {
			try {
				ctx.modifiers.push(this._connectBlock(blocks[i], ctx));
			} catch (error) {
				throw new Error(`block ${i}: ${(error as Error).message}`);
			}
			ctx.prevBlocks.push(blocks[i]);
		}
		return { utxos: ctx.utxos, modifiers: ctx.modifiers };
	}

	private _addMinedBlockInternal(block: Block): void {
		const modifier = this._connectBlock(block, {
			prevBlocks: this.chain,
			utxos: this._utxos,
			modifiers: this._modifiers,
		});
		this._modifiers.push(modifier);

		block.cumulativeWeight = this.getLatestBlock().cumulativeWeight + Blockchain.blockWeight(block);
		this.chain.push(block);
		this.lastBlockTime = block.timestamp;
		this.pendingTransactions = [];
		this._pendingUTXOSpends.clear();

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
			// Skip immature coinbase and coinstake UTXOs
			if (!this._isMature(utxo, this.chain.length)) {
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
		return new Block(
			timestamp,
			[coinbase, ...this.pendingTransactions],
			this.getLatestBlock().hash,
			0,
			this.getRequiredBits(false),
			this.chain.length,
		);
	}

	private _isMature(utxo: UTXO, height: number): boolean {
		return !(utxo.isCoinbase || utxo.isCoinstake) || height - utxo.blockIndex >= COIN_MATURITY;
	}

	/** Whether the next block must be proof of stake. */
	public isProofOfStakePhase(): boolean {
		return this.chain.length > this._options.powCutoffBlock;
	}

	/**
	 * Try to stake the next block at `timestamp` with the wallet's outputs. The timestamp must
	 * be on the STAKE_TIMESTAMP_GRANULARITY grid and after the median time past. Returns a
	 * signed PoS block (coinbase pays the fixed reward to the staker; the coinstake returns
	 * the kernel output unchanged), or null if no output's kernel meets the target.
	 */
	public createStakeBlock(wallet: Wallet, timestamp: number): Block | null {
		const height = this.chain.length;
		if (!this.isProofOfStakePhase()) return null;
		if (timestamp % STAKE_TIMESTAMP_GRANULARITY !== 0 || timestamp <= this.getMedianTimePast()) {
			return null;
		}
		const bits = this.getRequiredBits(true);
		const modifier = this._modifiers[height - 1];

		for (const utxo of this.getUTXOs(wallet.address)) {
			if (this._pendingUTXOSpends.has(outpointKey(utxo.txHash, utxo.outputIndex))) continue;
			if (!this._isMature(utxo, height)) continue;
			if (height - utxo.blockIndex < STAKE_MIN_CONFIRMATIONS) continue;
			if (timestamp - utxo.txTimestamp < this._options.minStakeAge * 1000) continue;
			const hash = kernelHash(modifier, utxo.txTimestamp, utxo.txHash, utxo.outputIndex, timestamp);
			if (!meetsKernelTarget(hash, bits, utxo.output.amount)) continue;

			const coinstake = new Transaction(
				[{ previousTx: utxo.txHash, outputIndex: utxo.outputIndex, publicKey: '', signature: '' }],
				[
					{ address: wallet.address, amount: 0n }, // coinstake marker
					{ address: wallet.address, amount: utxo.output.amount },
				],
				timestamp,
			);
			wallet.signTransaction(coinstake);
			const block = new Block(
				timestamp,
				[
					Transaction.coinbase(wallet.address, POS_BLOCK_REWARD, height, timestamp),
					coinstake,
					...this.pendingTransactions,
				],
				this.getLatestBlock().hash,
				0,
				bits,
				height,
			);
			block.signature = wallet.signDigest(Buffer.from(block.hash, 'hex'));
			return block;
		}
		return null;
	}

	/** Current stake modifier (after the tip); exposed for tests and tooling. */
	public getStakeModifier(): string {
		return this._modifiers[this._modifiers.length - 1];
	}

	/** Mine a PoW block in-process on the current tip (tests and tooling; the node uses Miner). */
	public async minePendingTransactions(minerAddress: string): Promise<Block> {
		// Date.now() so tests can control time
		const block = this.createBlockTemplate(minerAddress, Date.now());
		block.solve();

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
		if (transaction.isCoinStake()) {
			throw new Error('coinstake transactions are only valid in blocks');
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
				this._modifiers = [GENESIS_STAKE_MODIFIER];
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
			this._modifiers = state.modifiers;
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
			this._modifiers = state.modifiers;

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
