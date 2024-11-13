import * as crypto from 'crypto';
import { Transaction } from './Transaction';

export class Block {
	public hash: string;
	public nonce: number = 0;
	public powDifficulty: number;
	public index: number;

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

	calculateHash(): string {
		// Create a deterministic representation of transactions
		const txData = this.transactions.map((tx) => ({
			inputs: tx.inputs,
			outputs: tx.outputs,
			timestamp: tx.timestamp,
		}));

		const data =
			this.previousHash +
			this.timestamp +
			JSON.stringify(txData) + // Use our deterministic transaction representation
			this.nonce +
			this.index;

		return crypto.createHash('sha256').update(data).digest('hex');
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
			return (
				this.hash.substring(0, this.powDifficulty) ===
				Array(this.powDifficulty + 1).join('0')
			);
		} else {
			// PoS validation happens at blockchain level
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
