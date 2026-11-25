import { Mutex } from 'async-mutex';
import { Block } from './Block.js';
import { NULL_HASH, Transaction, type TxInput, type TxOutput } from './Transaction.js';
import { Wallet } from './Wallet.js';
import { BlockStore } from './BlockStore.js';
import { addressFromPublicKey, isValidAddress } from './address.js';
import { outpointKey, UtxoSet, type UTXO } from './UtxoSet.js';
import { addressFlows, mergeHistories, type AddressActivity } from './AddressIndex.js';
import { requiredBits } from './retarget.js';
import { minRelayFee } from './fees.js';
import { BlockStatus, CHAIN_DB_VERSION, ChainDb, type BlockRecord, type ChainRules } from './ChainDb.js';
import { readMempoolFile, writeMempoolFile } from './mempoolFile.js';
import * as fs from 'fs';
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
	CHAIN_DB_BATCH_BLOCKS,
	CHAIN_DB_FILENAME,
	MEMPOOL_FILENAME,
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
	/** Rebuild the chain database from the stored blocks, validating every block (--reindex) */
	reindex?: boolean;
	/** The chain database (default chain.db in blocksDir; ':memory:' for unit tests that mock fs) */
	dbPath?: string;
}

/** Writing or reading a block or its state failed (disk full, I/O): the block itself may be fine. */
export class StorageError extends Error {}

/** Run a write to the block files or the chain database; a failure becomes a StorageError. */
function storing<T>(what: string, write: () => T): T {
	try {
		return write();
	} catch (error) {
		throw new StorageError(`${what}: ${(error as Error).message}`, { cause: error });
	}
}

/** What happened to a block passed to addMinedBlock. */
export type BlockOutcome = 'connected' | 'reorganized' | 'side';

/** The header data validation and fork choice read from earlier blocks (a Block or a ChainEntry). */
export type BlockHeader = Pick<Block, 'hash' | 'timestamp' | 'bits' | 'isProofOfStake'>;

/**
 * A known block (active chain or side branch) in the in-memory block tree: its header data and
 * place in the tree, not its transactions, which stay in the block files (TASK-0053).
 */
export class ChainEntry {
	isInvalid = false; // failed full validation; descendants are rejected

	constructor(
		readonly hash: string,
		readonly previousHash: string,
		readonly height: number,
		readonly timestamp: number,
		readonly bits: number,
		private readonly _proofOfStake: boolean,
		readonly work: bigint, // cumulative chain work up to and including this block
		readonly tieBreak: string, // fork choice between equal work (Blockchain._tieBreak)
	) {}

	isProofOfStake(): boolean {
		return this._proofOfStake;
	}

	isProofOfWork(): boolean {
		return !this._proofOfStake;
	}

	/** The entry for `block`, whose parent's entry is `parent` (none for genesis). */
	static of(block: Block, parent: ChainEntry | undefined): ChainEntry {
		const work = (parent?.work ?? 0n) + block.work();
		const tieBreak = Blockchain.tieBreak(block);
		return new ChainEntry(
			block.hash,
			parent?.hash ?? block.previousHash, // the parent's string: one copy per hash in memory
			block.index,
			block.timestamp,
			block.bits,
			block.isProofOfStake(),
			work,
			tieBreak === block.hash ? block.hash : tieBreak,
		);
	}
}

/** Chain state a block is validated against; `utxos` advances as blocks connect. */
interface ConnectContext {
	prevBlocks: readonly BlockHeader[]; // chain up to and including the parent block
	utxos: UtxoSet;
	modifiers: string[]; // stake modifier after each block in prevBlocks
}

export class Blockchain {
	private _lock: Mutex = new Mutex();

