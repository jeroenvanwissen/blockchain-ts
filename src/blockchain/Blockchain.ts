import { Mutex } from 'async-mutex';
import { Block } from './Block.js';
import { NULL_HASH, Transaction, type TxInput, type TxOutput } from './Transaction.js';
import { Wallet } from './Wallet.js';
import { BlockStore } from './BlockStore.js';
import { addressFromPublicKey, isValidAddress } from './address.js';
import { outpointKey, UtxoSet, type UTXO } from './UtxoSet.js';
import { requiredBits } from './retarget.js';
import { minRelayFee } from './fees.js';
import { readChainstate, writeChainstate, type Chainstate } from './chainstate.js';
import * as path from 'path';
import { Mempool } from './Mempool.js';
import { bitsToTarget, MAX_TARGET_BITS, POW_LIMIT_BITS } from './target.js';
import {
	GENESIS_STAKE_MODIFIER,
	kernelHash,
	meetsKernelTarget,
	nextStakeModifier,
	stakeTieBreak,
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
	BLOCK_RESERVED_BYTES,
	CHAINSTATE_FILENAME,
	CHAINSTATE_INTERVAL,
	MAX_BLOCK_SIZE,
	MAX_BLOCK_TRANSACTIONS,
	MAX_MEMPOOL_BYTES,
	MAX_FUTURE_BLOCK_TIME,
	MAX_TRANSACTION_INPUTS,
	MAX_TRANSACTION_OUTPUTS,
	MIN_RELAY_FEE_PER_KB,
	SIGNATURE_CACHE_SIZE,
	STAKE_MIN_AGE,
	STAKE_MIN_CONFIRMATIONS,
	STAKE_TIMESTAMP_GRANULARITY,
} from '../config.js';
import { logger } from '../logger.js';

const log = logger('Blockchain');

export interface BlockchainOptions {
	/** Seconds a UTXO must exist before it can stake (default STAKE_MIN_AGE) */
	minStakeAge?: number;
	validateDifficulty?: boolean;
	validateTimestamps?: boolean;
	/** Last PoW height; PoS from the next block (default POW_CUTOFF_BLOCK) */
	powCutoffBlock?: number;
	/** Directory for blk*.dat and index.dat (defaults to BLOCKS_DIR from config) */
	blocksDir?: string;
	/** Mempool and wallet minimum fee in base units per 1000 bytes (default MIN_RELAY_FEE_PER_KB) */
	minRelayFeePerKb?: bigint;
	/** Mempool size limit in bytes (default MAX_MEMPOOL_BYTES) */
	maxMempoolBytes?: number;
	/** Start from the saved chainstate when it matches (default true; false: --reindex) */
	useChainstate?: boolean;
	/** Save the chainstate every this many connected blocks (default CHAINSTATE_INTERVAL) */
	chainstateInterval?: number;
}

/** What happened to a block passed to addMinedBlock. */
export type BlockOutcome = 'connected' | 'reorganized' | 'side';

