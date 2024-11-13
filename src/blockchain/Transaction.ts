import * as secp256k1 from 'secp256k1';
import * as crypto from 'crypto';

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
	public timestamp: number;
	public inputs: TxInput[];
	public outputs: TxOutput[];

	constructor(inputs: TxInput[], outputs: TxOutput[], timestamp?: number) {
		this.inputs = inputs;
		this.outputs = outputs.map((output) => ({
			...output,
			address: this.hashAddress(output.address),
		}));
		this.timestamp = timestamp || Date.now();
	}

	calculateHash(): string {
		const data =
			JSON.stringify(this.inputs) +
			JSON.stringify(this.outputs) +
			this.timestamp;
		return crypto.createHash('sha256').update(data).digest('hex');
	}

	signTransaction(privateKey: string): void {
		this.inputs.forEach((input) => {
			const hashTx = this.calculateHash();
			input.signature = crypto
				.createHash('sha256')
				.update(hashTx + privateKey)
				.digest('hex');
		});
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

	private hashAddress(address: string): string {
		return crypto.createHash('sha256').update(address).digest('hex');
	}
}
