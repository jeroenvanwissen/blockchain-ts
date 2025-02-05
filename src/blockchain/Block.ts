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

        const txData = this.transactions.map(tx => ({
            inputs: tx.inputs,
            outputs: tx.outputs,
            timestamp: tx.timestamp, // Use the original timestamp
						nonce: tx.nonce
        }));

        // Match the mining worker's data structure exactly
        const data = JSON.stringify({
            timestamp: this.timestamp,
            transactions: txData,
            previousHash: this.previousHash,
            nonce: this.nonce
        });

        console.log('Block data for hashing:', data);
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        console.log('Calculated hash:', hash);
        
        return hash;
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