	private chain: ChainEntry[]; // the active chain, genesis first
	private _tipBlock: Block; // the active tip with its transactions (the others are read from disk)
	private _utxos = new UtxoSet();
	private _modifiers: string[] = [GENESIS_STAKE_MODIFIER]; // stake modifier after each block
	private _index = new Map<string, ChainEntry>(); // every known block, by hash
	// The state of the active chain on disk (TASK-0053): the UTXO set, undo data, stake modifiers,
	// the txid index and address histories, written as each block connects or disconnects
	private _db: ChainDb;
	// The open write batch (TASK-0054): its database writes are one transaction. `writes` counts
	// the blocks written since the last commit, `added` the tree entries they added.
	private _batch: { writes: number; added: string[] } | null = null;
	private _connectedAtStartup = 0;
	private _mempool!: Mempool;
	// Witness hashes (data, keys and signatures) already verified, oldest first: signatures never
	// change, so revalidating the mempool on each new tip and connecting blocks of transactions
	// seen in the mempool skip the ECDSA checks
	private readonly _verifiedSignatures = new Set<string>();
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
			reindex: false,
			dbPath: path.join(options?.blocksDir ?? BLOCKS_DIR, CHAIN_DB_FILENAME),
			...options,
		};
		this.blockStore = new BlockStore(this._options.blocksDir);
		this._db = this._openDb();
		const genesisBlock = this.createGenesisBlock();
		const genesis = ChainEntry.of(genesisBlock, undefined);
		genesisBlock.cumulativeWeight = genesis.work;
		this.chain = [genesis];
		this._tipBlock = genesisBlock;
		this._mempool = new Mempool(this._options.maxMempoolBytes);

		// Initialize UTXO set and block index with the genesis block
		this._utxos.addOutputs(genesisBlock.transactions[0], 0, genesisBlock.timestamp);
		this._index.set(genesis.hash, genesis);

		// Load the rest of the blockchain, then the transactions that were pending at shutdown
		try {
			this.loadBlockchain();
		} catch (error) {
			this._db.close(); // nobody else can: the constructor throws
			throw error;
		}
		this._loadMempool();
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
		return this._tip.work;
	}

	private get _tip(): ChainEntry {
		return this.chain[this.chain.length - 1];
	}

	/** Height of the active tip. */
	public getHeight(): number {
		return this.chain.length - 1;
	}

	/** Header data of the active block at `height`. */
	public getHeader(height: number): ChainEntry | undefined {
		return this.chain[height];
	}

	/** The active block at `height`, read from the block files. */
	public getBlockAt(height: number): Block | undefined {
		const entry = this.chain[height];
		return entry && this._readBlock(entry);
	}

	/** A stored block with its transactions; its cumulative work comes from its entry. */
	private _readBlock(entry: ChainEntry): Block {
		if (entry.hash === this._tipBlock.hash) return this._tipBlock;
		const block = this.blockStore.getBlock(entry.hash);
		if (!block) throw new StorageError(`block ${entry.height} (${entry.hash.slice(0, 16)}) is missing from the block files`);
		block.cumulativeWeight = entry.work;
		return block;
	}

	public getUTXOs(address: string): UTXO[] {
		return this._utxos.forAddress(address);
	}

	/** The address's transactions on the active chain, oldest first, with its balance after each. */
	public getAddressHistory(address: string): readonly AddressActivity[] {
		return this._db.history(address);
	}

	/** Whether the address has a transaction on the active chain. */
	public hasAddressHistory(address: string): boolean {
		return this._db.hasHistory(address);
	}

	/**
	 * The combined history of `addresses` (a wallet's): one entry per transaction, oldest first,
	 * with what it received and sent over all of them and their total balance after it.
	 */
	public getWalletHistory(addresses: readonly string[]): AddressActivity[] {
		return mergeHistories([...new Set(addresses)].map((address) => this._db.history(address)));
	}

	/**
	 * Pending transactions that pay any of `addresses` or spend their outputs, with what each
	 * moves to and from them in total.
	 */
	public getPendingActivity(addresses: readonly string[]): { txid: string; received: bigint; sent: bigint }[] {
		const watched = new Set(addresses);
		const activity: { txid: string; received: bigint; sent: bigint }[] = [];
		for (const tx of this.getPendingTransactions()) {
			let received = 0n;
			let sent = 0n;
			for (const output of tx.outputs) if (watched.has(output.address)) received += output.amount;
			for (const input of tx.inputs) {
				const utxo = this._utxos.get(input.previousTx, input.outputIndex); // pending inputs are confirmed outputs
				if (utxo && watched.has(utxo.output.address)) sent += utxo.output.amount;
			}
			if (received > 0n || sent > 0n) activity.push({ txid: tx.calculateHash(), received, sent });
		}
		return activity;
	}

	/** The unspent output at an outpoint, if it is unspent on the active chain. */
	public getUTXO(txid: string, outputIndex: number): UTXO | undefined {
		return this._utxos.get(txid, outputIndex);
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
	 * ctx.utxos (nothing is changed when it throws). Returns the block's stake modifier, its
	 * undo data (the outputs it spent) and the outputs it added. Consensus checks read time
	 * from block data only; the wall clock is used only for the future-timestamp limit.
	 */
	private _connectBlock(block: Block, ctx: ConnectContext): { modifier: string; undo: UTXO[]; created: UTXO[] } {
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
		const added = [...created.values()];
		for (const utxo of added) ctx.utxos.add(utxo);
		return { modifier: nextStakeModifier(proof, ctx.modifiers[height - 1]), undo, created: added };
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
	 * Validate `blocks` (genesis first) through _connectBlock into fresh state, touching neither
	 * the node's state nor the database. A failure carries the failing height as `error.height`.
	 */
	private _replayChain(blocks: Block[]): { utxos: UtxoSet; modifiers: string[]; undo: UTXO[][] } {
		const genesis = this.createGenesisBlock();
		if (
			blocks.length === 0 ||
			blocks[0].hash !== genesis.hash ||
			blocks[0].calculateHash() !== genesis.hash
		) {
			throw new Error('genesis block hash mismatch');
		}
		const prevBlocks = blocks.slice(0, 1);
		const ctx: ConnectContext = { prevBlocks, utxos: new UtxoSet(), modifiers: [GENESIS_STAKE_MODIFIER] };
		const undo: UTXO[][] = [[]];
		ctx.utxos.addOutputs(blocks[0].transactions[0], 0, blocks[0].timestamp);
		for (let i = 1; i < blocks.length; i++) {
			try {
				const result = this._connectBlock(blocks[i], ctx);
				ctx.modifiers.push(result.modifier);
				undo.push(result.undo);
			} catch (error) {
				throw Object.assign(new Error(`block ${i}: ${(error as Error).message}`), { height: i });
			}
			prevBlocks.push(blocks[i]);
		}
		return { utxos: ctx.utxos, modifiers: ctx.modifiers, undo };
	}

	/**
	 * Fully validate `block` on top of the active tip and make it the new tip: in memory, then in
	 * the chain database (part of the open write batch). With `store`, a new block is first
	 * appended to the block files (blocks of a branch being activated were stored when they
	 * arrived). If storing or writing fails, a StorageError is thrown and the batch puts the
	 * in-memory state back (`_writeBatch`).
	 */
	private _connectTip(block: Block, entry: ChainEntry, store = false): void {
		const height = this.chain.length;
		const { modifier, undo, created } = this._connectBlock(block, {
			prevBlocks: this.chain,
			utxos: this._utxos,
			modifiers: this._modifiers,
		});
		storing(`could not store block ${block.index}`, () => {
			if (store) {
				this.blockStore.appendBlock(block);
				this._db.addBlock(this._record(block, entry.work));
			}
			const txids = block.transactions.map((tx) => tx.calculateHash());
			this._db.connect({ hash: block.hash, height, modifier, spent: undo, created, txids, flows: addressFlows(block, undo, txids) });
		});
		block.cumulativeWeight = entry.work;
		this._modifiers.push(modifier);
		this.chain.push(entry);
		this._tipBlock = block;
		this._connectedAtStartup++;
		this._wrote();
	}

	/**
	 * Run `work` (accepting or activating blocks) with its chain-database writes in one
	 * transaction (TASK-0054), committed when it ends and after every CHAIN_DB_BATCH_BLOCKS
	 * blocks written, so a run of blocks pays for one commit instead of one per block. A rejected
	 * block ends the batch normally: the blocks before it stay. A StorageError (a failed write,
	 * read or commit) rolls back what wasn't committed and puts the in-memory state back to the
	 * database's, so the two never differ.
	 */
	private _writeBatch<T>(work: () => T): T {
		if (this._batch) return work(); // part of the open batch
		this._batch = { writes: 0, added: [] };
		try {
			storing('could not write the chain database', () => this._db.begin());
			let result: T;
			try {
				result = work();
			} catch (error) {
				if (!(error instanceof StorageError)) this._commit(); // a rejected block: keep what came before it
				throw error;
			}
			this._commit();
			return result;
		} catch (error) {
			if (error instanceof StorageError) {
				this._db.rollback();
				this._restoreFromDb();
			}
			throw error;
		} finally {
			this._batch = null;
		}
	}

	/** Count a block written in the open batch, and commit the batch every CHAIN_DB_BATCH_BLOCKS. */
	private _wrote(): void {
		if (this._batch && ++this._batch.writes >= CHAIN_DB_BATCH_BLOCKS) this._commit(true);
	}

	/** Commit the open batch (and, with `reopen`, go on in a new transaction). */
	private _commit(reopen = false): void {
		storing('could not write the chain database', () => {
			this._db.commit();
			if (reopen) this._db.begin();
		});
		this._batch!.writes = 0;
		this._batch!.added = [];
	}

	/** Add a block to the tree; it is forgotten again if the batch that recorded it is rolled back. */
	private _addEntry(entry: ChainEntry): void {
		this._index.set(entry.hash, entry);
		this._batch?.added.push(entry.hash);
	}

	/**
	 * After a rolled-back batch: forget the blocks it added to the tree (they stay in the block
	 * files, and the next start records them again), and take the active chain, UTXO set and stake
	 * modifiers from the database again.
	 */
	private _restoreFromDb(): void {
		for (const hash of this._batch!.added) this._index.delete(hash);
		const tip = this._db.tip();
		const entry = tip && this._index.get(tip.hash);
		if (!entry) return; // a rebuild that failed before its first commit: the start fails
		this._takeDbState(entry);
		this._readmitTransactions();
	}

	/** Make the database's active chain, ending at `tip`, the in-memory state. */
	private _takeDbState(tip: ChainEntry): void {
		this.chain = this._branchTo(tip);
		this._modifiers = this._db.activeModifiers();
		this._utxos = new UtxoSet();
		for (const utxo of this._db.loadUtxos()) this._utxos.add(utxo);
		this._tipBlock = this._readBlock(tip);
	}

	/** The database's record of a block (its status starts as Stored). */
	private _record(block: Block, work: bigint): BlockRecord {
		const producer = block.isProofOfStake() ? block.transactions[1]?.outputs[1] : block.transactions[0]?.outputs[0];
		return {
			hash: block.hash,
			height: block.index,
			previousHash: block.previousHash,
			timestamp: block.timestamp,
			bits: block.bits,
			isProofOfStake: block.isProofOfStake(),
			work,
			tieBreak: Blockchain.tieBreak(block),
			producer: producer?.address ?? '',
			txCount: block.transactions.length,
			size: block.size(),
			status: BlockStatus.Stored,
			modifier: null,
		};
	}

	/**
	 * Open the chain database. An unreadable file (damaged, not a database) is removed and a new
	 * one made: it holds only what can be rebuilt from the block files.
	 */
	private _openDb(): ChainDb {
		const file = this._options.dbPath;
		if (file === ':memory:') return new ChainDb(file);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		try {
			const db = new ChainDb(file);
			db.describe();
			return db;
		} catch (error) {
			log.warn(`the chain database is unreadable (${(error as Error).message}); making a new one`);
			for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
			return new ChainDb(file);
		}
	}

	/** Close the chain database (at shutdown). Nothing is lost: each block was written as it connected. */
	public close(): void {
		this._db.close();
	}

	private get _mempoolPath(): string {
		return path.join(this._options.blocksDir, MEMPOOL_FILENAME);
	}

	/**
	 * Save the pending transactions so the next start re-admits them: at shutdown, and after each
	 * payment from the node's wallet so it survives a crash too. Returns how many were saved, or
	 * null if the save failed (logged); a failed save only loses them, the coins stay spendable.
	 */
	public saveMempool(): number | null {
		try {
			const transactions = this._mempool.transactions();
			writeMempoolFile(this._mempoolPath, transactions);
			return transactions.length;
		} catch (error) {
			log.warn('could not save the mempool:', (error as Error).message);
			return null;
		}
	}

	/**
	 * Re-admit the transactions saved at the last shutdown, in their arrival order, with the
	 * usual checks: those confirmed, conflicting or otherwise invalid by now are dropped.
	 */
	private _loadMempool(): void {
		let saved: Transaction[];
		try {
			saved = readMempoolFile(this._mempoolPath);
		} catch (error) {
			log.warn(`ignoring the saved mempool: ${(error as Error).message}`);
			return;
		}
		let admitted = 0;
		for (const tx of saved) {
			try {
				this._addTransactionInternal(tx);
				admitted++;
			} catch (error) {
				log.debug(`dropped saved transaction ${tx.calculateHash().slice(0, 16)}: ${(error as Error).message}`);
			}
		}
		if (saved.length === 0) return;
		const dropped = saved.length - admitted;
		log.info(`Mempool loaded: ${admitted} pending transaction(s)${dropped > 0 ? `, ${dropped} no longer valid` : ''}`);
	}

	private get _rules(): ChainRules {
		return { powCutoffBlock: this._options.powCutoffBlock, minStakeAge: this._options.minStakeAge };
	}

	/** Undo the active tip: remove the outputs it created and restore the ones it spent. */
	private _disconnectTip(): Block {
		const block = this.getLatestBlock();
		const created: { txHash: string; outputIndex: number }[] = [];
		for (const tx of block.transactions) {
			const txHash = tx.calculateHash();
			tx.outputs.forEach((output, outputIndex) => {
				if (output.amount > 0n) created.push({ txHash, outputIndex });
			});
		}
		const parent = this._readBlock(this.chain[this.chain.length - 2]);
		const spent = storing(`could not disconnect block ${block.index}`, () => this._db.disconnect(block.hash, this.chain.length - 1, created));
		this.chain.pop();
		this._modifiers.pop();
		this._tipBlock = parent;
		for (const { txHash, outputIndex } of created) this._utxos.remove(txHash, outputIndex);
		for (const utxo of spent) this._utxos.add(utxo);
		this._wrote();
		return block;
	}

	private _isActive(entry: ChainEntry): boolean {
		return this.chain[entry.height] === entry;
	}

	/** Entries from genesis up to and including `entry`, following parent links. */
	private _branchTo(entry: ChainEntry, index: Map<string, ChainEntry> = this._index): ChainEntry[] {
		const branch: ChainEntry[] = [];
		for (let e: ChainEntry | undefined = entry; e; e = index.get(e.previousHash)) {
			branch.push(e);
			if (e.height === 0) break;
		}
		return branch.reverse();
	}

	/** Whether `entry` or an ancestor below the fork with the active chain is invalid. */
	private _branchIsInvalid(entry: ChainEntry): boolean {
		for (let e: ChainEntry | undefined = entry; e && !this._isActive(e); e = this._index.get(e.previousHash)) {
			if (e.isInvalid) return true;
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
	 * branch block is invalid it is marked so (in the database too), and the valid part before
	 * it stays active if it beats the chain it replaced; otherwise the previous chain is restored.
	 * A StorageError goes straight up: the write batch puts the state back.
	 */
	private _activateBranch(target: ChainEntry): void {
		const branch: ChainEntry[] = [];
		let fork: ChainEntry = target;
		while (!this._isActive(fork)) {
			branch.push(fork);
			fork = this._index.get(fork.previousHash)!;
		}
		branch.reverse();

		const disconnected: Block[] = [];
		while (this.chain.length - 1 > fork.height) disconnected.unshift(this._disconnectTip());

		let connected = 0;
		try {
			for (const entry of branch) {
				this._connectTip(this._readBlock(entry), entry);
				connected++;
			}
		} catch (error) {
			if (error instanceof StorageError) throw error;
			const failed = branch[connected];
			failed.isInvalid = true;
			storing(`could not mark block ${failed.height} invalid`, () => this._db.markInvalid(failed.hash));
			// The valid part of the branch stays if it beats the chain it replaced (fork choice)
			const replaced = disconnected.length > 0 ? this._index.get(disconnected[disconnected.length - 1].hash)! : fork;
			if (connected > 0 && Blockchain._isBetter(this._tip, replaced)) {
				this._reorganized(fork, disconnected, connected, this._tip);
			} else {
				for (let i = 0; i < connected; i++) this._disconnectTip();
				for (const block of disconnected) this._connectTip(block, this._index.get(block.hash)!); // known valid
			}
			const reason = (error as Error).message;
			throw Object.assign(new Error(failed === target ? reason : `block ${failed.height}: ${reason}`, { cause: error }), {
				height: failed.height,
				reason,
			});
		}
		this._reorganized(fork, disconnected, branch.length, target);
	}

	/** After a branch became active: log a reorganization, re-admit the disconnected transactions. */
	private _reorganized(fork: ChainEntry, disconnected: Block[], connected: number, tip: ChainEntry): void {
		if (disconnected.length > 0) {
			log.info(
				`reorganized at height ${fork.height}: ${disconnected.length} block(s) ` +
					`replaced by ${connected}, tip ${tip.hash.slice(0, 16)}`,
			);
		}
		this._readmitTransactions(disconnected.flatMap((block) => block.transactions));
	}

	/** Checks for a block stored on a side branch; full validation happens if it becomes active. */
	private _checkSideBlock(block: Block, parent: ChainEntry): void {
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

		const entry = ChainEntry.of(block, parent);
		if (parent === this._tip) {
			this._connectTip(block, entry, true);
			this._addEntry(entry);
			this._readmitTransactions();
			return 'connected';
		}

		this._checkSideBlock(block, parent);
		block.cumulativeWeight = entry.work;
		storing(`could not store block ${block.index}`, () => {
			this.blockStore.appendBlock(block);
			this._db.addBlock(this._record(block, entry.work));
		});
		this._addEntry(entry);
		this._wrote();
		if (!Blockchain._isBetter(entry, this._tip)) {
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
	private static _isBetter(a: ChainEntry, b: ChainEntry): boolean {
		if (a.work !== b.work) return a.work > b.work;
		if (a.tieBreak !== b.tieBreak) return a.tieBreak < b.tieBreak;
		return a.hash < b.hash;
	}

	/**
	 * A value the producer can't steer by choosing the block's contents. PoW: the block hash
	 * (the proof itself: a lower one costs more work). PoS: derived from the parent and the
	 * kernel outpoint only (stakeTieBreak); its hash could be ground by varying transactions.
	 */
	static tieBreak(block: Block): string {
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
		return entry && { block: this._readBlock(entry), height: entry.height, isActive: this._isActive(entry) };
	}

	/** A pending transaction by txid. */
	public getPendingTransaction(txid: string): Transaction | undefined {
		return this._mempool.get(txid)?.transaction;
	}

	/** Whether a transaction is in the mempool or on the active chain (no block is read). */
	public hasTransaction(txid: string): boolean {
		return this._mempool.get(txid) !== undefined || this._db.findTransaction(txid) !== undefined;
	}

	/** A transaction on the active chain (with its block) or in the mempool (block null). */
	public findTransaction(txid: string): { transaction: Transaction; block: Block | null } | undefined {
		const pending = this._mempool.get(txid);
		if (pending) return { transaction: pending.transaction, block: null };
		const location = this._db.findTransaction(txid);
		if (!location) return undefined;
		const block = this.getBlockAt(location.height);
		const transaction = block?.transactions[location.position];
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
		return this.chain.slice(start, start + max).map((entry) => this._readBlock(entry));
	}

	/**
	 * Add a block (mined, staked or received): extends the tip, a side branch, or reorganizes.
	 * Its database writes, a reorg's included, are one transaction.
	 */
	public async addMinedBlock(block: Block): Promise<BlockOutcome> {
		const release = await this._lock.acquire();
		try {
			return this._writeBatch(() => this._acceptBlock(block));
		} finally {
			release();
		}
	}

	/**
	 * Add a run of blocks (a sync batch from a peer) in order, under one lock and one database
	 * transaction (TASK-0054), until one is rejected: the blocks before it stay. Known blocks are
	 * skipped. Returns how many were added and the rejection; a StorageError is thrown (nothing of
	 * the run is kept then).
	 */
	public async addBlocks(blocks: readonly Block[]): Promise<{ added: number; rejected?: Error }> {
		const release = await this._lock.acquire();
		try {
			let added = 0;
			let rejected: Error | undefined;
			this._writeBatch(() => {
				for (const block of blocks) {
					if (this._index.has(block.hash)) continue;
					try {
						this._acceptBlock(block);
					} catch (error) {
						if (error instanceof StorageError) throw error;
						rejected = error as Error;
						return;
					}
					added++;
				}
			});
			return { added, rejected };
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

	/** The active tip, with its transactions. */
	getLatestBlock(): Block {
		return this._tipBlock;
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
		const hash = this._db.lastStakedBy(addresses, Math.max(1, this.chain.length - depth));
		const entry = hash === undefined ? undefined : this._index.get(hash);
		return entry && this._readBlock(entry);
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
			this._replayChain(this.getChain());
			return true;
		} catch (error) {
			log.warn(`chain invalid: ${(error as Error).message}`);
			return false;
		}
	}

	/** Every active block, read from the block files: for tests and tools, not the node (it is O(chain)). */
	getChain(): Block[] {
		return this.chain.map((entry) => this._readBlock(entry));
	}

	/** Serialized size of all pending transactions (bounded by maxMempoolBytes). */
	getMempoolBytes(): number {
		return this._mempool.bytes;
	}

	getPendingTransactions(): Transaction[] {
		return this._mempool.transactions();
	}

	/** Txids of pending transactions for peers: highest fee rate first, at most `max`. */
	getMempoolInventory(max: number): string[] {
		return this._mempool.select(max, Number.MAX_SAFE_INTEGER).map((entry) => entry.txid);
	}

	/**
	 * Load the block tree and the active chain's state from the chain database, then activate the
	 * best valid branch the way blocks from peers are: blocks stored after the database's tip (a
	 * stop between the two writes) are validated and connected. A database built by another
	 * version or under other rules, or out of line with the block files, is rebuilt from them, as
	 * with --reindex: every stored block is read and validated again. Otherwise no block is read
	 * but the tip (TASK-0053).
	 */
	private loadBlockchain(): void {
		try {
			const genesis = this.chain[0];
			const stored = this.blockStore.hashes();
			if (stored.length === 0) {
				this.blockStore.appendBlock(this._tipBlock);
			} else if (stored[0] !== genesis.hash || this.blockStore.getBlock(stored[0])?.calculateHash() !== genesis.hash) {
				throw new Error('invalid stored chain: genesis block hash mismatch');
			}

			const dbHeight = this._writeBatch(() => {
				const height = this._loadState();
				this._connectedAtStartup = 0;
				this._activateBest();
				return height;
			});
			const height = this.chain.length - 1;
			if (dbHeight === null) {
				log.info(`chain database built: validated ${this._connectedAtStartup} stored block(s), height ${height}`);
			} else {
				log.info(`chain database at height ${dbHeight}; validated ${this._connectedAtStartup} newer block(s)`);
			}
		} catch (error) {
			log.error('Error loading blockchain:', error);
			throw error;
		}
	}

	/**
	 * Take the block tree and the active chain's state from the chain database if it holds for
	 * the stored blocks and this node's rules; else empty the database, record every stored block
	 * again and start from genesis. Returns the height the database was at, or null when it
	 * starts over.
	 */
	private _loadState(): number | null {
		const genesisBlock = this._tipBlock;
		const genesis = this.chain[0];
		const described = this._db.describe();
		const { powCutoffBlock, minStakeAge } = this._rules;
		let reason: string | undefined;
		if (this._options.reindex) reason = '--reindex';
		else if (!described) reason = 'new';
		else if (described.version !== CHAIN_DB_VERSION) reason = `it is from another version (${described.version})`;
		else if (described.rules.powCutoffBlock !== powCutoffBlock || described.rules.minStakeAge !== minStakeAge) {
			reason = `it was built under other consensus rules (PoW until block ${described.rules.powCutoffBlock}, stake age ${described.rules.minStakeAge} s)`;
		} else {
			reason = this._loadTree();
		}

		if (!reason) {
			const tip = this._db.tip();
			const tipEntry = tip ? this._index.get(tip.hash) : undefined;
			const branch = tipEntry ? this._branchTo(tipEntry) : [];
			const modifiers = this._db.activeModifiers();
			if (!tipEntry) reason = 'its tip is not among the stored blocks';
			else if (modifiers.length !== branch.length) reason = 'its active chain is incomplete';
			else {
				this._takeDbState(tipEntry);
				return branch.length - 1;
			}
		}

		if (reason === 'new') log.info('building the chain database from the stored blocks');
		else if (reason === '--reindex') log.info('rebuilding the chain database from the stored blocks (--reindex)');
		else log.warn(`rebuilding the chain database: ${reason}`);
		this._removeOldChainstate();
		this._index = new Map([[genesis.hash, genesis]]);
		this._utxos = new UtxoSet();
		this._utxos.addOutputs(genesisBlock.transactions[0], 0, genesisBlock.timestamp);
		const txids = genesisBlock.transactions.map((tx) => tx.calculateHash());
		storing('could not reset the chain database', () => {
			this._db.reset(this._rules);
			this._db.addBlock(this._record(genesisBlock, genesis.work));
			this._db.connect({
				hash: genesis.hash,
				height: 0,
				modifier: GENESIS_STAKE_MODIFIER,
				spent: [],
				created: this._utxos.all(),
				txids,
				flows: addressFlows(genesisBlock, [], txids),
			});
		});
		for (const hash of this.blockStore.hashes().slice(1)) this._addStoredBlock(hash);
		this.chain = [genesis];
		this._tipBlock = genesisBlock;
		this._modifiers = [GENESIS_STAKE_MODIFIER];
		return null;
	}

	/**
	 * The block tree from the database's records (parents first), with the invalid marks, plus
	 * stored blocks it has no record of yet (a stop between the two writes of a new block).
	 * Returns why the database can't be used, if it is out of line with the block files.
	 */
	private _loadTree(): string | undefined {
		const genesis = this.chain[0];
		const stored = new Set(this.blockStore.hashes());
		this._index = new Map([[genesis.hash, genesis]]);
		for (const record of this._db.loadBlocks()) {
			if (record.height === 0) {
				if (record.hash !== genesis.hash) return 'its genesis block is another';
				continue;
			}
			const parent = this._index.get(record.previousHash);
			if (!parent || !stored.has(record.hash)) {
				if (record.status === BlockStatus.Active) return `active block ${record.height} is missing from the block files`;
				continue; // a side block whose data is gone: forget it
			}
			const entry = new ChainEntry(
				record.hash,
				parent.hash,
				record.height,
				record.timestamp,
				record.bits,
				record.isProofOfStake,
				record.work,
				record.tieBreak === record.hash ? record.hash : record.tieBreak,
			);
			entry.isInvalid = record.status === BlockStatus.Invalid;
			this._index.set(entry.hash, entry);
		}
		for (const hash of stored) this._addStoredBlock(hash);
		return undefined;
	}

	/** Add a stored block the tree doesn't have yet (read from the block files) and record it. */
	private _addStoredBlock(hash: string): void {
		if (this._index.has(hash)) return; // known, or stored twice
		const block = this.blockStore.getBlock(hash);
		const parent = block && this._index.get(block.previousHash);
		if (!block || !parent || block.hash !== block.calculateHash() || block.index !== parent.height + 1) {
			log.warn(`skipping unusable stored block ${hash.slice(0, 16)}`);
			return;
		}
		const entry = ChainEntry.of(block, parent);
		storing(`could not record block ${block.index}`, () => this._db.addBlock(this._record(block, entry.work)));
		this._addEntry(entry);
		this._wrote();
	}

	/** chainstate.json (before TASK-0053) is replaced by the chain database. */
	private _removeOldChainstate(): void {
		const old = path.join(this._options.blocksDir, 'chainstate.json');
		if (!fs.existsSync(old)) return;
		fs.rmSync(old, { force: true });
		log.info('removed chainstate.json: the chain database replaces it');
	}

	/**
	 * Make the best valid known branch active (startup): connect stored blocks with more work
	 * than the tip; a branch with an invalid block is marked so and the next best one tried.
	 */
	private _activateBest(): void {
		for (;;) {
			// One pass in height order: a block is out if it or an ancestor is invalid
			const out = new Set<string>();
			let best = this._tip;
			for (const entry of [...this._index.values()].sort((a, b) => a.height - b.height)) {
				if (entry.isInvalid || out.has(entry.previousHash)) {
					out.add(entry.hash);
					continue;
				}
				if (Blockchain._isBetter(entry, best)) best = entry;
			}
			if (best === this._tip) return;
			try {
				this._activateBranch(best);
			} catch (error) {
				if (error instanceof StorageError) throw error;
				const { height, reason } = error as Error & { height: number; reason: string };
				log.warn(`invalid stored block: block ${height}: ${reason}`);
			}
		}
	}

	getMedianTimePast(): number {
		return this.getMedianTimePastForChain(this.chain, this.chain.length - 1);
	}

	private getMedianTimePastForChain(chain: readonly { timestamp: number }[], upToIndex: number): number {
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

			this._writeBatch(() => {
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
						if (error instanceof StorageError) throw error;
						throw new Error(`Invalid chain: block ${i}: ${(error as Error).message}`, { cause: error });
					}
				}
			});
		} finally {
			release();
		}
	}
}
