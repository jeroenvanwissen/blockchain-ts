// Saved chainstate (TASK-0029): startup takes the validated state at a saved tip and validates
// only the blocks after it, if it was validated under the same rules. Whatever the path, the live
// state must equal a full replay.
import * as fs from 'fs';
import * as path from 'path';
import type { Block } from '../../blockchain/Block.js';
import { Blockchain } from '../../blockchain/Blockchain.js';
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
	removeTempDir,
	stakeBlocks,
	useTestClock,
} from './helpers.js';

const SPACING = BLOCK_TIME * 1000;

const extend = (branch: Block[], miner: Wallet, count: number) => extendBranch(branch, miner.address, count);

/** Live state equals a fresh full replay of the active chain. */
function expectConsistent(chain: Blockchain): void {
	const sorted = (map: Map<string, unknown>) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
	const replay = chain['_replayChain'](chain.getChain());
	expect(sorted(chain['_utxos']['_byOutpoint'])).toEqual(sorted(replay.utxos['_byOutpoint']));
	expect(chain['_modifiers']).toEqual(replay.modifiers);
	expect(chain.getChain().map((block) => chain['_undo'].get(block.hash) ?? [])).toEqual(replay.undo);
}

describe('Saved chainstate', () => {
	let dir: string;
	let miner: Wallet;
	let connects: jest.SpyInstance;

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
		useTestClock();
		jest.spyOn(console, 'log').mockImplementation(() => {});
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
		connects = jest.spyOn(Blockchain.prototype as unknown as { _connectBlock: () => unknown }, '_connectBlock');
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

	it('should start from the saved chainstate and validate only the newer blocks', async () => {
		const chain = await chainWithPayments();
		chain.saveChainstate();
		await chain.addTransaction(chain.createPayment(miner, [{ address: openWallet(dir, 'c').address, amount: COIN }]).transaction);
		await mineBlocks(chain, miner.address, 3);

		const { chain: reopened, validated } = reopen();

		expect(validated).toBe(3);
		expect(reopened.getLatestBlock().hash).toBe(chain.getLatestBlock().hash);
		expectConsistent(reopened);
	});

	it('should replay everything when the saved tip is no longer on the best branch', async () => {
		const chain = await chainWithPayments();
		const prefix = chain.getChain().slice(0, -2);
		chain.saveChainstate(); // at a tip that is about to be reorganized away
		advanceTime(SPACING * 10);
		const other = openWallet(dir, 'other'); // so the branch's blocks differ from the replaced ones
		for (const block of extend(prefix, other, 4).slice(prefix.length)) await chain.addMinedBlock(block);

		const { chain: reopened, validated } = reopen();

		expect(validated).toBe(reopened.getChain().length - 1);
		expect(reopened.getLatestBlock().hash).toBe(chain.getLatestBlock().hash);
		expectConsistent(reopened);
	});

	it('should reorganize below the saved tip after starting from it, using its undo data', async () => {
		const chain = await chainWithPayments();
		const prefix = chain.getChain().slice(0, -3); // below the second payment
		chain.saveChainstate();
		const { chain: reopened, validated } = reopen();
		expect(validated).toBe(0);

		advanceTime(SPACING * 10);
		const other = openWallet(dir, 'other'); // so the branch's blocks differ from the replaced ones
		for (const block of extend(prefix, other, 5).slice(prefix.length)) await reopened.addMinedBlock(block);

		expect(reopened.getChain()).toHaveLength(prefix.length + 5);
		expect(reopened.getPendingTransactions()).toHaveLength(1); // the payment from the old branch
		expectConsistent(reopened);
	});

	it('should ignore a damaged chainstate, and any chainstate with useChainstate: false (--reindex)', async () => {
		const chain = await chainWithPayments();
		chain.saveChainstate();
		const file = path.join(dir, 'blocks', 'chainstate.json');
		const length = chain.getChain().length;

		expect(reopen({ useChainstate: false }).validated).toBe(length - 1);

		const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
		fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"height":\d+/, '"height":1'));
		const damaged = reopen();
		expect(damaged.validated).toBe(length - 1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignoring the saved chainstate: checksum mismatch'));
		expectConsistent(damaged.chain);
	});

	it('should validate every block when the chainstate was saved under other rules, dropping those they reject', async () => {
		// A node that staked after the old PoW phase starts with a longer one (TASK-0051)
		const chain = openPosChain(dir);
		await finishPowPhase(chain, miner.address);
		await stakeBlocks(chain, miner, 2);
		chain.saveChainstate();
		const warn = jest.spyOn(console, 'error').mockImplementation(() => {});

		const { chain: reopened, validated } = reopen({ powCutoffBlock: POS_TEST_CUTOFF + 10 });

		// From genesis: the PoW blocks and the first PoS block, which fails; then the PoW blocks again
		expect(validated).toBe(2 * POS_TEST_CUTOFF + 1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(`validated with other consensus rules (PoW until block ${POS_TEST_CUTOFF}`));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(`PoS blocks not accepted before block ${POS_TEST_CUTOFF + 11}`));
		expect(reopened.getChain()).toHaveLength(POS_TEST_CUTOFF + 1);
		expectConsistent(reopened);
		await mineBlocks(reopened, miner.address, 1); // the PoW phase goes on
		expect(reopened.getLatestBlock().isProofOfWork()).toBe(true);

		reopened.saveChainstate(); // under the new rules: used at the next start
		warn.mockClear();
		const again = reopen({ powCutoffBlock: POS_TEST_CUTOFF + 10 }).chain;
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('other consensus rules'));
		expect(again.getLatestBlock().hash).toBe(reopened.getLatestBlock().hash);
		expectConsistent(again);
	});

	it('should save the chainstate every chainstateInterval blocks', async () => {
		const chain = openChain(dir, { chainstateInterval: 5 });
		await mineBlocks(chain, miner.address, 7);

		const saved = JSON.parse(fs.readFileSync(path.join(dir, 'blocks', 'chainstate.json'), 'utf8').split('\n')[1]) as {
			height: number;
			tip: string;
		};
		expect(saved.height).toBe(5);
		expect(saved.tip).toBe(chain.getChain()[5].hash);
		expect(reopen().validated).toBe(2);
	});
});
