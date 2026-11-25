// The chain database (TASK-0053) on its own: the block tree, connecting and disconnecting a
// tip in one transaction, and the lookups, in a real SQLite file in a temp dir.
import * as fs from 'fs';
import * as path from 'path';
import { BlockStatus, CHAIN_DB_VERSION, ChainDb, type BlockRecord, type ConnectChange } from '../../blockchain/ChainDb.js';
import type { UTXO } from '../../blockchain/UtxoSet.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const RULES = { powCutoffBlock: 1200, minStakeAge: 28_800 };
const A = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const B = '1NPmKcHrHPohgF12wEaswxRXVj8Z1VYiqX';
const hash = (n: number) => n.toString(16).padStart(64, '0');

function record(height: number, overrides: Partial<BlockRecord> = {}): BlockRecord {
	return {
		hash: hash(1000 + height),
		height,
		previousHash: height === 0 ? '0'.repeat(64) : hash(1000 + height - 1),
		timestamp: 1_700_000_000_000 + height * 30_000,
		bits: 0x1f00ffff,
		isProofOfStake: false,
		work: (1n << 200n) * BigInt(height + 1),
		tieBreak: hash(1000 + height),
		producer: A,
		txCount: 1,
		size: 250,
		status: BlockStatus.Stored,
		modifier: null,
		...overrides,
	};
}

function utxo(txid: number, outputIndex: number, address: string, amount: bigint, height: number): UTXO {
	return {
		txHash: hash(txid),
		outputIndex,
		output: { address, amount },
		blockIndex: height,
		isCoinbase: outputIndex === 0,
		isCoinstake: false,
		txTimestamp: 1_700_000_000_000 + height * 30_000,
		blockTimestamp: 1_700_000_000_000 + height * 30_000,
	};
}

