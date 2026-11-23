import * as crypto from 'crypto';
import { MAX_TRANSACTION_INPUTS, MAX_TRANSACTION_OUTPUTS } from '../config.js';
import { secp256k1 } from './secp256k1.js';

export interface TxInput {
	previousTx: string; // Reference to previous transaction hash
	outputIndex: number; // Index of the output in the previous transaction
	signature: string; // Signature to prove ownership
}

export interface TxOutput {
	address: string; // Recipient address
	amount: number; // Amount to send
}

export class Transaction {
    public inputs: TxInput[];
    public outputs: TxOutput[];
    public timestamp: number;
    public nonce: number; // made public for serialization and external access

    constructor(inputs: TxInput[], outputs: TxOutput[], timestamp?: number, nonce?: number) {
        this.inputs = inputs;
        this.outputs = outputs;
        this.timestamp = timestamp || Date.now();
        this.nonce = nonce ?? Math.floor(Math.random() * 1000000);  // Initialize nonce with provided value or random
    }

    calculateHash(): string {
        const data = JSON.stringify({
            inputs: this.inputs,
            outputs: this.outputs,
            timestamp: this.timestamp,
            nonce: this.nonce
        });
        return crypto.createHash('sha256').update(data).digest('hex');
    }

	signTransaction(privateKey: Buffer): void {
		const msgHash = Buffer.from(
			crypto.createHash('sha256').update(this.calculateHash()).digest(),
		);
		this.inputs.forEach((input) => {
			const signatureObj = secp256k1.ecdsaSign(msgHash, privateKey);
			input.signature = Buffer.from(signatureObj.signature).toString('hex');
		});
	}

	isCoinbase(): boolean {
		return this.inputs.length === 0 && this.outputs.length === 1;
	}

	isCoinStake(): boolean {
		return (
			this.inputs.length > 0 &&
			this.inputs[0].previousTx !== null &&
			this.outputs.length >= 2 &&
			this.outputs[0].amount === 0
		);
	}

	public verifySignature(
		pubKey: Buffer,
		signature: Buffer,
		message: Buffer
	): boolean {
		try {
			return secp256k1.ecdsaVerify(signature, message, pubKey);
		} catch {
			console.error('Error verifying signature');
			return false;
		}
	}

	isValid(): boolean {
		if (this.inputs.length === 0 && this.outputs.length === 1) {
			return true;
		}

		for (const input of this.inputs) {
			if (!input.signature) {
				return false;
			}
		}

		return true;
	}

	validate(): void {
		// Coinbase transactions are validated separately
		if (this.isCoinbase()) return;

		// Must have inputs and outputs
		if (this.inputs.length === 0) {
			throw new Error('transaction must have inputs');
		}
		if (this.outputs.length === 0) {
			throw new Error('transaction must have outputs');
		}

		// Size limits
		if (this.inputs.length > MAX_TRANSACTION_INPUTS) {
			throw new Error('transaction exceeds maximum input count');
		}
		if (this.outputs.length > MAX_TRANSACTION_OUTPUTS) {
			throw new Error('transaction exceeds maximum output count');
		}

		// All inputs must have signatures
		for (const input of this.inputs) {
			if (!input.signature || input.signature.length === 0) {
				throw new Error('input missing signature');
			}
		}

		// No duplicate inputs (same txHash + outputIndex)
		const inputKeys = new Set<string>();
		for (const input of this.inputs) {
			const key = `${input.previousTx}:${input.outputIndex}`;
			if (inputKeys.has(key)) {
				throw new Error('duplicate input in transaction');
			}
			inputKeys.add(key);
		}

		// All output amounts must be positive
		// Exception: coinstake marker (first output with amount 0)
		const isCoinstake = this.isCoinStake();
		for (let i = 0; i < this.outputs.length; i++) {
			const amount = this.outputs[i].amount;
			if (amount < 0) {
				throw new Error('output has negative amount');
			}
			if (amount === 0 && !(isCoinstake && i === 0)) {
				throw new Error('output has zero amount');
			}
		}
	}
}