/** A known block (active chain or side branch). */
interface IndexEntry {
	block: Block;
	height: number;
	work: bigint; // cumulative chain work up to and including this block
	isInvalid: boolean; // failed full validation; descendants are rejected
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
	private _index = new Map<string, IndexEntry>(); // every known block, by hash
	private _undo = new Map<string, UTXO[]>(); // per active block: the outputs it spent
	private _txIndex = new Map<string, string>(); // txid → hash of the active block that contains it
	private _mempool!: Mempool;
	// Witness hashes (data, keys and signatures) already verified, oldest first: signatures never
	// change, so revalidating the mempool on each new tip and connecting blocks of transactions
	// seen in the mempool skip the ECDSA checks
	private readonly _verifiedSignatures = new Set<string>();
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
			minRelayFeePerKb: MIN_RELAY_FEE_PER_KB,
			maxMempoolBytes: MAX_MEMPOOL_BYTES,
			useChainstate: true,
			chainstateInterval: CHAINSTATE_INTERVAL,
			...options,
		};
		this.blockStore = new BlockStore(this._options.blocksDir);
		const genesisBlock = this.createGenesisBlock();
		genesisBlock.cumulativeWeight = Blockchain.blockWeight(genesisBlock);
		this.chain = [genesisBlock];
		this._indexTransactions(genesisBlock, true);
		this._mempool = new Mempool(this._options.maxMempoolBytes);

		// Initialize UTXO set and block index with the genesis block
		this._utxos.addOutputs(genesisBlock.transactions[0], 0, genesisBlock.timestamp);
		this._index.set(genesisBlock.hash, {
			block: genesisBlock,
			height: 0,
			work: genesisBlock.cumulativeWeight,
			isInvalid: false,
		});

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

	/** Outputs of `address` a new transaction can spend now: mature and not claimed by the mempool. */
	public getSpendableUTXOs(address: string): UTXO[] {
		const height = this.chain.length;
		return this.getUTXOs(address).filter(
			(utxo) =>
				!this._mempool.isSpent(utxo.txHash, utxo.outputIndex) &&
				this._isMature(utxo, height),
		);
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
		if (coinbaseTx.inputs[0].outputIndex !== block.index) {
			throw new Error('coinbase height does not match block index');
		}
	}

	/** Structure and signatures; signatures verified before for these exact bytes are skipped. */
	private _validateTransaction(tx: Transaction): void {
		tx.validate(true); // structure first, so its errors come before any encoding error
		let key: string | undefined;
		try {
			key = tx.witnessHash();
		} catch {
			// Not encodable: verifySignatures reports it
		}
		if (key && this._verifiedSignatures.has(key)) return;
		tx.verifySignatures();
		if (!key) return;
		this._verifiedSignatures.add(key);
		if (this._verifiedSignatures.size > SIGNATURE_CACHE_SIZE) {
			this._verifiedSignatures.delete(this._verifiedSignatures.values().next().value as string);
		}
	}

	/** The coinbase pays exactly the block reward plus the fees of the block's transactions. */
	private static _checkCoinbaseReward(block: Block, fees: bigint): void {
		const reward = block.isProofOfStake() ? POS_BLOCK_REWARD : POW_BLOCK_REWARD;
		const paid = block.transactions[0].outputs[0].amount;
		if (paid !== reward + fees) {
			throw new Error(`invalid coinbase reward amount: expected ${reward + fees} (reward + fees), got ${paid}`);
		}
	}

	/**
	 * Inputs of a non-coinbase transaction against `lookup`: each must be unspent, owned by
	 * the signing key, and mature at `height`; inputs must cover outputs. Returns the fee
	 * (inputs − outputs).
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
			if (tx.timestamp < utxo.txTimestamp) {
				throw new Error('transaction timestamp is earlier than an output it spends');
			}
			inputSum += utxo.output.amount;
		}
		const outputSum = tx.outputs.reduce((sum, out) => sum + out.amount, 0n);
		if (inputSum < outputSum) {
			throw new Error('output amounts exceed input amounts');
		}
		return inputSum - outputSum;
	}

	/**
	 * The single block-validation path, used for new blocks, chain replacement and startup
	 * load. Validates `block` on top of `ctx` and, only if every check passes, applies it to
	 * ctx.utxos (nothing is changed when it throws). Returns the block's stake modifier and its
	 * undo data (the outputs it spent). Consensus checks read time
	 * from block data only; the wall clock is used only for the future-timestamp limit.
	 */
	private _connectBlock(block: Block, ctx: ConnectContext): { modifier: string; undo: UTXO[] } {
		const height = ctx.prevBlocks.length;
		const parent = ctx.prevBlocks[height - 1];

		// Structure and linkage (cheap checks first)
		if (block.transactions.length > MAX_BLOCK_TRANSACTIONS) {
			throw new Error('block exceeds maximum transaction count');
		}
		if (block.size() > MAX_BLOCK_SIZE) {
			throw new Error(`block exceeds maximum size of ${MAX_BLOCK_SIZE} bytes`);
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
		let fees = 0n;
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
				if (tx.timestamp > block.timestamp) {
					throw new Error('transaction timestamp is later than its block');
				}
				if (!tx.isCoinbase()) {
					this._validateTransaction(tx); // structure and signatures
					fees += this._checkInputs(tx, lookup, height);
					for (const input of tx.inputs) {
						spent.set(outpointKey(input.previousTx, input.outputIndex), [
							input.previousTx,
							input.outputIndex,
						]);
					}
				}
			} catch (error) {
				throw new Error(`transaction ${t}: ${(error as Error).message}`, { cause: error });
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
					blockTimestamp: block.timestamp,
				});
			});
		});

		Blockchain._checkCoinbaseReward(block, fees);

		// Every check passed: apply
		const undo: UTXO[] = [];
		for (const [key, [txHash, outputIndex]] of spent) {
			if (created.delete(key)) continue; // created and spent within this block
			const removed = ctx.utxos.remove(txHash, outputIndex);
			if (removed) undo.push(removed);
		}
		for (const utxo of created.values()) ctx.utxos.add(utxo);
		return { modifier: nextStakeModifier(proof, ctx.modifiers[height - 1]), undo };
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
		// Strictly after the parent: with the grid this allows at most one PoS block per slot
		if (block.timestamp <= ctx.prevBlocks[height - 1].timestamp) {
			throw new Error('PoS block timestamp must be later than its parent');
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
		// Age counts from the block that created the output: block times are bounded by consensus,
		// transaction times only by their creator (Peercoin/BlackCoin measure age the same way)
		if (block.timestamp - kernel.blockTimestamp < this._options.minStakeAge * 1000) {
			throw new Error('kernel input is too young to stake');
		}
		if (block.timestamp < kernel.txTimestamp) {
			throw new Error('coinstake timestamp is earlier than the kernel input');
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
		let isSigned: boolean;
		try {
			isSigned =
				/^[0-9a-f]{128}$/.test(block.signature) &&
				secp256k1.ecdsaVerify(
					Buffer.from(block.signature, 'hex'),
					Buffer.from(block.hash, 'hex'),
					Buffer.from(publicKey, 'hex'),
				);
		} catch {
			isSigned = false; // malformed signature or key bytes
		}
		if (!isSigned) {
			throw new Error('invalid block signature');
		}
		return hash;
	}

	/**
	 * Validate a whole chain from genesis through _connectBlock and return its state. A
	 * failure carries the failing height as `error.height`.
	 */
	/**
	 * Validate `blocks` (genesis first) into fresh state. With `start`, the state after block
	 * `start.height` is taken from a saved chainstate for that same block, and only the blocks
	 * after it are validated.
	 */
	private _replayChain(blocks: Block[], start?: Chainstate): { utxos: UtxoSet; modifiers: string[]; undo: UTXO[][] } {
		const genesis = this.createGenesisBlock();
		if (
			blocks.length === 0 ||
			blocks[0].hash !== genesis.hash ||
			blocks[0].calculateHash() !== genesis.hash
		) {
			throw new Error('genesis block hash mismatch');
		}
		if (start && blocks[start.height]?.hash !== start.tip) throw new Error('chainstate is not on this branch');
		const ctx: ConnectContext = {
			prevBlocks: blocks.slice(0, (start?.height ?? 0) + 1),
			utxos: new UtxoSet(),
			modifiers: start ? [...start.modifiers] : [GENESIS_STAKE_MODIFIER],
		};
		const undo: UTXO[][] = start ? start.undo.map((spent) => [...spent]) : [[]];
		if (start) for (const utxo of start.utxos) ctx.utxos.add(utxo);
		else ctx.utxos.addOutputs(blocks[0].transactions[0], 0, blocks[0].timestamp);
		for (let i = (start?.height ?? 0) + 1; i < blocks.length; i++) {
			try {
				const result = this._connectBlock(blocks[i], ctx);
				ctx.modifiers.push(result.modifier);
				undo.push(result.undo);
			} catch (error) {
				throw Object.assign(new Error(`block ${i}: ${(error as Error).message}`), { height: i });
			}
			ctx.prevBlocks.push(blocks[i]);
		}
		return { utxos: ctx.utxos, modifiers: ctx.modifiers, undo };
	}

	/** Fully validate `block` on top of the active tip and make it the new tip (no persistence). */
	private _connectTip(block: Block): void {
		const { modifier, undo } = this._connectBlock(block, {
			prevBlocks: this.chain,
			utxos: this._utxos,
			modifiers: this._modifiers,
		});
		block.cumulativeWeight = this.getLatestBlock().cumulativeWeight + Blockchain.blockWeight(block);
		this._modifiers.push(modifier);
		this._undo.set(block.hash, undo);
		this.chain.push(block);
		this._indexTransactions(block, true);
		this.lastBlockTime = block.timestamp;
		if (block.index % this._options.chainstateInterval === 0) this.saveChainstate();
	}

	private get _chainstatePath(): string {
		return path.join(this._options.blocksDir, CHAINSTATE_FILENAME);
	}

	/**
	 * Save the validated state at the tip (UTXO set, stake modifiers, undo data) so the next
	 * start validates only the blocks after it. Runs every `chainstateInterval` blocks and on
	 * shutdown; a failed save only costs a slower start.
	 */
	public saveChainstate(): void {
		try {
			writeChainstate(this._chainstatePath, {
				tip: this.getLatestBlock().hash,
				height: this.chain.length - 1,
				utxos: this._utxos.all(),
				modifiers: this._modifiers,
				undo: this.chain.map((block) => this._undo.get(block.hash) ?? []),
			});
		} catch (error) {
			log.warn('could not save the chainstate:', (error as Error).message);
		}
	}

	/** The saved chainstate, if any and readable (otherwise startup replays from genesis). */
	private _readChainstate(): Chainstate | undefined {
		if (!this._options.useChainstate) return undefined;
		try {
			return readChainstate(this._chainstatePath);
		} catch (error) {
			log.warn(`ignoring the saved chainstate: ${(error as Error).message}`);
			return undefined;
		}
	}

	/** Add a newly active block's transactions to the txid index, or remove a disconnected one's. */
	private _indexTransactions(block: Block, add: boolean): void {
		for (const tx of block.transactions) {
			const txid = tx.calculateHash();
			if (add) this._txIndex.set(txid, block.hash);
			else if (this._txIndex.get(txid) === block.hash) this._txIndex.delete(txid);
		}
	}

	/** Undo the active tip: remove the outputs it created and restore the ones it spent. */
	private _disconnectTip(): Block {
		const block = this.chain.pop()!;
		this._indexTransactions(block, false);
		this._modifiers.pop();
		for (const tx of block.transactions) {
			const txHash = tx.calculateHash();
			tx.outputs.forEach((output, outputIndex) => {
				if (output.amount > 0n) this._utxos.remove(txHash, outputIndex);
			});
		}
		for (const utxo of this._undo.get(block.hash) ?? []) this._utxos.add(utxo);
		this._undo.delete(block.hash);
		return block;
	}

	private _isActive(entry: IndexEntry): boolean {
		return this.chain[entry.height]?.hash === entry.block.hash;
	}

	/** Blocks from genesis up to and including `entry`, following parent links. */
	private _branchTo(entry: IndexEntry, index: Map<string, IndexEntry> = this._index): Block[] {
		const branch: Block[] = [];
		for (let e: IndexEntry | undefined = entry; e; e = index.get(e.block.previousHash)) {
			branch.unshift(e.block);
			if (e.height === 0) break;
		}
		return branch;
	}

	/** Whether `entry` or an ancestor below the fork with the active chain is invalid. */
	private _branchIsInvalid(entry: IndexEntry): boolean {
		for (let e: IndexEntry | undefined = entry; e && !this._isActive(e); e = this._index.get(e.block.previousHash)) {
			if (e.isInvalid) return true;
		}
		return false;
	}

	private _hasInvalidAncestor(entry: IndexEntry, index: Map<string, IndexEntry>): boolean {
		for (let e: IndexEntry | undefined = entry; e; e = index.get(e.block.previousHash)) {
			if (e.isInvalid) return true;
			if (e.height === 0) break;
		}
		return false;
	}

	/** Re-check pending transactions (plus `extra`, e.g. from disconnected blocks) against the tip. */
	private _readmitTransactions(extra: Transaction[] = []): void {
		const candidates = [...extra, ...this._mempool.transactions()];
		this._mempool.clear();
		for (const tx of candidates) {
			if (tx.isCoinbase() || tx.isCoinStake()) continue;
			try {
				this._addTransactionInternal(tx);
			} catch {
				// Confirmed, conflicting, or otherwise no longer valid
			}
		}
	}

	/**
	 * Make the branch ending at `target` (which has more work than the active chain) active:
	 * disconnect back to the fork point, then connect the branch with full validation. If a
	 * branch block is invalid it is marked so and the previous chain is restored.
	 */
	private _activateBranch(target: IndexEntry): void {
		const branch: Block[] = [];
		let fork: IndexEntry = target;
		while (!this._isActive(fork)) {
			branch.unshift(fork.block);
			fork = this._index.get(fork.block.previousHash)!;
		}

		const disconnected: Block[] = [];
		while (this.chain.length - 1 > fork.height) disconnected.unshift(this._disconnectTip());

		let connected = 0;
		try {
			for (const block of branch) {
				this._connectTip(block);
				connected++;
			}
		} catch (error) {
			const failed = branch[connected];
			this._index.get(failed.hash)!.isInvalid = true;
			for (let i = 0; i < connected; i++) this._disconnectTip();
			for (const block of disconnected) this._connectTip(block); // known valid
			const reason = (error as Error).message;
			throw new Error(failed === target.block ? reason : `block ${failed.index}: ${reason}`, { cause: error });
		}

		log.info(
			`reorganized at height ${fork.height}: ${disconnected.length} block(s) ` +
				`replaced by ${branch.length}, tip ${target.block.hash.slice(0, 16)}`,
		);
		this._readmitTransactions(disconnected.flatMap((block) => block.transactions));
	}

	/** Checks for a block stored on a side branch; full validation happens if it becomes active. */
	private _checkSideBlock(block: Block, parent: IndexEntry): void {
		const height = parent.height + 1;
		if (block.transactions.length > MAX_BLOCK_TRANSACTIONS) {
			throw new Error('block exceeds maximum transaction count');
		}
		if (block.size() > MAX_BLOCK_SIZE) {
			throw new Error(`block exceeds maximum size of ${MAX_BLOCK_SIZE} bytes`);
		}
		if (block.isProofOfWork() ? height > this._options.powCutoffBlock : height <= this._options.powCutoffBlock) {
			throw new Error('wrong consensus type for this height');
		}
		if (block.isProofOfWork() && !block.isValid()) {
			throw new Error('invalid proof of work');
		}
		if (this._options.validateDifficulty) {
			const branch = this._branchTo(parent);
			if (block.bits !== requiredBits(branch, height, block.isProofOfStake())) {
				throw new Error('incorrect block difficulty');
			}
		}
	}

	/**
	 * Accept a block whose parent is known: extend the tip, store it on a side branch, or
	 * reorganize to its branch when that has more work. Throws if the block is rejected.
	 */
	private _acceptBlock(block: Block): BlockOutcome {
		if (this._index.has(block.hash)) {
			throw new Error('block already known');
		}
		if (block.hash !== block.calculateHash()) {
			throw new Error('block hash mismatch');
		}
		const parent = this._index.get(block.previousHash);
		if (!parent) {
			throw new Error('unknown parent block');
		}
		if (this._branchIsInvalid(parent)) {
			throw new Error('parent block is invalid');
		}
		if (block.index !== parent.height + 1) {
			throw new Error(`incorrect block index: expected ${parent.height + 1}, got ${block.index}`);
		}

		if (block.previousHash === this.getLatestBlock().hash) {
			this._connectTip(block);
			this._index.set(block.hash, {
				block,
				height: block.index,
				work: block.cumulativeWeight,
				isInvalid: false,
			});
			this.blockStore.appendBlock(block);
			this._readmitTransactions();
			return 'connected';
		}

		this._checkSideBlock(block, parent);
		const entry: IndexEntry = {
			block,
			height: block.index,
			work: parent.work + Blockchain.blockWeight(block),
			isInvalid: false,
		};
		block.cumulativeWeight = entry.work;
		this._index.set(block.hash, entry);
		this.blockStore.appendBlock(block);
		const tip = this._index.get(this.getLatestBlock().hash)!;
		if (!Blockchain._isBetter(entry, tip)) {
			return 'side';
		}
		this._activateBranch(entry);
		return 'reorganized';
	}

	/**
	 * Fork choice: more chain work wins. Equal work goes to the lower tie-break value of the tip,
	 * so all nodes converge on the same branch (first-seen would leave simultaneous stakers
	 * split), and the block hash decides only between blocks with the same value.
	 */
	private static _isBetter(a: { work: bigint; block: Block }, b: { work: bigint; block: Block }): boolean {
		if (a.work !== b.work) return a.work > b.work;
		const [tieA, tieB] = [Blockchain._tieBreak(a.block), Blockchain._tieBreak(b.block)];
		if (tieA !== tieB) return tieA < tieB;
		return a.block.hash < b.block.hash;
	}

	/**
	 * A value the producer can't steer by choosing the block's contents. PoW: the block hash
	 * (the proof itself: a lower one costs more work). PoS: derived from the parent and the
	 * kernel outpoint only (stakeTieBreak); its hash could be ground by varying transactions.
	 */
	private static _tieBreak(block: Block): string {
		if (!block.isProofOfStake()) return block.hash;
		const kernel = block.transactions[1].inputs[0];
		return stakeTieBreak(block.previousHash, kernel.previousTx, kernel.outputIndex);
	}

	/** Whether a block with this hash is known (active chain or side branch). */
	public hasBlock(hash: string): boolean {
		return this._index.has(hash);
	}

	/** A known block by hash, with its height and whether it is on the active chain. */
	public getBlockByHash(hash: string): { block: Block; height: number; isActive: boolean } | undefined {
		const entry = this._index.get(hash);
		return entry && { block: entry.block, height: entry.height, isActive: this._isActive(entry) };
	}

	/** A transaction on the active chain (with its block) or in the mempool (block null). */
	public findTransaction(txid: string): { transaction: Transaction; block: Block | null } | undefined {
		const pending = this._mempool.get(txid);
		if (pending) return { transaction: pending.transaction, block: null };
		const blockHash = this._txIndex.get(txid);
		const block = blockHash === undefined ? undefined : this._index.get(blockHash)?.block;
		const transaction = block?.transactions.find((tx) => tx.calculateHash() === txid);
		return block && transaction ? { transaction, block } : undefined;
	}

	/**
	 * Block locator for sync: active-chain hashes from the tip back, one per block for the first
	 * ten, then exponentially sparser, ending with genesis.
	 */
	public getBlockLocator(): string[] {
		const hashes: string[] = [];
		let step = 1;
		for (let height = this.chain.length - 1; height > 0; height -= step) {
			hashes.push(this.chain[height].hash);
			if (hashes.length >= 10) step *= 2;
		}
		hashes.push(this.chain[0].hash);
		return hashes;
	}

	/**
	 * Active-chain blocks after the first locator hash found on the active chain (genesis if
	 * none), at most `max`.
	 */
	public getBlocksAfter(locator: string[], max: number): Block[] {
		let start = 1;
		for (const hash of locator) {
			const entry = this._index.get(hash);
			if (entry && this._isActive(entry)) {
				start = entry.height + 1;
				break;
			}
		}
		return this.chain.slice(start, start + max);
	}

	/** Add a block (mined, staked or received): extends the tip, a side branch, or reorganizes. */
	public async addMinedBlock(block: Block): Promise<BlockOutcome> {
		const release = await this._lock.acquire();
		try {
			return this._acceptBlock(block);
		} finally {
			release();
		}
	}

	private _clearPendingTransactionsInternal(): void {
		this._mempool.clear();
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

	public getBalance(address: string): bigint {
		return this.getUTXOs(address).reduce((sum, utxo) => sum + utxo.output.amount, 0n);
	}

	/** Single-recipient payment spending only `from`'s outputs, change back to it; see createPayment. */
	createTransaction(from: string, to: string, amount: bigint, wallet: Wallet): Transaction {
		if (!this.validateAddress(from)) {
			throw new Error('invalid sender address');
		}
		return this.buildPayment([from], from, [{ address: to, amount }], wallet).transaction;
	}

	/**
	 * Build and sign a payment from `wallet` to one or more outputs, paying the minimum relay
	 * fee for its size. Spendable outputs of all the wallet's addresses are taken largest first
	 * until they cover the amount plus fee; change goes to the wallet's primary address (no
	 * change output when nothing is left). The result still has to go through addTransaction.
	 */
	public createPayment(wallet: Wallet, payTo: TxOutput[]): { transaction: Transaction; fee: bigint } {
		return this.buildPayment(wallet.addresses(), wallet.address, payTo, wallet);
	}

	/** Unspent outputs of all `addresses` (a wallet's). */
	public getWalletUTXOs(addresses: readonly string[]): UTXO[] {
		return addresses.flatMap((address) => this.getUTXOs(address));
	}

	private buildPayment(
		from: readonly string[],
		changeAddress: string,
		payTo: TxOutput[],
		wallet: Wallet,
	): { transaction: Transaction; fee: bigint } {
		const maxRecipients = MAX_TRANSACTION_OUTPUTS - 1; // room for change
		if (payTo.length === 0 || payTo.length > maxRecipients) {
			throw new Error(`a payment needs 1 to ${maxRecipients} outputs`);
		}
		for (const output of payTo) {
			if (!this.validateAddress(output.address)) throw new Error('invalid recipient address');
			if (output.amount <= 0n) throw new Error('payment amounts must be positive');
		}
		const amount = payTo.reduce((sum, output) => sum + output.amount, 0n);
		const recipients = payTo.map((output) => ({ ...output }));
		const feeFor = (inputs: TxInput[], outputs: TxOutput[]) =>
			minRelayFee(Blockchain._draftSize(inputs, outputs), this._options.minRelayFeePerKb);

		const candidates = from
			.flatMap((address) => this.getSpendableUTXOs(address))
			.sort((a, b) => (a.output.amount === b.output.amount ? 0 : a.output.amount > b.output.amount ? -1 : 1));
		let inputSum = 0n;
		let timestamp = Date.now(); // never earlier than an output it spends (consensus)
		const inputs: TxInput[] = [];
		const owners: string[] = []; // the address whose key signs each input
		for (const utxo of candidates) {
			if (inputs.length === MAX_TRANSACTION_INPUTS) break;
			inputSum += utxo.output.amount;
			timestamp = Math.max(timestamp, utxo.txTimestamp);
			inputs.push({ previousTx: utxo.txHash, outputIndex: utxo.outputIndex, publicKey: '', signature: '' });
			owners.push(utxo.output.address);

			const changeOutput = { address: changeAddress, amount: 1n }; // amount doesn't affect the size
			const feeWithChange = feeFor(inputs, [...recipients, changeOutput]);
			let outputs: TxOutput[] | undefined;
			if (inputSum >= amount + feeWithChange) {
				const change = inputSum - amount - feeWithChange;
				outputs = change > 0n ? [...recipients, { address: changeAddress, amount: change }] : recipients;
			} else if (inputSum >= amount + feeFor(inputs, recipients)) {
				outputs = recipients; // what's left over is too little for a change output: it's fee
			}
			if (outputs) {
				const transaction = new Transaction(inputs, outputs, timestamp);
				wallet.signTransaction(transaction, 'spend', owners);
				const outputSum = outputs.reduce((sum, output) => sum + output.amount, 0n);
				return { transaction, fee: inputSum - outputSum };
			}
		}
		throw new Error(
			inputs.length === MAX_TRANSACTION_INPUTS
				? `payment needs more than ${MAX_TRANSACTION_INPUTS} inputs; send a smaller amount`
				: 'Insufficient funds (amount plus fee)',
		);
	}

	/** Size of a signed transaction with these inputs and outputs (witness lengths are fixed). */
	private static _draftSize(inputs: TxInput[], outputs: TxOutput[]): number {
		const witness = { publicKey: '02'.padEnd(66, '0'), signature: '0'.repeat(128) }; // 33 and 64 bytes
		return new Transaction(inputs.map((input) => ({ ...input, ...witness })), outputs).size();
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

	/**
	 * Pending transactions for a block at `timestamp`, highest fee rate first, within the block
	 * limits (`slots` transactions are taken by the coinbase and, for PoS, the coinstake). A
	 * transaction dated after the block waits for a later one.
	 */
	private _selectForBlock(slots: number, timestamp: number): { transactions: Transaction[]; fees: bigint } {
		const chosen = this._mempool.select(
			MAX_BLOCK_TRANSACTIONS - slots,
			MAX_BLOCK_SIZE - BLOCK_RESERVED_BYTES,
			(entry) => entry.transaction.timestamp <= timestamp,
		);
		return {
			transactions: chosen.map((entry) => entry.transaction),
			fees: chosen.reduce((total, entry) => total + entry.fee, 0n),
		};
	}

	/**
	 * Unsolved PoW block on the current tip: the best-paying pending transactions that fit,
	 * plus a coinbase to `rewardAddress` for the reward and their fees.
	 */
	public createBlockTemplate(rewardAddress: string, timestamp: number = Date.now()): Block {
		const { transactions, fees } = this._selectForBlock(1, timestamp);
		const coinbase = Transaction.coinbase(rewardAddress, POW_BLOCK_REWARD + fees, this.chain.length, timestamp);
		return new Block(
			timestamp,
			[coinbase, ...transactions],
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
	 * Try to stake the next block at `timestamp` with the outputs of any of the wallet's
	 * addresses. The timestamp must be on the STAKE_TIMESTAMP_GRANULARITY grid and after the
	 * tip's timestamp. Returns a block signed by the kernel output's key (the coinbase pays the
	 * reward plus fees to that address; the coinstake returns the kernel output to it unchanged),
	 * or null if no output's kernel meets the target.
	 */
	public createStakeBlock(wallet: Wallet, timestamp: number): Block | null {
		const height = this.chain.length;
		if (!this.isProofOfStakePhase()) return null;
		if (
			timestamp % STAKE_TIMESTAMP_GRANULARITY !== 0 ||
			timestamp <= this.getMedianTimePast() ||
			timestamp <= this.getLatestBlock().timestamp
		) {
			return null;
		}
		if (wallet.isLocked()) return null; // an encrypted wallet must be unlocked to stake
		const bits = this.getRequiredBits(true);
		const modifier = this._modifiers[height - 1];

		for (const utxo of this.getStakeableUTXOs(wallet.addresses(), timestamp)) {
			const hash = kernelHash(modifier, utxo.txTimestamp, utxo.txHash, utxo.outputIndex, timestamp);
			if (!meetsKernelTarget(hash, bits, utxo.output.amount)) continue;

			const staker = utxo.output.address;
			const coinstake = new Transaction(
				[{ previousTx: utxo.txHash, outputIndex: utxo.outputIndex, publicKey: '', signature: '' }],
				[
					{ address: staker, amount: 0n }, // coinstake marker
					{ address: staker, amount: utxo.output.amount },
				],
				timestamp,
			);
			wallet.signTransaction(coinstake, 'stake', [staker]);
			const { transactions, fees } = this._selectForBlock(2, timestamp);
			const block = new Block(
				timestamp,
				[Transaction.coinbase(staker, POS_BLOCK_REWARD + fees, height, timestamp), coinstake, ...transactions],
				this.getLatestBlock().hash,
				0,
				bits,
				height,
			);
			block.signature = wallet.signDigest(Buffer.from(block.hash, 'hex'), staker);
			return block;
		}
		return null;
	}

	/**
	 * Outputs of `addresses` (a wallet's) that may stake a block at `timestamp`: mature, with
	 * STAKE_MIN_CONFIRMATIONS, old enough by their block's time, and not claimed by the mempool.
	 * createStakeBlock and the staking status use the same rules.
	 */
	public getStakeableUTXOs(addresses: readonly string[], timestamp: number): UTXO[] {
		const height = this.chain.length;
		return this.getWalletUTXOs(addresses).filter(
			(utxo) =>
				!this._mempool.isSpent(utxo.txHash, utxo.outputIndex) &&
				this._isMature(utxo, height) &&
				height - utxo.blockIndex >= STAKE_MIN_CONFIRMATIONS &&
				timestamp - utxo.blockTimestamp >= this._options.minStakeAge * 1000 &&
				timestamp >= utxo.txTimestamp,
		);
	}

	/**
	 * Staking outlook for `addresses` at `timestamp`: their eligible outputs, the chance that one of
	 * them has a kernel meeting the current PoS target in a slot (each output: target × value /
	 * 2^256), and the expected time to find one. Ignores other stakers, who may win a slot first.
	 */
	public getStakingOutlook(
		addresses: readonly string[],
		timestamp: number,
	): { outputs: number; value: bigint; chancePerSlot: number; expectedSeconds: number | null } {
		const eligible = this.getStakeableUTXOs(addresses, timestamp);
		const value = eligible.reduce((total, utxo) => total + utxo.output.amount, 0n);
		if (!this.isProofOfStakePhase() || eligible.length === 0) {
			return { outputs: eligible.length, value, chancePerSlot: 0, expectedSeconds: null };
		}
		const target = bitsToTarget(this.getRequiredBits(true));
		const scale = 10n ** 15n;
		let miss = 1;
		for (const utxo of eligible) {
			const hit = Math.min(1, Number((target * utxo.output.amount * scale) >> 256n) / Number(scale));
			miss *= 1 - hit;
		}
		const chancePerSlot = 1 - miss;
		const expectedSeconds = chancePerSlot > 0 ? STAKE_TIMESTAMP_GRANULARITY / 1000 / chancePerSlot : null;
		return { outputs: eligible.length, value, chancePerSlot, expectedSeconds };
	}

	/** The newest block on the active chain staked by one of `addresses`, looking back at most `depth` blocks. */
	public findLastStakedBlock(addresses: readonly string[], depth = 10_000): Block | undefined {
		const stakers = new Set(addresses);
		for (let height = this.chain.length - 1; height > 0 && height >= this.chain.length - depth; height--) {
			const block = this.chain[height];
			if (block.isProofOfStake() && stakers.has(block.transactions[1].outputs[1]?.address)) return block;
		}
		return undefined;
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
		this._validateTransaction(transaction);

		for (const output of transaction.outputs) {
			if (!this.validateAddress(output.address)) {
				throw new Error('invalid output address');
			}
		}

		// Same input rules as block validation, at the next block's height
		const fee = this._checkInputs(
			transaction,
			(txHash, outputIndex) => this._utxos.get(txHash, outputIndex),
			this.chain.length,
		);
		// A transaction can't be in a block dated before it, so far-future ones would never confirm
		if (transaction.timestamp > Date.now() + MAX_FUTURE_BLOCK_TIME) {
			throw new Error('transaction timestamp too far in the future');
		}
		const minimum = minRelayFee(transaction.size(), this._options.minRelayFeePerKb);
		if (fee < minimum) {
			throw new Error(`fee ${fee} is below the minimum relay fee ${minimum} for ${transaction.size()} bytes`);
		}

		// Conflicts, duplicates and the size limit (may evict lower fee rates)
		const evicted = this._mempool.add({ transaction, txid: transaction.calculateHash(), fee, size: transaction.size() });
		if (evicted.length > 0) log.info(`mempool: evicted ${evicted.length} lower-fee transaction(s)`);
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
			log.warn(`chain invalid: ${(error as Error).message}`);
			return false;
		}
	}

	getChain(): Block[] {
		return this.chain;
	}

	/** Serialized size of all pending transactions (bounded by maxMempoolBytes). */
	getMempoolBytes(): number {
		return this._mempool.bytes;
	}

	getPendingTransactions(): Transaction[] {
		return this._mempool.transactions();
	}

	private loadBlockchain(): void {
		try {
			const stored = this.blockStore.loadAllBlocks();

			if (stored.length === 0) {
				// No stored blocks — persist genesis and return
				this.blockStore.appendBlock(this.chain[0]);
				return;
			}

			const genesis = this.createGenesisBlock();
			if (stored[0].hash !== genesis.hash || stored[0].calculateHash() !== genesis.hash) {
				throw new Error('invalid stored chain: genesis block hash mismatch');
			}

			// Rebuild the block tree; parents are always stored before their children
			const index = new Map<string, IndexEntry>();
			stored[0].cumulativeWeight = Blockchain.blockWeight(stored[0]);
			index.set(stored[0].hash, {
				block: stored[0],
				height: 0,
				work: stored[0].cumulativeWeight,
				isInvalid: false,
			});
			for (const block of stored.slice(1)) {
				const parent = index.get(block.previousHash);
				if (!parent || index.has(block.hash) || block.hash !== block.calculateHash()) {
					log.warn(`skipping unusable stored block ${block.hash.slice(0, 16)}`);
					continue;
				}
				const work = parent.work + Blockchain.blockWeight(block);
				block.cumulativeWeight = work;
				index.set(block.hash, { block, height: parent.height + 1, work, isInvalid: false });
			}

			// Activate the best valid branch (fork choice, as in _isBetter). Stored side blocks
			// were never fully validated, so fall back when a branch fails.
			const candidates = [...index.values()].sort((a, b) => (Blockchain._isBetter(a, b) ? -1 : 1));
			const saved = this._readChainstate();
			for (const candidate of candidates) {
				if (this._hasInvalidAncestor(candidate, index)) continue;
				const branch = this._branchTo(candidate, index);
				try {
					// The saved state stands for every block up to its tip: validate only the rest
					const start = saved && branch[saved.height]?.hash === saved.tip ? saved : undefined;
					const state = this._replayChain(branch, start);
					if (start) {
						log.info(`chainstate at height ${start.height}; validated ${branch.length - 1 - start.height} newer block(s)`);
					}
					this.chain = branch;
					this._txIndex = new Map();
					for (const block of branch) this._indexTransactions(block, true);
					this._utxos = state.utxos;
					this._modifiers = state.modifiers;
					this._undo = new Map(branch.map((block, i) => [block.hash, state.undo[i]]));
					this._index = index;
					return;
				} catch (error) {
					const height = (error as Error & { height?: number }).height ?? 0;
					index.get(branch[height].hash)!.isInvalid = true;
					log.warn(`invalid stored block: ${(error as Error).message}`);
				}
			}
		} catch (error) {
			log.error('Error loading blockchain:', error);
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

	/**
	 * Adopt `newChain` (genesis first) if it has more work: its blocks go through the same
	 * acceptance path as single blocks, so the node reorganizes to it or keeps its chain.
	 */
	public async replaceChain(newChain: Block[]): Promise<void> {
		const release = await this._lock.acquire();
		try {
			Blockchain.computeChainWeights(newChain);
			const newWeight = newChain[newChain.length - 1].cumulativeWeight;
			if (newWeight <= this.getChainWeight()) {
				throw new Error('received chain does not have more weight than current chain');
			}
			if (newChain[0].hash !== this.chain[0].hash) {
				throw new Error('Invalid chain: genesis block hash mismatch');
			}

			for (let i = 1; i < newChain.length; i++) {
				const block = newChain[i];
				try {
					if (block.index !== i) {
						throw new Error(`incorrect block index: expected ${i}, got ${block.index}`);
					}
					if (block.previousHash !== newChain[i - 1].hash) {
						throw new Error('broken link: previous hash does not match');
					}
					const known = this._index.get(block.hash);
					if (known?.isInvalid) throw new Error('block is known to be invalid');
					if (known) continue;
					this._acceptBlock(block);
				} catch (error) {
					throw new Error(`Invalid chain: block ${i}: ${(error as Error).message}`, { cause: error });
				}
			}
		} finally {
			release();
		}
	}
}
