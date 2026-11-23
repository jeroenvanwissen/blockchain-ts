// Block tree and reorganizations (TASK-0012): side branches are stored, the branch with the
// most work wins, and state after any sequence of reorgs equals a fresh replay of the chain.
import { Block } from '../../blockchain/Block.js';
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { requiredBits } from '../../blockchain/retarget.js';
import { Transaction } from '../../blockchain/Transaction.js';
import type { Wallet } from '../../blockchain/Wallet.js';
import { BLOCK_TIME, COIN, COIN_MATURITY, POW_BLOCK_REWARD } from '../../config.js';
import {
	advanceTime,
	makeTempDir,
	mineBlocks,
	openChain,
	openWallet,
	removeTempDir,
	useTestClock,
} from './helpers.js';

const SPACING = BLOCK_TIME * 1000;

/** A solved PoW block on top of `branch` (which may be a side branch). */
function blockOn(branch: Block[], miner: Wallet, txs: Transaction[] = []): Block {
	const parent = branch[branch.length - 1];
	const height = branch.length;
	const timestamp = parent.timestamp + SPACING;
	const block = new Block(
		timestamp,
		[Transaction.coinbase(miner.address, POW_BLOCK_REWARD, height, timestamp), ...txs],
		parent.hash,
		0,
		requiredBits(branch, height, false),
		height,
	);
	block.solve();
	return block;
}

/** Extend `branch` by `count` blocks (not added to any chain). */
function extend(branch: Block[], miner: Wallet, count: number): Block[] {
	const result = [...branch];
	for (let i = 0; i < count; i++) result.push(blockOn(result, miner));
	return result;
}

