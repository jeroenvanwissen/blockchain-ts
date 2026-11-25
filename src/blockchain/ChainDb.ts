import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { AddressActivity, AddressFlow } from './AddressIndex.js';
import type { UTXO } from './UtxoSet.js';

/**
 * The chain database (TASK-0053): `blocks/chain.db`, SQLite through node:sqlite. It holds what
 * is derived from the blocks, so the node neither keeps it in memory nor rebuilds it at every
 * start: the block tree (header fields, chain work, status), and for the active chain the UTXO
 * set, each block's undo data and stake modifier, the txid index and every address's history.
 * Connecting or disconnecting a block changes it in one transaction, or in a batch's transaction
 * when the node writes a run of blocks (TASK-0054), so it always describes one tip completely. The blk*.dat files stay the source of truth: the database can be rebuilt from
 * them (--reindex), and it is when it was built under other rules or by another version.
 */
export const CHAIN_DB_VERSION = 1;

/** The network parameters the database was built under. */
export interface ChainRules {
	powCutoffBlock: number;
	minStakeAge: number; // seconds
}

export enum BlockStatus {
	Stored = 0, // known, not on the active chain (yet)
	Active = 1,
	Invalid = 2, // failed full validation: never activated, nor its descendants
}

/** A known block's header data and place in the block tree. */
export interface BlockRecord {
	hash: string;
	height: number;
	previousHash: string;
	timestamp: number;
	bits: number;
	isProofOfStake: boolean;
	work: bigint; // cumulative chain work up to and including this block
	tieBreak: string; // fork choice between equal work (see Blockchain._tieBreak)
	producer: string; // PoS: the staker; PoW: the coinbase's payee
	txCount: number;
	size: number; // serialized bytes
	status: BlockStatus;
	modifier: string | null; // stake modifier after this block, while it is active
}

