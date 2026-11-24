// The chain database at startup (TASK-0053; it replaces the saved chainstate of TASK-0029): a
// node starts from the state the database holds for its tip and validates only the blocks stored
// after it. Whatever the path, the live state must equal a full replay.
import * as fs from 'fs';
import * as path from 'path';
import { Blockchain } from '../../blockchain/Blockchain.js';
import { BlockStore } from '../../blockchain/BlockStore.js';
import { ChainDb } from '../../blockchain/ChainDb.js';
import { outpointKey } from '../../blockchain/UtxoSet.js';
import type { Wallet } from '../../blockchain/Wallet.js';
import { BLOCK_TIME, COIN, COIN_MATURITY } from '../../config.js';
import {
	advanceTime,
	extendBranch,
	finishPowPhase,
	makeTempDir,
	mineBlocks,
	openChain,
	openPosChain,
	openWallet,
	POS_TEST_CUTOFF,
	powBlockOn,
	removeTempDir,
	stakeBlocks,
	useTestClock,
} from './helpers.js';

const SPACING = BLOCK_TIME * 1000;

/** Live state, in memory and in the database, equals a fresh full replay of the active chain. */
function expectConsistent(chain: Blockchain): void {
	const sorted = (map: Map<string, unknown>) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
	const blocks = chain.getChain();
	const replay = chain['_replayChain'](blocks);
	const db = chain['_db'];
	expect(sorted(chain['_utxos']['_byOutpoint'])).toEqual(sorted(replay.utxos['_byOutpoint']));
	expect(sorted(new Map(db.loadUtxos().map((u) => [outpointKey(u.txHash, u.outputIndex), u])))).toEqual(sorted(replay.utxos['_byOutpoint']));
	expect(chain['_modifiers']).toEqual(replay.modifiers);
	expect(db.activeModifiers()).toEqual(replay.modifiers);
	expect(blocks.map((block) => db.undo(block.hash))).toEqual(replay.undo);
	expect(db.tip()).toEqual({ hash: chain.getLatestBlock().hash, height: blocks.length - 1 });
}