function utxoSnapshot(chain: Blockchain): [string, unknown][] {
	return [...chain['_utxos']['_byOutpoint'].entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Live state must equal a fresh replay of the active chain. */
function expectConsistent(chain: Blockchain): void {
	const replay = chain['_replayChain'](chain.getChain());
	expect(utxoSnapshot(chain)).toEqual(
		[...replay.utxos['_byOutpoint'].entries()].sort(([a], [b]) => a.localeCompare(b)),
	);
	expect(chain['_modifiers']).toEqual(replay.modifiers);
}

describe('Block tree and reorganizations', () => {
	let dir: string;
	const extraDirs: string[] = [];
	const makeTempDirTracked = (): string => {
		const extra = makeTempDir();
		extraDirs.push(extra);
		return extra;
	};
	let a: Wallet;
	let b: Wallet;
	let chain: Blockchain;

	beforeEach(async () => {
		process.env.NODE_ENV = 'test';
		useTestClock();
		jest.spyOn(console, 'log').mockImplementation(() => {});
		dir = makeTempDir();
		a = openWallet(dir, 'a');
		b = openWallet(dir, 'b');
		chain = openChain(dir);
		await mineBlocks(chain, a.address, COIN_MATURITY + 1); // common prefix
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
		removeTempDir(dir);
		extraDirs.splice(0).forEach(removeTempDir);
	});

	/** Branch A (active): prefix + A1 (with a payment) + A2. Returns the payment and the prefix. */
	async function activeBranchWithPayment() {
		const prefix = [...chain.getChain()];
		const payment = chain.createTransaction(a.address, openWallet(dir, 'x').address, COIN, a);
		await chain.addTransaction(payment);
		await mineBlocks(chain, a.address, 2);
		expect(chain.getPendingTransactions()).toHaveLength(0);
		return { prefix, payment };
	}

	it('should store a lighter side branch without switching to it', async () => {
		await mineBlocks(chain, a.address, 2);
		const tip = chain.getLatestBlock().hash;
		const side = blockOn(chain.getChain().slice(0, -2), b); // competes with the tip's parent

		await expect(chain.addMinedBlock(side)).resolves.toBe('side');
		expect(chain.getLatestBlock().hash).toBe(tip);
		expect(chain.hasBlock(side.hash)).toBe(true);
	});

	it('should reorganize to the branch with more work and match a fresh rebuild', async () => {
		const { prefix, payment } = await activeBranchWithPayment();
		const branchB = extend(prefix, b, 3);
		advanceTime(SPACING * 2);

		const tipA = chain.getLatestBlock();
		const [b1, b2, b3] = branchB.slice(prefix.length);

		await expect(chain.addMinedBlock(b1)).resolves.toBe('side');
		// Equal work with the tip: the lower tip hash wins the tie
		const tie = await chain.addMinedBlock(b2);
		expect(tie).toBe(b2.hash < tipA.hash ? 'reorganized' : 'side');
		await expect(chain.addMinedBlock(b3)).resolves.toBe(tie === 'reorganized' ? 'connected' : 'reorganized');

		expect(chain.getLatestBlock().hash).toBe(branchB[branchB.length - 1].hash);
		// The payment was only in branch A: it is back in the mempool
		expect(chain.getPendingTransactions().map((tx) => tx.calculateHash())).toEqual([
			payment.calculateHash(),
		]);
		expectConsistent(chain);
	});

	it('should reorganize back and forth and stay consistent', async () => {
		const { prefix, payment } = await activeBranchWithPayment();
		const branchA = [...chain.getChain()];
		const branchB = extend(prefix, b, 3);
		advanceTime(SPACING * 10);
		for (const block of branchB.slice(prefix.length)) await chain.addMinedBlock(block);
		expectConsistent(chain);

		// Branch A comes back with more work: the payment is confirmed again
		const longerA = extend(branchA, a, 2);
		for (const block of longerA.slice(branchA.length)) await chain.addMinedBlock(block);

		expect(chain.getLatestBlock().hash).toBe(longerA[longerA.length - 1].hash);
		expect(chain.getPendingTransactions()).toHaveLength(0);
		expect(chain.getChain().some((block) =>
			block.transactions.some((tx) => tx.calculateHash() === payment.calculateHash()),
		)).toBe(true);
		expectConsistent(chain);
		expect(chain.isChainValid()).toBe(true);
	});

	it('should restore the active tip after a restart, with side branches on disk', async () => {
		const { prefix } = await activeBranchWithPayment();
		const sideTip = chain.getLatestBlock().hash;
		const branchB = extend(prefix, b, 3);
		advanceTime(SPACING * 2);
		for (const block of branchB.slice(prefix.length)) await chain.addMinedBlock(block);

		const reopened = openChain(dir);
		expect(reopened.getLatestBlock().hash).toBe(chain.getLatestBlock().hash);
		expect(reopened.hasBlock(sideTip)).toBe(true);
		expectConsistent(reopened);
	});

	it('should keep the old chain when the heavier branch contains an invalid block', async () => {
		await mineBlocks(chain, a.address, 2);
		const tip = chain.getLatestBlock().hash;
		const before = utxoSnapshot(chain);
		const fork = chain.getChain().slice(0, -2);
		const fromNothing = new Transaction(
			[{ previousTx: 'cd'.repeat(32), outputIndex: 0, publicKey: '', signature: '' }],
			[{ address: b.address, amount: COIN }],
		);
		b.signTransaction(fromNothing);
		const b1 = blockOn(fork, b);
		const b2 = blockOn([...fork, b1], b, [fromNothing]); // invalid, but its header is fine
		const b3 = blockOn([...fork, b1, b2], b);
		advanceTime(SPACING * 2);

		// b2 ties the tip and b3 beats it, so the reorg attempt (and its failure) can come from
		// either call depending on the tie-break; the outcome is the same
		const errors: string[] = [];
		for (const block of [b1, b2, b3]) {
			try {
				await chain.addMinedBlock(block);
			} catch (error) {
				errors.push((error as Error).message);
			}
		}

		expect(errors.some((e) => e.includes('transaction 1: input references a missing or spent output'))).toBe(true);
		expect(chain.getLatestBlock().hash).toBe(tip);
		expect(utxoSnapshot(chain)).toEqual(before);
		expect(chain['_index'].get(b2.hash)?.isInvalid).toBe(true);
		await expect(chain.addMinedBlock(blockOn([...fork, b1, b2], a))).rejects.toThrow(
			'parent block is invalid',
		);
	});

	it('should break equal-work ties by the lower block hash, whatever the arrival order', async () => {
		const parent = [...chain.getChain()];
		const x = blockOn(parent, a);
		const y = blockOn(parent, b);
		const [low, high] = x.hash < y.hash ? [x, y] : [y, x];

		await chain.addMinedBlock(high);
		await expect(chain.addMinedBlock(low)).resolves.toBe('reorganized');
		expect(chain.getLatestBlock().hash).toBe(low.hash);

		const other = openChain(makeTempDirTracked());
		for (const block of parent.slice(1)) await other.addMinedBlock(block);
		await other.addMinedBlock(low);
		await expect(other.addMinedBlock(high)).resolves.toBe('side');
		expect(other.getLatestBlock().hash).toBe(low.hash);
	});

	it('should keep pending transactions that a new block does not include', async () => {
		const payment = chain.createTransaction(a.address, b.address, COIN, a);
		await chain.addTransaction(payment);

		await chain.addMinedBlock(blockOn([...chain.getChain()], b)); // a peer's block without it

		expect(chain.getPendingTransactions().map((tx) => tx.calculateHash())).toEqual([
			payment.calculateHash(),
		]);
	});
});
