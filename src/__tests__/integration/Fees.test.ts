// Transaction fees (TASK-0018): fee = inputs − outputs. The coinbase must claim exactly the
// block reward plus fees (consensus); the minimum relay fee is mempool and wallet policy.
import { Block } from '../../blockchain/Block.js';
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { minRelayFee } from '../../blockchain/fees.js';
import { Transaction } from '../../blockchain/Transaction.js';
import type { UTXO } from '../../blockchain/UtxoSet.js';
import type { Wallet } from '../../blockchain/Wallet.js';
import { BLOCK_TIME, COIN, COIN_MATURITY, POS_BLOCK_REWARD, POW_BLOCK_REWARD } from '../../config.js';
import {
	advanceTime,
	finishPowPhase,
	findStakeBlock,
	makeTempDir,
	mineBlocks,
	openChain,
	openPosChain,
	openWallet,
	removeTempDir,
	solve,
	useTestClock,
} from './helpers.js';

/** A signed transaction spending `utxo` to `to` and leaving `fee` (size doesn't depend on it). */
function spend(wallet: Wallet, utxo: UTXO, to: string, fee: bigint): Transaction {
	const tx = new Transaction(
		[{ previousTx: utxo.txHash, outputIndex: utxo.outputIndex, publicKey: '', signature: '' }],
		[{ address: to, amount: utxo.output.amount - fee }],
	);
	wallet.signTransaction(tx);
	return tx;
}

/** A solved PoW block on the tip whose coinbase claims `claim`. */
function blockClaiming(chain: Blockchain, miner: string, txs: Transaction[], claim: bigint): Block {
	advanceTime(BLOCK_TIME * 1000);
	const template = chain.createBlockTemplate(miner, Date.now());
	const coinbase = Transaction.coinbase(miner, claim, template.index, template.timestamp);
	return solve(
		new Block(template.timestamp, [coinbase, ...txs], template.previousHash, 0, template.bits, template.index),
	);
}

describe('Transaction fees', () => {
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

	async function chainWithMatureCoinbase(): Promise<{ chain: Blockchain; utxo: UTXO }> {
		const chain = openChain(dir);
		await mineBlocks(chain, miner.address, COIN_MATURITY + 1);
		return { chain, utxo: chain.getSpendableUTXOs(miner.address)[0] };
	}

	it('should admit transactions paying the minimum relay fee for their size, and nothing less', async () => {
		const { chain, utxo } = await chainWithMatureCoinbase();
		const minimum = minRelayFee(spend(miner, utxo, to, 0n).size());

		await expect(chain.addTransaction(spend(miner, utxo, to, minimum - 1n))).rejects.toThrow(
			'below the minimum relay fee',
		);
		await expect(chain.addTransaction(spend(miner, utxo, to, minimum))).resolves.toBeUndefined();
	});

	it('should require the coinbase to claim exactly the reward plus fees', async () => {
		const { chain, utxo } = await chainWithMatureCoinbase();
		const fee = 3n * minRelayFee(spend(miner, utxo, to, 0n).size());
		const payment = spend(miner, utxo, to, fee);
		await chain.addTransaction(payment);

		for (const claim of [POW_BLOCK_REWARD + fee + 1n, POW_BLOCK_REWARD + fee - 1n]) {
			await expect(chain.addMinedBlock(blockClaiming(chain, miner.address, [payment], claim))).rejects.toThrow(
				'invalid coinbase reward amount',
			);
		}

		advanceTime(BLOCK_TIME * 1000);
		const block = await chain.minePendingTransactions(miner.address); // the template claims the fee
		expect(block.transactions[0].outputs[0].amount).toBe(POW_BLOCK_REWARD + fee);
		expect(chain.isChainValid()).toBe(true);
	});

	it('should accept a zero-fee transaction inside a block (the minimum is policy, not consensus)', async () => {
		const { chain, utxo } = await chainWithMatureCoinbase();
		const free = spend(miner, utxo, to, 0n);

		await expect(chain.addMinedBlock(blockClaiming(chain, miner.address, [free], POW_BLOCK_REWARD))).resolves.toBe(
			'connected',
		);
	});

	it('should let a PoS block claim the fees of the transactions it includes', async () => {
		const chain = openPosChain(dir);
		await finishPowPhase(chain, miner.address);
		const utxo = chain.getSpendableUTXOs(miner.address)[0];
		const fee = minRelayFee(spend(miner, utxo, to, 0n).size());
		await chain.addTransaction(spend(miner, utxo, to, fee));

		const block = findStakeBlock(chain, miner); // the kernel skips the output the payment spends
		await expect(chain.addMinedBlock(block)).resolves.toBe('connected');
		expect(block.isProofOfStake()).toBe(true);
		expect(block.transactions[0].outputs[0].amount).toBe(POS_BLOCK_REWARD + fee);
	});

	it('should pay exactly the minimum fee in createPayment, and fold change too small to keep into the fee', async () => {
		const { chain } = await chainWithMatureCoinbase();
		const withChange = chain.createPayment(miner, [{ address: to, amount: COIN }]);
		expect(withChange.transaction.outputs).toHaveLength(2);
		expect(withChange.fee).toBe(minRelayFee(withChange.transaction.size()));

		// A wallet with one 2-coin output pays almost all of it: the 1 base unit left over after
		// the fee can't pay for a change output, so it becomes part of the fee
		const payer = openWallet(dir, 'payer');
		await chain.addTransaction(withChange.transaction);
		await chain.addTransaction(chain.createPayment(miner, [{ address: payer.address, amount: 2n * COIN }]).transaction);
		await mineBlocks(chain, miner.address, 1);
		const [funds] = chain.getSpendableUTXOs(payer.address);
		const feeWithoutChange = minRelayFee(spend(payer, funds, to, 0n).size());

		const { transaction, fee } = chain.createPayment(payer, [
			{ address: to, amount: 2n * COIN - feeWithoutChange - 1n },
		]);

		expect(transaction.outputs).toHaveLength(1);
		expect(fee).toBe(feeWithoutChange + 1n);
		await expect(chain.addTransaction(transaction)).resolves.toBeUndefined();
	});
});
