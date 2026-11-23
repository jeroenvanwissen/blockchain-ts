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
} from '../config.js';

export interface BlockchainOptions {
	minStakeAge?: number;
	validateDifficulty?: boolean;
	validateTimestamps?: boolean;
	allowPowAfterCutoff?: boolean;
	/** Directory for blk*.dat and index.dat (defaults to BLOCKS_DIR from config) */
	blocksDir?: string;
}

/** Chain state a block is validated against; `utxos` advances as blocks connect. */
interface ConnectContext {
	prevBlocks: Block[]; // chain up to and including the parent block
	utxos: UtxoSet;
}

export class Blockchain {
	private _lock: Mutex = new Mutex();

	private chain: Block[];
	private _utxos = new UtxoSet();
	private _pendingUTXOSpends: Set<string> = new Set();
	private pendingTransactions: Transaction[];
	private lastBlockTime: number = Date.now();
	private blockStore: BlockStore;
	readonly BLOCK_TIME = BLOCK_TIME;
	private readonly _options: Required<BlockchainOptions>;

	constructor(options?: BlockchainOptions) {
		this._options = {
			minStakeAge: 86400,
			validateDifficulty: true,
			validateTimestamps: true,
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

	/**
	 * The single block-validation path, used for new blocks, chain replacement and startup
	 * load. Validates `block` on top of `ctx` and, only if every check passes, applies it to
	 * ctx.utxos (nothing is changed when it throws). Consensus checks read time
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
		} else {
			throw new Error('proof-of-stake blocks are not supported yet (TASK-0009)');
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

		// Every check passed: apply
		for (const [key, [txHash, outputIndex]] of spent) {
			if (!created.delete(key)) ctx.utxos.remove(txHash, outputIndex);
		}
		for (const utxo of created.values()) ctx.utxos.add(utxo);
	}

	/** Validate a whole chain from genesis through _connectBlock and return its state. */
	private _replayChain(blocks: Block[]): { utxos: UtxoSet } {
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
		return { utxos: ctx.utxos };
	}

	private _addMinedBlockInternal(block: Block): void {
		this._connectBlock(block, { prevBlocks: this.chain, utxos: this._utxos });

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

	/** Mine a PoW block in-process on the current tip (tests and tooling; the node uses Miner). */
	public async minePendingTransactions(minerAddress: string): Promise<Block> {
		// Date.now() so tests can control time
		const block = this.createBlockTemplate(minerAddress, Date.now());
		// A pending coinstake-shaped tx can make the block look like PoS (F-007); only PoW needs a nonce
		if (block.isProofOfWork()) block.solve();

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