/** What connecting a block changes, all written in one transaction. */
export interface ConnectChange {
	hash: string;
	height: number;
	modifier: string;
	spent: readonly UTXO[]; // its undo data
	created: readonly UTXO[];
	txids: readonly string[]; // in block order
	flows: readonly AddressFlow[];
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bin = (value: string) => Buffer.from(value, 'hex');

// UTXO flags in the database: 1 coinbase, 2 coinstake
const flagsOf = (u: UTXO) => (u.isCoinbase ? 1 : 0) | (u.isCoinstake ? 2 : 0);

type UtxoTuple = [string, number, string, string, number, number, number, number];

function encodeUndo(spent: readonly UTXO[]): string {
	const tuples: UtxoTuple[] = spent.map((u) => [
		u.txHash,
		u.outputIndex,
		u.output.address,
		u.output.amount.toString(),
		u.blockIndex,
		flagsOf(u),
		u.txTimestamp,
		u.blockTimestamp,
	]);
	return JSON.stringify(tuples);
}

function decodeUndo(text: string): UTXO[] {
	return (JSON.parse(text) as UtxoTuple[]).map(([txHash, outputIndex, address, amount, blockIndex, flags, txTimestamp, blockTimestamp]) => ({
		txHash,
		outputIndex,
		output: { address, amount: BigInt(amount) },
		blockIndex,
		isCoinbase: (flags & 1) !== 0,
		isCoinstake: (flags & 2) !== 0,
		txTimestamp,
		blockTimestamp,
	}));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS blocks (
	hash BLOB PRIMARY KEY,
	height INTEGER NOT NULL,
	prev BLOB NOT NULL,
	timestamp INTEGER NOT NULL,
	bits INTEGER NOT NULL,
	pos INTEGER NOT NULL,
	work TEXT NOT NULL,
	tie TEXT NOT NULL,
	producer TEXT NOT NULL,
	tx_count INTEGER NOT NULL,
	size INTEGER NOT NULL,
	status INTEGER NOT NULL,
	modifier BLOB
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS blocks_active ON blocks (height) WHERE status = 1;
CREATE TABLE IF NOT EXISTS undo (hash BLOB PRIMARY KEY, spent TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS utxos (
	txid BLOB NOT NULL,
	n INTEGER NOT NULL,
	address TEXT NOT NULL,
	amount INTEGER NOT NULL,
	height INTEGER NOT NULL,
	flags INTEGER NOT NULL,
	tx_time INTEGER NOT NULL,
	block_time INTEGER NOT NULL,
	PRIMARY KEY (txid, n)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS txs (txid BLOB PRIMARY KEY, height INTEGER NOT NULL, position INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS txs_height ON txs (height);
CREATE TABLE IF NOT EXISTS activity (
	address TEXT NOT NULL,
	height INTEGER NOT NULL,
	position INTEGER NOT NULL,
	txid BLOB NOT NULL,
	received INTEGER NOT NULL,
	sent INTEGER NOT NULL,
	balance INTEGER NOT NULL,
	PRIMARY KEY (address, height, position)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS activity_height ON activity (height);
`;

const TABLES = ['meta', 'blocks', 'undo', 'utxos', 'txs', 'activity'];

export class ChainDb {
	private readonly _db: DatabaseSync;
	private readonly _sql: Record<string, StatementSync> = {};
	private _inBatch = false;

	/** Open (or create) the database at `file`; ':memory:' for a throwaway one. */
	constructor(file: string) {
		this._db = new DatabaseSync(file);
		this._db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;');
		this._db.exec(SCHEMA);
	}

	close(): void {
		this._db.close();
	}

	private _statement(sql: string, bigints = false): StatementSync {
		let statement = this._sql[sql];
		if (!statement) {
			statement = this._sql[sql] = this._db.prepare(sql);
			statement.setReadBigInts(bigints);
		}
		return statement;
	}

	/**
	 * Run `work` in one transaction: all of it is written, or none. Inside a batch (`begin`) it is
	 * part of the batch's transaction: written at `commit` with the rest, undone by `rollback`.
	 */
	transaction<T>(work: () => T): T {
		if (this._inBatch) return work();
		this._db.exec('BEGIN');
		try {
			const result = work();
			this._db.exec('COMMIT');
			return result;
		} catch (error) {
			this._rollback();
			throw error;
		}
	}

	/**
	 * Start a batch (TASK-0054): the writes until `commit` are one transaction, so a run of
	 * blocks costs one commit instead of one per block. Whoever opens a batch rolls it back when
	 * one of its writes fails.
	 */
	begin(): void {
		this._db.exec('BEGIN');
		this._inBatch = true;
	}

	commit(): void {
		this._db.exec('COMMIT');
		this._inBatch = false;
	}

	/** Undo the batch's writes since `begin`. */
	rollback(): void {
		this._rollback();
		this._inBatch = false;
	}

	private _rollback(): void {
		try {
			this._db.exec('ROLLBACK');
		} catch {
			// no transaction open: SQLite rolls back by itself after some errors (a full disk, I/O)
		}
	}

	// --- meta ---

	private _meta(key: string): string | undefined {
		return (this._statement('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
	}

	private _setMeta(key: string, value: string): void {
		this._statement('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
	}

	/** Version and rules the database was built with; null for a new (empty) database. */
	describe(): { version: number; rules: ChainRules } | null {
		const version = this._meta('version');
		const rules = this._meta('rules');
		if (version === undefined || rules === undefined) return null;
		return { version: Number(version), rules: JSON.parse(rules) as ChainRules };
	}

	/** Empty every table and record the version and rules a rebuild uses. */
	reset(rules: ChainRules): void {
		this.transaction(() => {
			for (const table of TABLES) this._db.exec(`DELETE FROM ${table}`);
			this._setMeta('version', String(CHAIN_DB_VERSION));
			this._setMeta('rules', JSON.stringify(rules));
		});
	}

	// --- the block tree ---

	/** Record a known block (status Stored); a block recorded before is left as it is. */
	addBlock(record: BlockRecord): void {
		this._statement(
			`INSERT INTO blocks (hash, height, prev, timestamp, bits, pos, work, tie, producer, tx_count, size, status, modifier)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (hash) DO NOTHING`,
		).run(
			bin(record.hash),
			record.height,
			bin(record.previousHash),
			record.timestamp,
			record.bits,
			record.isProofOfStake ? 1 : 0,
			record.work.toString(16),
			record.tieBreak,
			record.producer,
			record.txCount,
			record.size,
			record.status,
			record.modifier === null ? null : bin(record.modifier),
		);
	}

	markInvalid(hash: string): void {
		this._statement('UPDATE blocks SET status = ? WHERE hash = ?').run(BlockStatus.Invalid, bin(hash));
	}

	hasBlock(hash: string): boolean {
		return this._statement('SELECT 1 FROM blocks WHERE hash = ?').get(bin(hash)) !== undefined;
	}

	/** Every known block, parents before children (by height). */
	loadBlocks(): BlockRecord[] {
		const rows = this._statement(
			'SELECT hash, height, prev, timestamp, bits, pos, work, tie, producer, tx_count, size, status, modifier FROM blocks ORDER BY height',
		).all() as {
			hash: Uint8Array;
			height: number;
			prev: Uint8Array;
			timestamp: number;
			bits: number;
			pos: number;
			work: string;
			tie: string;
			producer: string;
			tx_count: number;
			size: number;
			status: number;
			modifier: Uint8Array | null;
		}[];
		return rows.map((row) => ({
			hash: hex(row.hash),
			height: row.height,
			previousHash: hex(row.prev),
			timestamp: row.timestamp,
			bits: row.bits,
			isProofOfStake: row.pos === 1,
			work: BigInt(`0x${row.work}`),
			tieBreak: row.tie,
			producer: row.producer,
			txCount: row.tx_count,
			size: row.size,
			status: row.status,
			modifier: row.modifier === null ? null : hex(row.modifier),
		}));
	}

	/** Hash of the active block at `height`. */
	activeHash(height: number): string | undefined {
		const row = this._statement('SELECT hash FROM blocks WHERE status = 1 AND height = ?').get(height) as { hash: Uint8Array } | undefined;
		return row && hex(row.hash);
	}

	/** The active chain's tip; null when no block is active. */
	tip(): { hash: string; height: number } | null {
		const row = this._statement('SELECT hash, height FROM blocks WHERE status = 1 ORDER BY height DESC LIMIT 1').get() as
			| { hash: Uint8Array; height: number }
			| undefined;
		return row ? { hash: hex(row.hash), height: row.height } : null;
	}

	/** The newest active PoS block at `minHeight` or above that one of `addresses` staked. */
	lastStakedBy(addresses: readonly string[], minHeight: number): string | undefined {
		const row = this._statement(
			`SELECT hash FROM blocks WHERE status = 1 AND pos = 1 AND height >= ? AND producer IN (SELECT value FROM json_each(?))
			ORDER BY height DESC LIMIT 1`,
		).get(minHeight, JSON.stringify(addresses)) as { hash: Uint8Array } | undefined;
		return row && hex(row.hash);
	}

	/** Stake modifiers after each active block, from genesis on. */
	activeModifiers(): string[] {
		const rows = this._statement('SELECT modifier FROM blocks WHERE status = 1 ORDER BY height').all() as { modifier: Uint8Array }[];
		return rows.map((row) => hex(row.modifier));
	}

	// --- connecting and disconnecting the tip ---

	/** Make a recorded block the active tip: one transaction. */
	connect(change: ConnectChange): void {
		this.transaction(() => {
			const hash = bin(change.hash);
			this._statement('UPDATE blocks SET status = 1, modifier = ? WHERE hash = ?').run(bin(change.modifier), hash);
			this._statement('INSERT INTO undo (hash, spent) VALUES (?, ?) ON CONFLICT (hash) DO UPDATE SET spent = excluded.spent').run(
				hash,
				encodeUndo(change.spent),
			);
			const remove = this._statement('DELETE FROM utxos WHERE txid = ? AND n = ?');
			for (const utxo of change.spent) remove.run(bin(utxo.txHash), utxo.outputIndex);
			const add = this._statement(
				'INSERT INTO utxos (txid, n, address, amount, height, flags, tx_time, block_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
			);
			for (const utxo of change.created) {
				add.run(bin(utxo.txHash), utxo.outputIndex, utxo.output.address, utxo.output.amount, utxo.blockIndex, flagsOf(utxo), utxo.txTimestamp, utxo.blockTimestamp);
			}
			const tx = this._statement('INSERT INTO txs (txid, height, position) VALUES (?, ?, ?)');
			change.txids.forEach((txid, position) => tx.run(bin(txid), change.height, position));
			const before = this._statement('SELECT balance FROM activity WHERE address = ? ORDER BY height DESC, position DESC LIMIT 1', true);
			const activity = this._statement(
				'INSERT INTO activity (address, height, position, txid, received, sent, balance) VALUES (?, ?, ?, ?, ?, ?, ?)',
			);
			for (const flow of change.flows) {
				const balance = ((before.get(flow.address) as { balance: bigint } | undefined)?.balance ?? 0n) + flow.received - flow.sent;
				activity.run(flow.address, change.height, flow.indexInBlock, bin(flow.txid), flow.received, flow.sent, balance);
			}
		});
	}

	/**
	 * Undo the active tip `hash` at `height`: its outputs (`created`) leave the UTXO set, the
	 * outputs it spent come back. One transaction. Returns the outputs it spent.
	 */
	disconnect(hash: string, height: number, created: readonly { txHash: string; outputIndex: number }[]): UTXO[] {
		return this.transaction(() => {
			const spent = this.undo(hash);
			const remove = this._statement('DELETE FROM utxos WHERE txid = ? AND n = ?');
			for (const output of created) remove.run(bin(output.txHash), output.outputIndex);
			const add = this._statement(
				'INSERT INTO utxos (txid, n, address, amount, height, flags, tx_time, block_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
			);
			for (const utxo of spent) {
				add.run(bin(utxo.txHash), utxo.outputIndex, utxo.output.address, utxo.output.amount, utxo.blockIndex, flagsOf(utxo), utxo.txTimestamp, utxo.blockTimestamp);
			}
			this._statement('DELETE FROM txs WHERE height = ?').run(height);
			this._statement('DELETE FROM activity WHERE height = ?').run(height);
			this._statement('DELETE FROM undo WHERE hash = ?').run(bin(hash));
			this._statement('UPDATE blocks SET status = 0, modifier = NULL WHERE hash = ?').run(bin(hash));
			return spent;
		});
	}

	// --- reads ---

	/** The outputs an active block spent (empty for an unknown or inactive block). */
	undo(hash: string): UTXO[] {
		const row = this._statement('SELECT spent FROM undo WHERE hash = ?').get(bin(hash)) as { spent: string } | undefined;
		return row ? decodeUndo(row.spent) : [];
	}

	/** The UTXO set at the active tip. */
	loadUtxos(): UTXO[] {
		const rows = this._statement('SELECT txid, n, address, amount, height, flags, tx_time, block_time FROM utxos', true).all() as {
			txid: Uint8Array;
			n: bigint;
			address: string;
			amount: bigint;
			height: bigint;
			flags: bigint;
			tx_time: bigint;
			block_time: bigint;
		}[];
		return rows.map((row) => ({
			txHash: hex(row.txid),
			outputIndex: Number(row.n),
			output: { address: row.address, amount: row.amount },
			blockIndex: Number(row.height),
			isCoinbase: (row.flags & 1n) !== 0n,
			isCoinstake: (row.flags & 2n) !== 0n,
			txTimestamp: Number(row.tx_time),
			blockTimestamp: Number(row.block_time),
		}));
	}

	/** Where an active-chain transaction is: its block's height and its position in the block. */
	findTransaction(txid: string): { height: number; position: number } | undefined {
		return this._statement('SELECT height, position FROM txs WHERE txid = ?').get(bin(txid)) as { height: number; position: number } | undefined;
	}

	/** The address's transactions on the active chain, oldest first, with its balance after each. */
	history(address: string): AddressActivity[] {
		const rows = this._statement(
			'SELECT txid, height, position, received, sent, balance FROM activity WHERE address = ? ORDER BY height, position',
			true,
		).all(address) as { txid: Uint8Array; height: bigint; position: bigint; received: bigint; sent: bigint; balance: bigint }[];
		return rows.map((row) => ({
			txid: hex(row.txid),
			height: Number(row.height),
			indexInBlock: Number(row.position),
			received: row.received,
			sent: row.sent,
			balance: row.balance,
		}));
	}

	/** Whether the address appears on the active chain. */
	hasHistory(address: string): boolean {
		return this._statement('SELECT 1 FROM activity WHERE address = ? LIMIT 1').get(address) !== undefined;
	}
}
