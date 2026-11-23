import * as crypto from 'crypto';
import { Transaction } from './Transaction.js';
import { MAX_BLOCK_NONCE } from '../config.js';

export class Block {
	public hash: string;
	public nonce: number = 0;
	public powDifficulty: number;
	public index: number;
	public cumulativeWeight: number = 0;

	constructor(
		public timestamp: number,
		public transactions: Transaction[],
		public previousHash: string,
		nonce: number = 0,
		difficulty: number = 4,
		index?: number
	) {
		this.nonce = nonce;
		this.powDifficulty = difficulty;
		this.index = index || 0;
		this.hash = this.calculateHash();
	}

	/**
	 * Hashed block data up to (not including) the nonce value. The block hash is
	 * SHA-256 of `prefix + nonce + '}'`, so the mining worker can vary only the nonce
	 * and still hash exactly what validation hashes.
	 */
	powPrefix(): string {
		// Commit to each full transaction (including signatures) via its witness hash
		const data = JSON.stringify({
			timestamp: this.timestamp,
			transactions: this.transactions.map((tx) => tx.witnessHash()),
			previousHash: this.previousHash,
			nonce: 0,
		});
		return data.slice(0, -2); // strip the placeholder `0}`
	}

	static hashWithNonce(prefix: string, nonce: number): string {
		return crypto.createHash('sha256').update(`${prefix}${nonce}}`).digest('hex');
	}

	calculateHash(): string {
		return Block.hashWithNonce(this.powPrefix(), this.nonce);
	}

	/**
	 * Find a nonce in-process that meets this block's difficulty (tests and in-process
	 * mining; the node's Miner uses a worker thread). Computes the prefix once.
	 */
	solve(): void {
		const prefix = this.powPrefix();
		const target = '0'.repeat(this.powDifficulty);
		for (let nonce = 0; nonce <= MAX_BLOCK_NONCE; nonce++) {
			const hash = Block.hashWithNonce(prefix, nonce);
			if (hash.startsWith(target)) {
				this.nonce = nonce;
				this.hash = hash;
				return;
			}
		}
		throw new Error('nonce space exhausted');
	}

	hasValidTransactions(): boolean {
		for (const tx of this.transactions) {
			if (!tx.isValid()) {
				return false;
			}
		}
		return true;
	}

	// Validate block based on type
	isValid(): boolean {
		if (this.isProofOfWork()) {
			// Simple prefix check
			const target = '0'.repeat(this.powDifficulty);
			const hashPrefix = this.hash.substring(0, this.powDifficulty);

			// First verify hash matches calculated hash
			const calculatedHash = this.calculateHash();
			if (this.hash !== calculatedHash) {
				console.log('Hash mismatch');
				return false;
			}

			return hashPrefix === target;
		} else {
			return true;
		}
	}

	isProofOfStake(): boolean {
		return this.transactions.length > 1 && this.transactions[1].isCoinStake();
	}

	isProofOfWork(): boolean {
		return !this.isProofOfStake();
	}

	// Getter for difficulty
	getDifficulty(): number {
		return this.powDifficulty;
	}

	// Setter for difficulty
	setDifficulty(difficulty: number): void {
		this.powDifficulty = difficulty;
	}
}