describe('ChainDb', () => {
	let dir: string;
	let db: ChainDb;
	const file = () => path.join(dir, 'chain.db');

	beforeEach(() => {
		dir = makeTempDir();
		db = new ChainDb(file());
	});

	afterEach(() => {
		db.close();
		removeTempDir(dir);
	});

	/** Genesis (one output to A) and block 1: A pays B 3 of its 10, keeps 7. */
	function twoBlocks(): { genesis: ConnectChange; block1: ConnectChange } {
		db.reset(RULES);
		db.addBlock(record(0));
		db.addBlock(record(1));
		const coinbase0 = utxo(1, 0, A, 10n, 0);
		const genesis: ConnectChange = {
			hash: hash(1000),
			height: 0,
			modifier: hash(5000),
			spent: [],
			created: [coinbase0],
			txids: [hash(1)],
			flows: [{ txid: hash(1), indexInBlock: 0, address: A, received: 10n, sent: 0n }],
		};
		const block1: ConnectChange = {
			hash: hash(1001),
			height: 1,
			modifier: hash(5001),
			spent: [coinbase0],
			created: [utxo(2, 0, A, 5n, 1), utxo(3, 0, B, 3n, 1), utxo(3, 1, A, 7n, 1)],
			txids: [hash(2), hash(3)],
			flows: [
				{ txid: hash(2), indexInBlock: 0, address: A, received: 5n, sent: 0n },
				{ txid: hash(3), indexInBlock: 1, address: A, received: 7n, sent: 10n },
				{ txid: hash(3), indexInBlock: 1, address: B, received: 3n, sent: 0n },
			],
		};
		db.connect(genesis);
		db.connect(block1);
		return { genesis, block1 };
	}

	const outpoints = (utxos: UTXO[]) => utxos.map((u) => `${u.txHash.slice(-4)}:${u.outputIndex}=${u.output.amount}`).sort();

	it('should start empty and record the version and rules a reset sets', () => {
		expect(db.describe()).toBeNull();
		expect(db.tip()).toBeNull();
		db.reset(RULES);
		expect(db.describe()).toEqual({ version: CHAIN_DB_VERSION, rules: RULES });
	});

	it('should keep every field of a block record, and a record added twice once', () => {
		const pos = record(7, { isProofOfStake: true, tieBreak: hash(77), producer: B, txCount: 3, size: 900, work: (1n << 255n) + 12345n });
		db.addBlock(pos);
		db.addBlock({ ...pos, size: 1 }); // ignored: the first record stays
		db.addBlock(record(6));
		expect(db.loadBlocks()).toEqual([record(6), pos]);
		expect(db.hasBlock(pos.hash)).toBe(true);
		expect(db.hasBlock(hash(1))).toBe(false);
		db.markInvalid(pos.hash);
		expect(db.loadBlocks()[1].status).toBe(BlockStatus.Invalid);
	});

	it('should connect blocks: the UTXO set, undo data, modifiers, txids and address histories', () => {
		twoBlocks();

		expect(db.tip()).toEqual({ hash: hash(1001), height: 1 });
		expect(db.activeHash(0)).toBe(hash(1000));
		expect(db.activeModifiers()).toEqual([hash(5000), hash(5001)]);
		expect(db.loadBlocks().map((b) => [b.status, b.modifier])).toEqual([
			[BlockStatus.Active, hash(5000)],
			[BlockStatus.Active, hash(5001)],
		]);
		expect(outpoints(db.loadUtxos())).toEqual(['0002:0=5', '0003:0=3', '0003:1=7']);
		expect(db.loadUtxos().find((u) => u.txHash === hash(2))).toEqual(utxo(2, 0, A, 5n, 1));
		expect(db.undo(hash(1001))).toEqual([utxo(1, 0, A, 10n, 0)]);
		expect(db.findTransaction(hash(3))).toEqual({ height: 1, position: 1 });
		expect(db.findTransaction(hash(9))).toBeUndefined();
		expect(db.history(A).map((e) => [e.height, e.indexInBlock, e.received, e.sent, e.balance])).toEqual([
			[0, 0, 10n, 0n, 10n],
			[1, 0, 5n, 0n, 15n],
			[1, 1, 7n, 10n, 12n],
		]);
		expect(db.history(B)).toEqual([{ txid: hash(3), height: 1, indexInBlock: 1, received: 3n, sent: 0n, balance: 3n }]);
		expect(db.hasHistory(B)).toBe(true);
		expect(db.hasHistory('1111111111111111111114oLvT2')).toBe(false);
	});

	it('should disconnect the tip back to exactly the state before it', () => {
		const { block1 } = twoBlocks();

		const spent = db.disconnect(block1.hash, 1, block1.created);

		expect(spent).toEqual([utxo(1, 0, A, 10n, 0)]);
		expect(db.tip()).toEqual({ hash: hash(1000), height: 0 });
		expect(outpoints(db.loadUtxos())).toEqual(['0001:0=10']);
		expect(db.undo(hash(1001))).toEqual([]);
		expect(db.findTransaction(hash(3))).toBeUndefined();
		expect(db.history(A).map((e) => e.balance)).toEqual([10n]);
		expect(db.hasHistory(B)).toBe(false);
		expect(db.activeModifiers()).toEqual([hash(5000)]);
		expect(db.loadBlocks()[1]).toEqual(record(1)); // stored again, no modifier

		db.connect(block1); // and back
		expect(db.history(A).map((e) => e.balance)).toEqual([10n, 15n, 12n]);
	});

	it('should write nothing of a connect that fails part way', () => {
		const { block1 } = twoBlocks();
		db.addBlock(record(2));
		const bad: ConnectChange = { ...block1, hash: hash(1002), height: 2, spent: [], created: [], flows: [] }; // reuses block 1's txids

		expect(() => db.connect(bad)).toThrow(/UNIQUE constraint failed/);

		expect(db.tip()).toEqual({ hash: hash(1001), height: 1 });
		expect(db.loadBlocks()[2].status).toBe(BlockStatus.Stored);
		expect(db.undo(hash(1002))).toEqual([]);
		expect(db.findTransaction(hash(2))).toEqual({ height: 1, position: 0 });
	});

	it('should keep the writes of a batch until commit, and drop them all on rollback', () => {
		twoBlocks();
		db.addBlock(record(2));
		const block2: ConnectChange = {
			hash: hash(1002),
			height: 2,
			modifier: hash(5002),
			spent: [],
			created: [utxo(4, 0, B, 1n, 2)],
			txids: [hash(4)],
			flows: [{ txid: hash(4), indexInBlock: 0, address: B, received: 1n, sent: 0n }],
		};
		const other = new ChainDb(file()); // another connection sees only what is committed

		db.begin();
		db.connect(block2);
		expect(db.tip()?.height).toBe(2);
		expect(other.tip()?.height).toBe(1);
		db.rollback();
		expect(db.tip()?.height).toBe(1);
		expect(db.history(B)).toHaveLength(1);
		expect(db.findTransaction(hash(4))).toBeUndefined();

		db.begin();
		db.connect(block2);
		db.commit();
		expect(other.tip()?.height).toBe(2);
		expect(other.history(B)).toHaveLength(2);
		other.close();
	});

	it('should keep amounts beyond 2^53 exact', () => {
		db.reset(RULES);
		db.addBlock(record(0));
		const large = (1n << 62n) + 1n;
		db.connect({
			hash: hash(1000),
			height: 0,
			modifier: hash(5000),
			spent: [],
			created: [utxo(1, 0, A, large, 0)],
			txids: [hash(1)],
			flows: [{ txid: hash(1), indexInBlock: 0, address: A, received: large, sent: 0n }],
		});
		expect(db.loadUtxos()[0].output.amount).toBe(large);
		expect(db.history(A)[0].balance).toBe(large);
	});

	it('should keep everything across a reopen, and empty it on reset', () => {
		twoBlocks();
		db.close();
		db = new ChainDb(file());

		expect(db.describe()?.rules).toEqual(RULES);
		expect(db.tip()?.height).toBe(1);
		expect(db.history(A)).toHaveLength(3);

		db.reset({ ...RULES, powCutoffBlock: 20 });
		expect(db.tip()).toBeNull();
		expect(db.loadUtxos()).toEqual([]);
		expect(db.history(A)).toEqual([]);
		expect(db.describe()?.rules.powCutoffBlock).toBe(20);
		expect(fs.existsSync(file())).toBe(true);
	});
});
