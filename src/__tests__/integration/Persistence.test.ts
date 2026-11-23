import * as fs from 'fs';
import * as path from 'path';
import { COIN_MATURITY, POW_BLOCK_REWARD } from '../../config.js';
import {
	makeTempDir,
	mineBlocks,
	openChain,
	openWallet,
	removeTempDir,
	useTestClock,
} from './helpers.js';

describe('Persistence (real filesystem)', () => {
	let dir: string;

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
		useTestClock();
		dir = makeTempDir();
	});

	afterEach(() => {
		jest.useRealTimers();
		removeTempDir(dir);
	});

	it('should write genesis to disk and load it again', () => {
		const first = openChain(dir);
		expect(fs.existsSync(path.join(dir, 'blocks', 'blk00000.dat'))).toBe(true);
		expect(fs.existsSync(path.join(dir, 'blocks', 'index.dat'))).toBe(true);

		const second = openChain(dir);
		expect(second.getChain().map((b) => b.hash)).toEqual(first.getChain().map((b) => b.hash));
	});

	it('should reload mined blocks with identical hashes and UTXO set', async () => {
		const miner = openWallet(dir, 'miner');
		const first = openChain(dir);
		await mineBlocks(first, miner.address, 5);

		const second = openChain(dir);
		expect(second.getChain()).toHaveLength(6);
		expect(second.getChain().map((b) => b.hash)).toEqual(first.getChain().map((b) => b.hash));
		expect(second.getUTXOs(miner.address)).toEqual(first.getUTXOs(miner.address));
		expect(second.getBalance(miner.address)).toBe(5 * POW_BLOCK_REWARD);
	});

	it('should reload a spending transaction with its inputs and signatures', async () => {
		const miner = openWallet(dir, 'miner');
		const recipient = openWallet(dir, 'recipient');
		const first = openChain(dir);
		await mineBlocks(first, miner.address, COIN_MATURITY + 1);

		const tx = first.createTransaction(miner.address, recipient.address, 7, miner);
		await first.addTransaction(tx);
		await mineBlocks(first, miner.address, 1);

		const second = openChain(dir);
		const reloadedTx = second
			.getChain()
			.flatMap((b) => b.transactions)
			.find((t) => t.calculateHash() === tx.calculateHash());
		expect(reloadedTx?.inputs).toEqual(tx.inputs);
		expect(second.getBalance(recipient.address)).toBe(7);
		expect(second.getUTXOs(miner.address)).toEqual(first.getUTXOs(miner.address));
	});

	it('should continue mining on top of a reloaded chain', async () => {
		const miner = openWallet(dir, 'miner');
		await mineBlocks(openChain(dir), miner.address, 3);

		await mineBlocks(openChain(dir), miner.address, 2);

		expect(openChain(dir).getChain()).toHaveLength(6);
	});

	it('should keep the wallet key across reopen', () => {
		const first = openWallet(dir, 'node');
		const second = openWallet(dir, 'node');
		expect(second.address).toBe(first.address);
		expect(second.publicKey.equals(first.publicKey)).toBe(true);
	});
});
