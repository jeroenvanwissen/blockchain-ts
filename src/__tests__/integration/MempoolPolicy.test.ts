// Mempool policy and block limits (TASK-0019): templates take the best fee rates that fit a
// block, a full mempool evicts the lowest rates, confirmed conflicts leave the mempool, and
// oversized blocks are invalid.
import { Block } from '../../blockchain/Block.js';
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { minRelayFee } from '../../blockchain/fees.js';
import { Transaction } from '../../blockchain/Transaction.js';
import type { UTXO } from '../../blockchain/UtxoSet.js';
import type { Wallet } from '../../blockchain/Wallet.js';
import { BLOCK_TIME, COIN_MATURITY, MAX_BLOCK_TRANSACTIONS, POW_BLOCK_REWARD } from '../../config.js';
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

/** A signed 1-in-1-out transaction spending `utxo` to `to` and leaving `fee`. */
function spend(wallet: Wallet, utxo: UTXO, to: string, fee: bigint): Transaction {
	const tx = new Transaction(
		[{ previousTx: utxo.txHash, outputIndex: utxo.outputIndex, publicKey: '', signature: '' }],
		[{ address: to, amount: utxo.output.amount - fee }],
	);
	wallet.signTransaction(tx);
	return tx;
}

/** A solved PoW block on the tip with these transactions and a coinbase claiming `claim`. */
function blockWith(chain: Blockchain, miner: string, txs: Transaction[], claim: bigint): Block {
	advanceTime(BLOCK_TIME * 1000);
	const template = chain.createBlockTemplate(miner, Date.now());
	const coinbase = Transaction.coinbase(miner, claim, template.index, template.timestamp);
	return solve(
		new Block(template.timestamp, [coinbase, ...txs], template.previousHash, 0, template.bits, template.index),
	);
}

describe('Mempool policy and block limits', () => {
	let dir: string;
	let miner: Wallet;
	let to: string;

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
		useTestClock();
		jest.spyOn(console, 'log').mockImplementation(() => {});
		dir = makeTempDir();
		miner = openWallet(dir, 'miner');
		to = openWallet(dir, 'to').address;
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
		removeTempDir(dir);
	});

	it('should fill a block with the best-paying transactions when the mempool holds more than fits', async () => {
		const chain = openChain(dir);
		await mineBlocks(chain, miner.address, COIN_MATURITY + 4);
		// Fan four mature coinbases out into 1004 small outputs owned by `owner`
		const owner = openWallet(dir, 'owner');
		for (let i = 0; i < 4; i++) {
			const outputs = Array.from({ length: 251 }, () => ({ address: owner.address, amount: 3_900_000n }));
			await chain.addTransaction(chain.createPayment(miner, outputs).transaction);
		}
		await mineBlocks(chain, miner.address, 1);
		const outputs = chain.getSpendableUTXOs(owner.address);
		expect(outputs).toHaveLength(1004);

		// 1004 payments: the first five pay the minimum fee, the rest twice that
		const minimum = minRelayFee(spend(owner, outputs[0], to, 0n).size());
		const payments = outputs.map((utxo, i) => spend(owner, utxo, to, i < 5 ? minimum : 2n * minimum));
		for (const payment of payments) await chain.addTransaction(payment);

		advanceTime(BLOCK_TIME * 1000);
		const block = await chain.minePendingTransactions(miner.address);

		expect(block.transactions).toHaveLength(MAX_BLOCK_TRANSACTIONS); // coinbase + 999
		const leftOver = chain.getPendingTransactions().map((tx) => tx.calculateHash());
		expect(leftOver).toEqual(payments.slice(0, 5).map((tx) => tx.calculateHash()));
		expect(block.transactions[0].outputs[0].amount).toBe(POW_BLOCK_REWARD + 999n * 2n * minimum);
	});

	it('should evict the lowest fee rate when full, and refuse transactions that pay less', async () => {
		const chain = openChain(dir, { maxMempoolBytes: 600 }); // three 1-in-1-out transactions
		await mineBlocks(chain, miner.address, COIN_MATURITY + 4);
		const [a, b, c, d, e] = chain.getSpendableUTXOs(miner.address);
		const minimum = minRelayFee(spend(miner, a, to, 0n).size());
		const cheapest = spend(miner, a, to, 2n * minimum);
		for (const tx of [cheapest, spend(miner, b, to, 3n * minimum), spend(miner, c, to, 4n * minimum)]) {
			await chain.addTransaction(tx);
		}

		await chain.addTransaction(spend(miner, d, to, 5n * minimum));
		expect(chain.getPendingTransactions().map((tx) => tx.calculateHash())).not.toContain(cheapest.calculateHash());
		expect(chain.getPendingTransactions()).toHaveLength(3);
		// The evicted transaction's output is spendable again
		expect(chain.getSpendableUTXOs(miner.address).map((u) => u.txHash)).toContain(a.txHash);

		await expect(chain.addTransaction(spend(miner, e, to, minimum))).rejects.toThrow('fee rate is too low');
	});

	it('should drop a pending transaction when a block confirms a conflicting one', async () => {
		const chain = openChain(dir);
		await mineBlocks(chain, miner.address, COIN_MATURITY + 1);
		const [utxo] = chain.getSpendableUTXOs(miner.address);
		const minimum = minRelayFee(spend(miner, utxo, to, 0n).size());
		await chain.addTransaction(spend(miner, utxo, to, minimum));

		// Another node confirmed a different spend of the same output
		const other = openWallet(dir, 'other').address;
		const conflicting = spend(miner, utxo, other, 2n * minimum);
		await expect(chain.addMinedBlock(blockWith(chain, miner.address, [conflicting], POW_BLOCK_REWARD + 2n * minimum))).resolves.toBe(
			'connected',
		);

		expect(chain.getPendingTransactions()).toHaveLength(0);
		expect(chain.getBalance(other)).toBe(utxo.output.amount - 2n * minimum);
	});

	it('should reject a block larger than MAX_BLOCK_SIZE before validating its transactions', async () => {
		const chain = openChain(dir);
		await mineBlocks(chain, miner.address, 1);
		// 16 outputs with 65,000-byte "addresses": over 1 MB, invalid in other ways too
		const bulky = new Transaction(
			[{ previousTx: 'ab'.repeat(32), outputIndex: 0, publicKey: '', signature: '' }],
			Array.from({ length: 16 }, () => ({ address: '1'.repeat(65_000), amount: 1n })),
		);

		await expect(chain.addMinedBlock(blockWith(chain, miner.address, [bulky], POW_BLOCK_REWARD))).rejects.toThrow(
			'block exceeds maximum size',
		);
	});
});
