import type { Transaction } from './Transaction.js';
import { outpointKey } from './UtxoSet.js';

/** A pending transaction with its fee and serialized size (checked against the chain on entry). */
export interface MempoolEntry {
	transaction: Transaction;
	txid: string;
	fee: bigint;
	size: number;
}

/** Compare fee rates a.fee/a.size and b.fee/b.size exactly (cross-multiplied). */
function compareFeeRate(a: MempoolEntry, b: MempoolEntry): number {
	const left = a.fee * BigInt(b.size);
	const right = b.fee * BigInt(a.size);
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Pending transactions. They spend confirmed outputs only (no chains of unconfirmed
 * transactions), so any subset is a valid block body. Two transactions spending the same output
 * conflict; the first one stays. The total size stays under a limit by evicting the lowest fee
 * rates, but only for a newcomer that pays a higher rate. Blocks take the highest rates first.
 * The chain revalidates every entry when its tip changes (Blockchain._readmitTransactions).
 */
export class Mempool {
	private readonly _entries = new Map<string, MempoolEntry>(); // by txid, in arrival order
	private readonly _spends = new Map<string, string>(); // outpoint → txid spending it
	private _bytes = 0;

	constructor(private readonly _maxBytes: number) {}

	get count(): number {
		return this._entries.size;
	}

	get bytes(): number {
		return this._bytes;
	}

	get(txid: string): MempoolEntry | undefined {
		return this._entries.get(txid);
	}

	/** Pending transactions in arrival order. */
	transactions(): Transaction[] {
		return [...this._entries.values()].map((entry) => entry.transaction);
	}

	isSpent(txHash: string, outputIndex: number): boolean {
		return this._spends.has(outpointKey(txHash, outputIndex));
	}

	/**
	 * Add an entry already checked against the chain. Returns the txids evicted to make room;
	 * throws on a duplicate, a conflict, or a fee rate too low to displace anything.
	 */
	add(entry: MempoolEntry): string[] {
		if (this._entries.has(entry.txid)) throw new Error('transaction already in mempool');
		for (const input of entry.transaction.inputs) {
			if (this.isSpent(input.previousTx, input.outputIndex)) {
				throw new Error('utxo already spent by pending transaction');
			}
		}
		if (entry.size > this._maxBytes) throw new Error('transaction is larger than the mempool');

		const evicted: MempoolEntry[] = [];
		let bytes = this._bytes + entry.size;
		if (bytes > this._maxBytes) {
			const lowestFirst = [...this._entries.values()].sort(compareFeeRate);
			for (const victim of lowestFirst) {
				if (bytes <= this._maxBytes || compareFeeRate(victim, entry) >= 0) break;
				evicted.push(victim);
				bytes -= victim.size;
			}
			if (bytes > this._maxBytes) throw new Error('mempool is full and this fee rate is too low to replace anything');
		}
		for (const victim of evicted) this.remove(victim.txid);

		this._entries.set(entry.txid, entry);
		for (const input of entry.transaction.inputs) {
			this._spends.set(outpointKey(input.previousTx, input.outputIndex), entry.txid);
		}
		this._bytes += entry.size;
		return evicted.map((victim) => victim.txid);
	}

	remove(txid: string): void {
		const entry = this._entries.get(txid);
		if (!entry) return;
		this._entries.delete(txid);
		for (const input of entry.transaction.inputs) {
			this._spends.delete(outpointKey(input.previousTx, input.outputIndex));
		}
		this._bytes -= entry.size;
	}

	clear(): void {
		this._entries.clear();
		this._spends.clear();
		this._bytes = 0;
	}

	/** For a block: highest fee rate first (ties: earlier arrival), within count and size limits. */
	select(maxCount: number, maxBytes: number): MempoolEntry[] {
		const byRate = [...this._entries.values()].sort((a, b) => compareFeeRate(b, a)); // stable
		const chosen: MempoolEntry[] = [];
		let bytes = 0;
		for (const entry of byRate) {
			if (chosen.length === maxCount) break;
			if (bytes + entry.size > maxBytes) continue; // a smaller one may still fit
			chosen.push(entry);
			bytes += entry.size;
		}
		return chosen;
	}
}
