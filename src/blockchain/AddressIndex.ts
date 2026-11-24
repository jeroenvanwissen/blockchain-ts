import type { Block } from './Block.js';
import type { TxOutput } from './Transaction.js';
import { outpointKey, type UTXO } from './UtxoSet.js';

/** One transaction's effect on one address. */
export interface AddressActivity {
	txid: string;
	height: number; // block height on the active chain
	indexInBlock: number; // the transaction's position in its block (0: the coinbase)
	received: bigint; // paid to the address by this transaction
	sent: bigint; // spent from the address by this transaction
	balance: bigint; // the address's balance after this transaction
}

/** What one transaction of a block received and sent for one address. */
export interface AddressFlow {
	txid: string;
	indexInBlock: number;
	address: string;
	received: bigint;
	sent: bigint;
}

/**
 * What each transaction of `block` received and sent per address, in block order. Inputs are
 * resolved from `spent` (the block's undo data), or from an earlier transaction of the same
 * block (those aren't in the undo data). A coinstake shows as sending and receiving the kernel
 * output; zero-value outputs (the coinstake marker) count as nothing.
 */
export function addressFlows(block: Block, spent: readonly UTXO[], txids: readonly string[]): AddressFlow[] {
	const outputs = new Map<string, TxOutput>(spent.map((utxo) => [outpointKey(utxo.txHash, utxo.outputIndex), utxo.output]));
	const result: AddressFlow[] = [];
	block.transactions.forEach((tx, t) => {
		const txid = txids[t];
		const flows = new Map<string, AddressFlow>();
		const flow = (address: string): AddressFlow => {
			let entry = flows.get(address);
			if (!entry) flows.set(address, (entry = { txid, indexInBlock: t, address, received: 0n, sent: 0n }));
			return entry;
		};
		if (!tx.isCoinbase()) {
			for (const input of tx.inputs) {
				const output = outputs.get(outpointKey(input.previousTx, input.outputIndex));
				if (output) flow(output.address).sent += output.amount;
			}
		}
		tx.outputs.forEach((output, i) => {
			if (output.amount === 0n) return;
			flow(output.address).received += output.amount;
			outputs.set(outpointKey(txid, i), output); // a later transaction in this block may spend it
		});
		result.push(...flows.values());
	});
	return result;
}

/**
 * The combined history of several addresses (a wallet's): one entry per transaction, in chain
 * order, with what it received and sent over all of them and their total balance after it.
 */
export function mergeHistories(histories: Iterable<readonly AddressActivity[]>): AddressActivity[] {
	const byTx = new Map<string, AddressActivity>();
	for (const history of histories) {
		for (const entry of history) {
			const merged = byTx.get(entry.txid);
			if (merged) {
				merged.received += entry.received;
				merged.sent += entry.sent;
			} else {
				byTx.set(entry.txid, { ...entry });
			}
		}
	}
	const merged = [...byTx.values()].sort((a, b) => a.height - b.height || a.indexInBlock - b.indexInBlock);
	let balance = 0n;
	for (const entry of merged) entry.balance = balance += entry.received - entry.sent;
	return merged;
}
