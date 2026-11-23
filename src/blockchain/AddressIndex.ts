import type { Block } from './Block.js';
import type { TxOutput } from './Transaction.js';
import { outpointKey, type UTXO } from './UtxoSet.js';

/** One transaction's effect on one address. */
export interface AddressActivity {
	txid: string;
	height: number; // block height on the active chain
	received: bigint; // paid to the address by this transaction
	sent: bigint; // spent from the address by this transaction
	balance: bigint; // the address's balance after this transaction
}

interface Flow {
	txid: string;
	address: string;
	received: bigint;
	sent: bigint;
}

/**
 * Every active-chain transaction that touched each address, oldest first (TASK-0045). Derived
 * from the blocks and their undo data, like the txid index: kept up to date as blocks connect
 * and disconnect, and rebuilt at startup, so it needs no storage of its own. A coinstake shows
 * as sending and receiving the kernel output; zero-value outputs (the coinstake marker) count
 * as nothing. The last entry's balance equals the address's balance in the UTXO set.
 */
export class AddressIndex {
	private readonly _byAddress = new Map<string, AddressActivity[]>();

	/** Add a newly connected tip block. `spent` is its undo data; `txids` its transactions' ids. */
	connect(block: Block, spent: readonly UTXO[], txids = block.transactions.map((tx) => tx.calculateHash())): void {
		for (const { txid, address, received, sent } of AddressIndex._flows(block, spent, txids)) {
			let history = this._byAddress.get(address);
			if (!history) this._byAddress.set(address, (history = []));
			const before = history[history.length - 1]?.balance ?? 0n;
			history.push({ txid, height: block.index, received, sent, balance: before + received - sent });
		}
	}

	/** Remove a disconnected tip block (its entries are the newest of each address it touched). */
	disconnect(block: Block, spent: readonly UTXO[], txids = block.transactions.map((tx) => tx.calculateHash())): void {
		for (const { address } of AddressIndex._flows(block, spent, txids)) {
			const history = this._byAddress.get(address);
			if (!history) continue;
			while (history.length > 0 && history[history.length - 1].height === block.index) history.pop();
			if (history.length === 0) this._byAddress.delete(address);
		}
	}

	/** The address's transactions on the active chain, oldest first. */
	history(address: string): readonly AddressActivity[] {
		return this._byAddress.get(address) ?? [];
	}

	/**
	 * What each transaction of `block` received and sent per address. Inputs are resolved from
	 * the undo data, or from an earlier transaction of the same block (those aren't in the undo).
	 */
	private static _flows(block: Block, spent: readonly UTXO[], txids: readonly string[]): Flow[] {
		const outputs = new Map<string, TxOutput>(spent.map((utxo) => [outpointKey(utxo.txHash, utxo.outputIndex), utxo.output]));
		const result: Flow[] = [];
		block.transactions.forEach((tx, t) => {
			const txid = txids[t];
			const flows = new Map<string, Flow>();
			const flow = (address: string): Flow => {
				let entry = flows.get(address);
				if (!entry) flows.set(address, (entry = { txid, address, received: 0n, sent: 0n }));
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
}
