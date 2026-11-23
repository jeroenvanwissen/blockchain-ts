// Real worker thread, real filesystem, real timers, real difficulty: a fresh chain starts
// at POW_LIMIT (~65k hashes per block) and only a few blocks are mined, so the retarget
// barely tightens the target.
import * as path from 'path';
import type { Block } from '../../blockchain/Block.js';
import { Blockchain } from '../../blockchain/Blockchain.js';
import { Miner } from '../../blockchain/Miner.js';
import { POW_BLOCK_REWARD } from '../../config.js';
import { targetToBits } from '../../blockchain/target.js';
import { makeTempDir, openChain, openWallet, removeTempDir } from './helpers.js';

const WORKER_PATH = path.join(process.cwd(), 'src', 'blockchain', 'miningWorker.cjs');

async function waitUntil(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe('Miner (real worker thread)', () => {
	let dir: string;
	let chain: Blockchain;
	let miner: Miner | null;

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
		jest.spyOn(console, 'log').mockImplementation(() => {});
		dir = makeTempDir();
		chain = openChain(dir);
		miner = null;
	});

	afterEach(async () => {
		await miner?.stop();
		jest.restoreAllMocks();
		removeTempDir(dir);
	});

	it('should mine valid blocks that persist across reopen', async () => {
		const wallet = openWallet(dir, 'miner');
		const mined: Block[] = [];
		miner = new Miner(chain, wallet.address, WORKER_PATH, (block) => mined.push(block));

		miner.start();
		await waitUntil(() => chain.getChain().length >= 4);
		await miner.stop();

		const blocks = chain.getChain().slice(1);
		expect(mined.map((b) => b.hash)).toEqual(blocks.slice(0, mined.length).map((b) => b.hash));
		for (const block of blocks) {
			expect(block.isValid()).toBe(true);
			expect(block.transactions[0].outputs).toEqual([
				{ address: wallet.address, amount: POW_BLOCK_REWARD },
			]);
		}
		const reopened = openChain(dir);
		expect(reopened.getChain().map((b) => b.hash)).toEqual(chain.getChain().map((b) => b.hash));
	});

	it('should keep mining after a rejected block', async () => {
		const wallet = openWallet(dir, 'miner');
		const addMinedBlock = chain.addMinedBlock.bind(chain);
		const spy = jest
			.spyOn(chain, 'addMinedBlock')
			.mockRejectedValueOnce(new Error('simulated rejection'))
			.mockImplementation(addMinedBlock);
		jest.spyOn(console, 'error').mockImplementation(() => {});
		miner = new Miner(chain, wallet.address, WORKER_PATH);

		miner.start();
		await waitUntil(() => chain.getChain().length >= 2);

		expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(miner.isRunning()).toBe(true);
	});

	it('should stop when PoW blocks are no longer accepted', async () => {
		jest.spyOn(chain, 'canAcceptPowBlock').mockReturnValue(false);
		miner = new Miner(chain, openWallet(dir, 'miner').address, WORKER_PATH);

		miner.start();
		await waitUntil(() => !miner!.isRunning());

		expect(chain.getChain()).toHaveLength(1);
	});

	it('should abandon the job when another block extends the tip', async () => {
		const wallet = openWallet(dir, 'miner');
		const other = openWallet(dir, 'other');
		// Make the worker slow to find a nonce so the tip changes first
		jest.spyOn(chain, 'createBlockTemplate').mockImplementationOnce((address, timestamp) => {
			const block = Blockchain.prototype.createBlockTemplate.call(chain, address, timestamp);
			block.bits = targetToBits(1n << 220n); // ~2^36 hashes: won't finish before the tip changes
			return block;
		});
		miner = new Miner(chain, wallet.address, WORKER_PATH);

		miner.start();
		await chain.minePendingTransactions(other.address); // extends the tip under the miner
		await waitUntil(() => chain.getChain().length >= 3);

		expect(chain.getChain()[1].transactions[0].outputs[0].address).toBe(other.address);
		expect(chain.getChain()[2].transactions[0].outputs[0].address).toBe(wallet.address);
		expect(openChain(dir).getChain().length).toBeGreaterThanOrEqual(3);
	});
});
