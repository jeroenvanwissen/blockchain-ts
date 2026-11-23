// The single block-validation path (TASK-0006): transactions inside blocks are checked
// against the UTXO set, in order, and add-block / chain replacement / startup load agree.
import * as path from 'path';
import { Block } from '../../blockchain/Block.js';
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { BlockStore } from '../../blockchain/BlockStore.js';
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
	solve,
	useTestClock,
} from './helpers.js';

describe('Block validation (single path)', () => {
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

	/** A signed transaction spending `from`'s first mature UTXO to `to`. */
	function spendFirstUtxo(chain: Blockchain, from: Wallet, to: string, amount = COIN): Transaction {
		const utxo = chain.getUTXOs(from.address)[0];
		const tx = new Transaction(
			[{ previousTx: utxo.txHash, outputIndex: utxo.outputIndex, publicKey: '', signature: '' }],
			[
				{ address: to, amount },
				{ address: from.address, amount: utxo.output.amount - amount },
			],
		);
		from.signTransaction(tx);
		return tx;
	}

	/** A solved PoW block on the current tip with the given non-coinbase transactions. */
	function nextBlock(chain: Blockchain, miner: Wallet, txs: Transaction[]): Block {
		advanceTime(BLOCK_TIME * 1000);
		const height = chain.getChain().length;
		return solve(
			new Block(
				Date.now(),
				[Transaction.coinbase(miner.address, POW_BLOCK_REWARD, height), ...txs],
				chain.getLatestBlock().hash,
				0,
				chain.calculateNewDifficulty(),
				height,
			),
		);
	}

	it('should reject a block that spends the same output twice', async () => {
		const miner = openWallet(dir, 'miner');
		const chain = openChain(dir);
		await mineBlocks(chain, miner.address, COIN_MATURITY + 1);
		const first = spendFirstUtxo(chain, miner, openWallet(dir, 'a').address);
		const second = spendFirstUtxo(chain, miner, openWallet(dir, 'b').address);

		const block = nextBlock(chain, miner, [first, second]);

		await expect(chain.addMinedBlock(block)).rejects.toThrow(
			'transaction 2: input references a missing or spent output',
		);
		expect(chain.getChain()).toHaveLength(COIN_MATURITY + 2);
	});

	it('should accept spending an output created earlier in the same block', async () => {
		const miner = openWallet(dir, 'miner');
		const recipient = openWallet(dir, 'recipient');
		const chain = openChain(dir);
		await mineBlocks(chain, miner.address, COIN_MATURITY + 1);
		const pay = spendFirstUtxo(chain, miner, recipient.address, 3n * COIN);
		const forward = new Transaction(
			[{ previousTx: pay.calculateHash(), outputIndex: 0, publicKey: '', signature: '' }],
			[{ address: miner.address, amount: 3n * COIN }],
		);
		recipient.signTransaction(forward);

		await chain.addMinedBlock(nextBlock(chain, miner, [pay, forward]));

		expect(chain.getBalance(recipient.address)).toBe(0n);
		expect(chain.getUTXOs(miner.address).some((u) => u.txHash === forward.calculateHash())).toBe(true);
	});

	it('should accept and reject the same blocks when adding, replacing and loading', async () => {
		const miner = openWallet(dir, 'miner');
		const chain = openChain(dir);
		await mineBlocks(chain, miner.address, 3);

		// Valid chain: accepted by a fresh node via replacement and by a reload from disk
		const otherDir = makeTempDir();
		try {
			const other = openChain(otherDir);
			await other.replaceChain([...chain.getChain()]);
			expect(other.getLatestBlock().hash).toBe(chain.getLatestBlock().hash);
			expect(openChain(dir).getLatestBlock().hash).toBe(chain.getLatestBlock().hash);

			// Invalid block (validly signed, spends an output that doesn't exist)
			const fromNothing = new Transaction(
				[{ previousTx: 'cd'.repeat(32), outputIndex: 0, publicKey: '', signature: '' }],
				[{ address: miner.address, amount: COIN }],
			);
			miner.signTransaction(fromNothing);
			const bad = nextBlock(chain, miner, [fromNothing]);
			const reason = 'transaction 1: input references a missing or spent output';

			await expect(chain.addMinedBlock(bad)).rejects.toThrow(reason);
			await expect(openChain(otherDir).replaceChain([...chain.getChain(), bad])).rejects.toThrow(
				`Invalid chain: block 4: ${reason}`,
			);

			// Write it to disk behind the validator's back: startup load refuses it
			new BlockStore(path.join(dir, 'blocks')).appendBlock(bad);
			jest.spyOn(console, 'error').mockImplementation(() => {});
			expect(() => openChain(dir)).toThrow(`invalid stored chain: block 4: ${reason}`);
		} finally {
			removeTempDir(otherDir);
		}
	});

	it('should leave the chain usable after rejecting a block', async () => {
		const miner = openWallet(dir, 'miner');
		const chain = openChain(dir);
		await mineBlocks(chain, miner.address, COIN_MATURITY + 1);
		const balanceBefore = chain.getBalance(miner.address);
		const tx = spendFirstUtxo(chain, miner, openWallet(dir, 'a').address);
		await expect(chain.addMinedBlock(nextBlock(chain, miner, [tx, tx]))).rejects.toThrow();

		expect(chain.getBalance(miner.address)).toBe(balanceBefore);
		await chain.addMinedBlock(nextBlock(chain, miner, [tx]));
		expect(chain.getBalance(miner.address)).toBe(balanceBefore - COIN + POW_BLOCK_REWARD);
	});
});
