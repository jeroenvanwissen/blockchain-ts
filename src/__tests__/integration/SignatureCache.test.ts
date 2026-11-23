// Signature cache (TASK-0028): a transaction's signatures are verified once per exact witness
// bytes; mempool revalidation and connecting a block of known transactions skip the ECDSA checks.
import { Transaction } from '../../blockchain/Transaction.js';
import { COIN, COIN_MATURITY } from '../../config.js';
import { makeTempDir, mineBlocks, openChain, openWallet, removeTempDir, useTestClock } from './helpers.js';

describe('Signature cache', () => {
	let dir: string;

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
		useTestClock();
		jest.spyOn(console, 'log').mockImplementation(() => {});
		dir = makeTempDir();
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
		removeTempDir(dir);
	});

	it('should verify signatures once, not again on revalidation or when the block connects', async () => {
		const miner = openWallet(dir, 'miner');
		const chain = openChain(dir);
		await mineBlocks(chain, miner.address, COIN_MATURITY + 2);
		const verify = jest.spyOn(Transaction.prototype, 'verifySignatures');

		for (const name of ['a', 'b']) {
			const payment = chain.createPayment(miner, [{ address: openWallet(dir, name).address, amount: COIN }]);
			await chain.addTransaction(payment.transaction);
		}
		expect(verify).toHaveBeenCalledTimes(2);

		// A new tip revalidates the mempool, and connecting a block with both re-checks them
		chain['_readmitTransactions']();
		await mineBlocks(chain, miner.address, 1);
		expect(chain.getPendingTransactions()).toHaveLength(0);
		expect(verify).toHaveBeenCalledTimes(2);
	});

	it('should not let a cached transaction vouch for a copy with a different signature', async () => {
		const miner = openWallet(dir, 'miner');
		const chain = openChain(dir);
		await mineBlocks(chain, miner.address, COIN_MATURITY + 1);
		const payment = chain.createPayment(miner, [{ address: openWallet(dir, 'a').address, amount: COIN }]).transaction;
		await chain.addTransaction(payment);
		chain['_readmitTransactions'](); // still cached and pending
		await chain.clearPendingTransactions();

		// Same txid (signatures aren't part of it), tampered signature: a different witness hash
		const forged = Transaction.fromJSON(JSON.parse(JSON.stringify(payment)));
		const signature = forged.inputs[0].signature;
		forged.inputs[0].signature = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
		expect(forged.calculateHash()).toBe(payment.calculateHash());

		await expect(chain.addTransaction(forged)).rejects.toThrow('invalid input signature');
	});
});
