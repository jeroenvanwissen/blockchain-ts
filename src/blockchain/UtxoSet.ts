import type { Transaction, TxOutput } from './Transaction.js';

export interface UTXO {
	txHash: string;
	outputIndex: number;
	output: TxOutput;
	blockIndex: number; // height of the block that created it (maturity)
	isCoinbase: boolean;
	isCoinstake: boolean; // coinstake outputs mature like coinbase outputs
	txTimestamp: number; // timestamp of the creating transaction (stake age)
}

export function outpointKey(txHash: string, outputIndex: number): string {
	return `${txHash}:${outputIndex}`;
}

/** Unspent outputs indexed by outpoint, with a per-address index for wallet queries. */
export class UtxoSet {
	private readonly _byOutpoint = new Map<string, UTXO>();
	private readonly _byAddress = new Map<string, Set<string>>();

	get size(): number {
		return this._byOutpoint.size;
	}

	get(txHash: string, outputIndex: number): UTXO | undefined {
		return this._byOutpoint.get(outpointKey(txHash, outputIndex));
	}

	add(utxo: UTXO): void {
		const key = outpointKey(utxo.txHash, utxo.outputIndex);
		this._byOutpoint.set(key, utxo);
		let keys = this._byAddress.get(utxo.output.address);
		if (!keys) {
			keys = new Set();
			this._byAddress.set(utxo.output.address, keys);
		}
		keys.add(key);
	}

	/** Add every spendable (non-zero) output of a confirmed non-coinstake transaction. */
	addOutputs(tx: Transaction, blockIndex: number): void {
		const txHash = tx.calculateHash();
		const isCoinbase = tx.isCoinbase();
		tx.outputs.forEach((output, outputIndex) => {
			if (output.amount === 0n) return;
			this.add({
				txHash,
				outputIndex,
				output,
				blockIndex,
				isCoinbase,
				isCoinstake: false,
				txTimestamp: tx.timestamp,
			});
		});
	}

	remove(txHash: string, outputIndex: number): UTXO | undefined {
		const key = outpointKey(txHash, outputIndex);
		const utxo = this._byOutpoint.get(key);
		if (!utxo) return undefined;
		this._byOutpoint.delete(key);
		const keys = this._byAddress.get(utxo.output.address);
		keys?.delete(key);
		if (keys?.size === 0) this._byAddress.delete(utxo.output.address);
		return utxo;
	}

	/** Unspent outputs paying `address`, oldest first. */
	forAddress(address: string): UTXO[] {
		const keys = this._byAddress.get(address);
		return keys ? [...keys].map((key) => this._byOutpoint.get(key)!) : [];
	}
}
