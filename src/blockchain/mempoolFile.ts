import * as fs from 'fs';
import { Transaction } from './Transaction.js';

/**
 * Pending transactions saved at shutdown and re-admitted at startup (TASK-0047), so a payment
 * still waiting for a block survives a restart. JSON `{"version":1,"transactions":[...]}`: the
 * transactions in arrival order, in the wire format (`Transaction.toJSON`).
 */
export const MEMPOOL_FILE_VERSION = 1;

/** Write atomically (temporary file, then rename). */
export function writeMempoolFile(file: string, transactions: readonly Transaction[]): void {
	const temp = `${file}.tmp`;
	fs.writeFileSync(temp, JSON.stringify({ version: MEMPOOL_FILE_VERSION, transactions }));
	fs.renameSync(temp, file);
}

/** The saved transactions; none if there is no file. Throws if it's damaged or from another version. */
export function readMempoolFile(file: string): Transaction[] {
	if (!fs.existsSync(file)) return [];
	const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; transactions?: unknown } | null;
	if (data?.version !== MEMPOOL_FILE_VERSION) throw new Error(`unsupported version ${String(data?.version)}`);
	if (!Array.isArray(data.transactions)) throw new Error('no transaction list');
	return data.transactions.map((tx) => Transaction.fromJSON(tx));
}
