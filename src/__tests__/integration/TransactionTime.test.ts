// Transaction timestamp rules (TASK-0025): a transaction is never dated after its block or before
// the outputs it spends; the mempool refuses far-future ones; templates hold back transactions
// dated after the block; wallet payments are dated no earlier than their inputs.
import { Block } from '../../blockchain/Block.js';
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { minRelayFee } from '../../blockchain/fees.js';
import { Transaction } from '../../blockchain/Transaction.js';
import type { UTXO } from '../../blockchain/UtxoSet.js';
import type { Wallet } from '../../blockchain/Wallet.js';
import { BLOCK_TIME, COIN, COIN_MATURITY, MAX_FUTURE_BLOCK_TIME, POW_BLOCK_REWARD } from '../../config.js';
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

/** A signed payment of `utxo` to `to`, dated `timestamp`, paying three times the minimum fee. */
function spendAt(wallet: Wallet, utxo: UTXO, to: string, timestamp: number): Transaction {
	const build = (fee: bigint) => {
		const tx = new Transaction(
			[{ previousTx: utxo.txHash, outputIndex: utxo.outputIndex, publicKey: '', signature: '' }],
			[{ address: to, amount: utxo.output.amount - fee }],
			timestamp,
		);
		wallet.signTransaction(tx);
		return tx;
	};
	return build(3n * minRelayFee(build(0n).size()));
}

/** A solved PoW block on the tip at `timestamp` containing `txs`, claiming their fees. */
function blockAt(chain: Blockchain, miner: string, timestamp: number, txs: Transaction[], fees: bigint): Block {
	const tip = chain.getLatestBlock();
	const coinbase = Transaction.coinbase(miner, POW_BLOCK_REWARD + fees, tip.index + 1, timestamp);
	return solve(new Block(timestamp, [coinbase, ...txs], tip.hash, 0, chain.getRequiredBits(false), tip.index + 1));
}

describe('Transaction timestamps', () => {
	let dir: string;
	let miner: Wallet;
	let to: string;
	let chain: Blockchain;
	let utxo: UTXO;

	beforeEach(async () => {
		process.env.NODE_ENV = 'test';
		useTestClock();
		jest.spyOn(console, 'log').mockImplementation(() => {});
		dir = makeTempDir();
		miner = openWallet(dir, 'miner');
		to = openWallet(dir, 'to').address;
		chain = openChain(dir);
		await mineBlocks(chain, miner.address, COIN_MATURITY + 1);
		utxo = chain.getSpendableUTXOs(miner.address)[0];
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
		removeTempDir(dir);
	});

	const feeOf = (tx: Transaction) => utxo.output.amount - tx.outputs[0].amount;

	it('should reject a block containing a transaction dated after it', async () => {
		advanceTime(BLOCK_TIME * 1000);
		const late = spendAt(miner, utxo, to, Date.now() + 1);

		await expect(chain.addMinedBlock(blockAt(chain, miner.address, Date.now(), [late], feeOf(late)))).rejects.toThrow(
			'transaction timestamp is later than its block',
		);
	});

	it('should reject a transaction dated before an output it spends, in the mempool and in blocks', async () => {
		const backdated = spendAt(miner, utxo, to, utxo.txTimestamp - 1);

		await expect(chain.addTransaction(backdated)).rejects.toThrow('earlier than an output it spends');
		advanceTime(BLOCK_TIME * 1000);
		await expect(
			chain.addMinedBlock(blockAt(chain, miner.address, Date.now(), [backdated], feeOf(backdated))),
		).rejects.toThrow('earlier than an output it spends');
	});

	it('should keep far-future transactions out of the mempool', async () => {
		const future = spendAt(miner, utxo, to, Date.now() + MAX_FUTURE_BLOCK_TIME + 1);

		await expect(chain.addTransaction(future)).rejects.toThrow('too far in the future');
	});

	it('should hold back a pending transaction dated after the block being built', async () => {
		const soon = spendAt(miner, utxo, to, Date.now() + 10_000); // e.g. created mid-slot
		await chain.addTransaction(soon);

		expect(chain.createBlockTemplate(miner.address, Date.now() + 5_000).transactions).toHaveLength(1); // coinbase only
		const later = chain.createBlockTemplate(miner.address, Date.now() + 10_000);
		expect(later.transactions.map((tx) => tx.calculateHash())).toContain(soon.calculateHash());
	});

	it('should date wallet payments no earlier than the outputs they spend', async () => {
		// An output whose transaction is dated a minute ahead of this node's clock (another node's clock)
		const payer = openWallet(dir, 'payer');
		const ahead = spendAt(miner, utxo, payer.address, Date.now() + 60_000);
		await chain.addTransaction(ahead);
		advanceTime(BLOCK_TIME * 1000);
		await chain.addMinedBlock(blockAt(chain, miner.address, Date.now() + 60_000, [ahead], feeOf(ahead)));

		const { transaction } = chain.createPayment(payer, [{ address: to, amount: COIN }]);

		expect(transaction.timestamp).toBe(ahead.timestamp);
		await expect(chain.addTransaction(transaction)).resolves.toBeUndefined();
	});
});
