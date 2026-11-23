import * as crypto from 'crypto';
import * as fs from 'fs';
import type { UTXO } from './UtxoSet.js';

/**
 * Validated chain state at a tip, saved so startup can skip re-validating the blocks up to it
 * (TASK-0029). File: a header line `{"version":1,"checksum":"<sha256 of the payload>"}`, then the
 * payload as JSON. Outputs are stored as tuples to keep the file small.
 */
export interface Chainstate {
	tip: string; // hash of the block the state is after
	height: number;
	utxos: UTXO[];
	modifiers: string[]; // stake modifier after each block 0..height
	undo: UTXO[][]; // outputs each block 0..height spent
}

export const CHAINSTATE_VERSION = 1;

// [txHash, outputIndex, address, amount, blockIndex, flags (1 coinbase, 2 coinstake), txTimestamp, blockTimestamp]
type UtxoTuple = [string, number, string, string, number, number, number, number];

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function toTuple(u: UTXO): UtxoTuple {
	const flags = (u.isCoinbase ? 1 : 0) | (u.isCoinstake ? 2 : 0);
	return [u.txHash, u.outputIndex, u.output.address, u.output.amount.toString(), u.blockIndex, flags, u.txTimestamp, u.blockTimestamp];
}

function fromTuple(t: unknown): UTXO {
	if (
		!Array.isArray(t) ||
		t.length !== 8 ||
		typeof t[0] !== 'string' ||
		!HASH_PATTERN.test(t[0]) ||
		!Number.isInteger(t[1]) ||
		typeof t[2] !== 'string' ||
		typeof t[3] !== 'string' ||
		!/^\d+$/.test(t[3]) ||
		!Number.isInteger(t[4]) ||
		!Number.isInteger(t[5]) ||
		!Number.isSafeInteger(t[6]) ||
		!Number.isSafeInteger(t[7])
	) {
		throw new Error('malformed output entry');
	}
	const [txHash, outputIndex, address, amount, blockIndex, flags, txTimestamp, blockTimestamp] = t as UtxoTuple;
	return {
		txHash,
		outputIndex,
		output: { address, amount: BigInt(amount) },
		blockIndex,
		isCoinbase: (flags & 1) !== 0,
		isCoinstake: (flags & 2) !== 0,
		txTimestamp,
		blockTimestamp,
	};
}

/** Write atomically (temporary file, then rename). */
export function writeChainstate(file: string, state: Chainstate): void {
	const payload = JSON.stringify({
		tip: state.tip,
		height: state.height,
		utxos: state.utxos.map(toTuple),
		modifiers: state.modifiers,
		undo: state.undo.map((spent) => spent.map(toTuple)),
	});
	const checksum = crypto.createHash('sha256').update(payload).digest('hex');
	const temp = `${file}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify({ version: CHAINSTATE_VERSION, checksum })}\n${payload}`);
	fs.renameSync(temp, file);
}

/** The saved chainstate; undefined if there is none. Throws if it's from another version or damaged. */
export function readChainstate(file: string): Chainstate | undefined {
	if (!fs.existsSync(file)) return undefined;
	const text = fs.readFileSync(file, 'utf8');
	const newline = text.indexOf('\n');
	if (newline < 0) throw new Error('missing header');
	const header = JSON.parse(text.slice(0, newline)) as { version?: unknown; checksum?: unknown };
	if (header.version !== CHAINSTATE_VERSION) throw new Error(`unsupported version ${String(header.version)}`);
	const payload = text.slice(newline + 1);
	if (crypto.createHash('sha256').update(payload).digest('hex') !== header.checksum) throw new Error('checksum mismatch');

	const data = JSON.parse(payload) as Record<string, unknown>;
	const { tip, height, utxos, modifiers, undo } = data;
	if (typeof tip !== 'string' || !HASH_PATTERN.test(tip)) throw new Error('malformed tip');
	if (!Number.isSafeInteger(height) || (height as number) < 0) throw new Error('malformed height');
	const count = (height as number) + 1;
	if (!Array.isArray(modifiers) || modifiers.length !== count || !modifiers.every((m) => typeof m === 'string' && HASH_PATTERN.test(m))) {
		throw new Error('malformed stake modifiers');
	}
	if (!Array.isArray(undo) || undo.length !== count || !undo.every(Array.isArray)) throw new Error('malformed undo data');
	if (!Array.isArray(utxos)) throw new Error('malformed outputs');
	return {
		tip,
		height: height as number,
		utxos: utxos.map(fromTuple),
		modifiers: modifiers as string[],
		undo: (undo as unknown[][]).map((spent) => spent.map(fromTuple)),
	};
}