describe('Chain database', () => {
	let dir: string;
	let miner: Wallet;
	let warn: jest.SpyInstance;
	let info: jest.SpyInstance;
	const blocksDir = () => path.join(dir, 'blocks');
	const dbFile = () => path.join(blocksDir(), 'chain.db');
	const logged = (spy: jest.SpyInstance) => spy.mock.calls.map((call) => String(call[0])).join('\n');

	beforeEach(() => {
		useTestClock();
		info = jest.spyOn(console, 'log').mockImplementation(() => {});
		warn = jest.spyOn(console, 'error').mockImplementation(() => {});
		dir = makeTempDir();
		miner = openWallet(dir, 'miner');
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
		removeTempDir(dir);
	});

	/** Reopen the stored chain, counting the blocks validated on the way. */
	function reopen(options = {}): { chain: Blockchain; validated: number } {
		const connects = jest.spyOn(Blockchain.prototype as unknown as { _connectBlock: () => unknown }, '_connectBlock');
		const chain = openChain(dir, options);
		const validated = connects.mock.calls.length;
		connects.mockRestore();
		return { chain, validated };
	}

	/** A chain with spends (so outputs, undo data and stake modifiers all matter). */
	async function chainWithPayments(): Promise<Blockchain> {
		const chain = openChain(dir);
		await mineBlocks(chain, miner.address, COIN_MATURITY + 2);
		for (const name of ['a', 'b']) {
			await chain.addTransaction(chain.createPayment(miner, [{ address: openWallet(dir, name).address, amount: COIN }]).transaction);
			await mineBlocks(chain, miner.address, 2);
		}
		return chain;
	}

	it('should start from the chain database without validating a block', async () => {
		const chain = await chainWithPayments();
		chain.close();

		const { chain: reopened, validated } = reopen();

		expect(validated).toBe(0);
		expect(reopened.getLatestBlock().hash).toBe(chain.getLatestBlock().hash);
		expect(logged(info)).toContain(`chain database at height ${chain.getChain().length - 1}; validated 0 newer block(s)`);
		expectConsistent(reopened);
	});

	it('should start without reading the stored blocks: only genesis (to check it) and the tip', async () => {
		const chain = await chainWithPayments();
		chain.close();
		const reads = jest.spyOn(BlockStore.prototype, 'getBlock');
		const loads = jest.spyOn(BlockStore.prototype, 'loadAllBlocks');

		const { chain: reopened } = reopen();

		const read = reads.mock.calls.map(([hash]) => hash);
		expect(loads).not.toHaveBeenCalled();
		expect(read).toEqual([reopened.getHeader(0)!.hash, reopened.getLatestBlock().hash]);
		expect(reopened.getHeight()).toBe(chain.getHeight());
	});

	it('should validate and connect a block stored after the database\'s tip (a stop between the two writes)', async () => {
		const chain = await chainWithPayments();
		advanceTime(SPACING);
		const next = chain.createBlockTemplate(miner.address, Date.now());
		next.solve();
		chain.close();
		new BlockStore(blocksDir()).appendBlock(next); // in the block files, not in the database

		const { chain: reopened, validated } = reopen();

		expect(validated).toBe(1);
		expect(reopened.getLatestBlock().hash).toBe(next.hash);
		expectConsistent(reopened);
	});

	it('should reorganize at startup to a stored branch with more work', async () => {
		const chain = await chainWithPayments();
		const prefix = chain.getChain().slice(0, -2);
		chain.close();
		advanceTime(SPACING * 10);
		const branch = extendBranch(prefix, openWallet(dir, 'other').address, 4).slice(prefix.length);
		const store = new BlockStore(blocksDir());
		for (const block of branch) store.appendBlock(block);

		const { chain: reopened, validated } = reopen();

		expect(validated).toBe(4);
		expect(reopened.getLatestBlock().hash).toBe(branch[3].hash);
		expect(logged(info)).toContain('reorganized');
		expectConsistent(reopened);
	});

	it('should reorganize below the tip it started from, with the undo data in the database', async () => {
		const chain = await chainWithPayments();
		const prefix = chain.getChain().slice(0, -3); // below the second payment
		chain.close();
		const { chain: reopened, validated } = reopen();
		expect(validated).toBe(0);

		advanceTime(SPACING * 10);
		const other = openWallet(dir, 'other'); // so the branch's blocks differ from the replaced ones
		for (const block of extendBranch(prefix, other.address, 5).slice(prefix.length)) await reopened.addMinedBlock(block);

		expect(reopened.getChain()).toHaveLength(prefix.length + 5);
		expect(reopened.getPendingTransactions()).toHaveLength(1); // the payment from the old branch
		expectConsistent(reopened);
		expectConsistent(reopen().chain); // and from the database after that
	});

	it('should rebuild the database with reindex, and when it is missing, unreadable or from another version', async () => {
		const chain = await chainWithPayments();
		const length = chain.getChain().length;
		chain.close();
		const rebuilds: [string, () => void][] = [
			['--reindex', () => {}],
			['building the chain database from the stored blocks', () => fs.rmSync(dbFile())],
			['the chain database is unreadable', () => fs.writeFileSync(dbFile(), 'not a database')],
			[
				'rebuilding the chain database: it is from another version (99)',
				() => {
					const db = new ChainDb(dbFile());
					db['_setMeta']('version', '99');
					db.close();
				},
			],
		];

		for (const [message, damage] of rebuilds) {
			for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbFile()}${suffix}`, { force: true });
			damage();
			info.mockClear();
			warn.mockClear();
			const { chain: reopened, validated } = reopen(message === '--reindex' ? { reindex: true } : {});

			expect(validated).toBe(length - 1);
			expect(`${logged(info)}\n${logged(warn)}`).toContain(message);
			expect(logged(info)).toContain(`chain database built: validated ${length - 1} stored block(s), height ${length - 1}`);
			expectConsistent(reopened);
			reopened.close(); // the next round damages its file
		}
	});

	it('should rebuild under other consensus rules, drop the blocks they reject, and not try those again', async () => {
		// A node that staked after a 12-block PoW phase starts with a 22-block one (TASK-0051)
		const chain = openPosChain(dir);
		await finishPowPhase(chain, miner.address);
		await stakeBlocks(chain, miner, 2);
		chain.close();

		const { chain: reopened, validated } = reopen({ powCutoffBlock: POS_TEST_CUTOFF + 10 });

		expect(logged(warn)).toContain(`it was built under other consensus rules (PoW until block ${POS_TEST_CUTOFF}`);
		expect(logged(warn)).toContain(`PoS blocks not accepted before block ${POS_TEST_CUTOFF + 11}`);
		expect(validated).toBe(POS_TEST_CUTOFF + 1); // the PoW blocks once (they stay active), then the first PoS block fails
		expect(reopened.getChain()).toHaveLength(POS_TEST_CUTOFF + 1);
		expectConsistent(reopened);
		await mineBlocks(reopened, miner.address, 1); // the PoW phase goes on
		expect(reopened.getLatestBlock().isProofOfWork()).toBe(true);
		reopened.close();

		warn.mockClear();
		const again = reopen({ powCutoffBlock: POS_TEST_CUTOFF + 10 });
		expect(again.validated).toBe(0); // the invalid PoS branch is marked so in the database
		expect(logged(warn)).toBe('');
		expect(again.chain.getLatestBlock().hash).toBe(reopened.getLatestBlock().hash);
		expectConsistent(again.chain);
	});

	it('should remove the chainstate.json of earlier versions', async () => {
		const chain = await chainWithPayments();
		chain.close();
		fs.rmSync(dbFile());
		fs.writeFileSync(path.join(blocksDir(), 'chainstate.json'), '{}');

		reopen();

		expect(fs.existsSync(path.join(blocksDir(), 'chainstate.json'))).toBe(false);
		expect(logged(info)).toContain('removed chainstate.json: the chain database replaces it');
	});

	it('should leave memory and database as they were when writing a block fails', async () => {
		const chain = await chainWithPayments();
		const tip = chain.getLatestBlock().hash;
		const block = powBlockOn(chain.getChain(), miner.address);
		const connect = jest.spyOn(ChainDb.prototype, 'connect').mockImplementationOnce(() => {
			throw new Error('disk full');
		});

		await expect(chain.addMinedBlock(block)).rejects.toThrow(`could not store block ${block.index}: disk full`);

		connect.mockRestore();
		expect(chain.getLatestBlock().hash).toBe(tip);
		expect(chain.hasBlock(block.hash)).toBe(false);
		expectConsistent(chain);
	});
});

