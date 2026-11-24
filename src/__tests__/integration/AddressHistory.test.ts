// Address history index (TASK-0045): every active-chain transaction per address with what it
// received and sent and the balance after it. Whatever the path (connect, reorg, restart from a
// chainstate or a full replay), the live index must equal one rebuilt from the active chain.
import { AddressIndex } from '../../blockchain/AddressIndex.js';
import { Block } from '../../blockchain/Block.js';
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { Transaction } from '../../blockchain/Transaction.js';
import type { Wallet } from '../../blockchain/Wallet.js';
import { BLOCK_TIME, COIN, COIN_MATURITY, POS_BLOCK_REWARD, POW_BLOCK_REWARD } from '../../config.js';
import {
	advanceTime,
	extendBranch,
	finishPowPhase,
	findStakeBlock,
	makeTempDir,
	mineBlocks,
	openChain,
	openPosChain,
	openWallet,
	removeTempDir,
	useTestClock,
} from './helpers.js';

/** The live index equals a rebuild from the active chain, and each history ends at the balance. */
function expectConsistent(chain: Blockchain): void {
	const rebuilt = new AddressIndex();
	for (const block of chain.getChain()) rebuilt.connect(block, chain['_undo'].get(block.hash) ?? []);
	const live = chain['_addressIndex']['_byAddress'];
	expect(live).toEqual(rebuilt['_byAddress']);
	for (const [address, history] of live) {
		expect(history[history.length - 1].balance).toBe(chain.getBalance(address));
		expect(history.map((entry) => entry.height)).toEqual([...history.map((entry) => entry.height)].sort((a, b) => a - b));
	}
}

describe('Address history', () => {
	let dir: string;
	let miner: Wallet;

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

	it('should record what each transaction received and sent, and the balance after it', async () => {
		const chain = openChain(dir);
		const [alice, bob] = [openWallet(dir, 'alice'), openWallet(dir, 'bob')];
		await mineBlocks(chain, miner.address, COIN_MATURITY + 1);
		const payment = chain.createTransaction(miner.address, alice.address, 3n * COIN, miner);
		await chain.addTransaction(payment);

		expect(chain.getPendingActivity([alice.address])).toEqual([{ txid: payment.calculateHash(), received: 3n * COIN, sent: 0n }]);
		const [pending] = chain.getPendingActivity([miner.address]);
		expect(pending.sent - pending.received).toBeGreaterThan(3n * COIN); // the payment plus its fee
		await mineBlocks(chain, openWallet(dir, 'other').address, 1);
		const forward = chain.createTransaction(alice.address, bob.address, COIN, alice);
		await chain.addTransaction(forward);
		await mineBlocks(chain, openWallet(dir, 'other').address, 1);

		const height = chain.getLatestBlock().index;
		const change = 3n * COIN - COIN - (3n * COIN - forward.outputs.reduce((sum, o) => sum + o.amount, 0n));
		expect(chain.getAddressHistory(alice.address)).toEqual([
			{ txid: payment.calculateHash(), height: height - 1, indexInBlock: 1, received: 3n * COIN, sent: 0n, balance: 3n * COIN },
			{ txid: forward.calculateHash(), height, indexInBlock: 1, received: change, sent: 3n * COIN, balance: change },
		]);
		expect(chain.getAddressHistory(bob.address)).toEqual([
			{ txid: forward.calculateHash(), height, indexInBlock: 1, received: COIN, sent: 0n, balance: COIN },
		]);
		const minerHistory = chain.getAddressHistory(miner.address);
		expect(minerHistory).toHaveLength(COIN_MATURITY + 2); // the coinbases and the payment
		expect(minerHistory[0]).toMatchObject({ height: 1, received: POW_BLOCK_REWARD, sent: 0n, balance: POW_BLOCK_REWARD });
		expect(chain.getPendingActivity([alice.address])).toEqual([]);
		expectConsistent(chain);
	});

	it('should resolve a spend of an output created earlier in the same block', async () => {
		const chain = openChain(dir);
		const [alice, bob] = [openWallet(dir, 'alice'), openWallet(dir, 'bob')];
		await mineBlocks(chain, miner.address, COIN_MATURITY + 1);
		const pay = chain.createTransaction(miner.address, alice.address, 2n * COIN, miner);
		const inputs = pay.inputs.reduce((sum, input) => sum + chain.getUTXO(input.previousTx, input.outputIndex)!.output.amount, 0n);
		const fee = inputs - pay.outputs.reduce((sum, output) => sum + output.amount, 0n);
		// Alice passes the coins on in the same block (no fee needed inside a block)
		const passOn = new Transaction(
			[{ previousTx: pay.calculateHash(), outputIndex: 0, publicKey: '', signature: '' }],
			[{ address: bob.address, amount: 2n * COIN }],
			pay.timestamp,
		);
		alice.signTransaction(passOn);
		advanceTime(BLOCK_TIME * 1000);
		const tip = chain.getLatestBlock();
		const height = tip.index + 1;
		const block = new Block(
			Date.now(),
			[Transaction.coinbase(miner.address, POW_BLOCK_REWARD + fee, height, Date.now()), pay, passOn],
			tip.hash,
			0,
			chain.getRequiredBits(false),
			height,
		);
		block.solve();
		await chain.addMinedBlock(block);

		expect(chain.getAddressHistory(alice.address)).toEqual([
			{ txid: pay.calculateHash(), height, indexInBlock: 1, received: 2n * COIN, sent: 0n, balance: 2n * COIN },
			{ txid: passOn.calculateHash(), height, indexInBlock: 2, received: 0n, sent: 2n * COIN, balance: 0n },
		]);
		expect(chain.getAddressHistory(bob.address).map((entry) => entry.balance)).toEqual([2n * COIN]);
		expectConsistent(chain);
	});

	it('should follow a reorganization, and rebuild the same index on restart', async () => {
		const chain = openChain(dir);
		const alice = openWallet(dir, 'alice');
		await mineBlocks(chain, miner.address, COIN_MATURITY + 1);
		const payment = chain.createTransaction(miner.address, alice.address, COIN, miner);
		await chain.addTransaction(payment);
		await mineBlocks(chain, miner.address, 2);
		expect(chain.getAddressHistory(alice.address)).toHaveLength(1);

		// A longer branch without the payment replaces the last two blocks
		advanceTime(BLOCK_TIME * 10_000);
		const prefix = chain.getChain().slice(0, -2);
		for (const block of extendBranch(prefix, openWallet(dir, 'other').address, 4).slice(prefix.length)) {
			await chain.addMinedBlock(block);
		}

		expect(chain.getAddressHistory(alice.address)).toEqual([]);
		expect(chain.getPendingActivity([alice.address]).map((entry) => entry.txid)).toEqual([payment.calculateHash()]);
		expectConsistent(chain);

		await mineBlocks(chain, miner.address, 1); // confirms the payment again
		const before = chain['_addressIndex']['_byAddress'];
		chain.saveChainstate();
		for (const options of [{}, { useChainstate: false }]) {
			const reopened = openChain(dir, options);
			expect(reopened['_addressIndex']['_byAddress']).toEqual(before);
			expectConsistent(reopened);
		}
	});

	it('should show a stake as sending and receiving the kernel output, and the reward as received', async () => {
		const chain = openPosChain(dir);
		await finishPowPhase(chain, miner.address);

		const block = findStakeBlock(chain, miner);
		await chain.addMinedBlock(block);

		const kernel = block.transactions[1].outputs[1].amount;
		const [reward, stake] = chain.getAddressHistory(miner.address).slice(-2);
		expect(reward).toMatchObject({ txid: block.transactions[0].calculateHash(), received: POS_BLOCK_REWARD, sent: 0n });
		expect(stake).toMatchObject({ txid: block.transactions[1].calculateHash(), received: kernel, sent: kernel });
		expectConsistent(chain);
	});

	it("should merge a wallet's addresses into one entry per transaction, in chain order", async () => {
		const chain = openChain(dir);
		const [outsider, funder] = [openWallet(dir, 'outsider'), openWallet(dir, 'funder')];
		await mineBlocks(chain, funder.address, 1);
		await mineBlocks(chain, miner.address, COIN_MATURITY + 1);
		const second = miner.newAddress();
		await mineBlocks(chain, second, 1); // a reward to the second address
		/** Inputs minus outputs, while the inputs are still unspent. */
		const feeOf = (tx: Transaction) =>
			tx.inputs.reduce((sum, input) => sum + chain.getUTXO(input.previousTx, input.outputIndex)!.output.amount, 0n) -
			tx.outputs.reduce((sum, output) => sum + output.amount, 0n);

		// One block: a payment out with change, a payment to the wallet's own second address, and
		// an outsider's payment to that address, mined first (not in the order the addresses list them)
		const payOut = chain.createPayment(miner, [{ address: outsider.address, amount: 2n * COIN }]);
		await chain.addTransaction(payOut.transaction);
		const toSelf = chain.createTransaction(miner.address, second, COIN, miner);
		const selfFee = feeOf(toSelf);
		await chain.addTransaction(toSelf);
		const fromOutsider = chain.createTransaction(funder.address, second, 3n * COIN, funder);
		const outsiderFee = feeOf(fromOutsider);
		await chain.addTransaction(fromOutsider);
		advanceTime(BLOCK_TIME * 1000);
		const tip = chain.getLatestBlock();
		const reward = POW_BLOCK_REWARD + outsiderFee + payOut.fee + selfFee;
		const block = new Block(
			Date.now(),
			[Transaction.coinbase(outsider.address, reward, tip.index + 1, Date.now()), fromOutsider, payOut.transaction, toSelf],
			tip.hash,
			0,
			chain.getRequiredBits(false),
			tip.index + 1,
		);
		block.solve();
		await chain.addMinedBlock(block);

		const addresses = miner.addresses();
		const history = chain.getWalletHistory(addresses);
		const txids = history.map((entry) => entry.txid);
		expect(new Set(txids).size).toBe(txids.length); // one entry per transaction
		const [, ...blockTxids] = chain.getLatestBlock().transactions.map((tx) => tx.calculateHash());
		expect(blockTxids).toHaveLength(3);
		expect(txids.slice(-3)).toEqual(blockTxids); // block order, across addresses
		const flows = history.slice(-3).map((entry) => [entry.received - entry.sent, entry.sent > 0n]);
		const net = new Map(blockTxids.map((txid, i) => [txid, flows[i]]));
		expect(net.get(payOut.transaction.calculateHash())).toEqual([-(2n * COIN + payOut.fee), true]);
		expect(net.get(toSelf.calculateHash())).toEqual([-selfFee, true]); // only the fee leaves the wallet
		expect(net.get(fromOutsider.calculateHash())).toEqual([3n * COIN, false]);

		const total = addresses.reduce((sum, address) => sum + chain.getBalance(address), 0n);
		expect(history[history.length - 1].balance).toBe(total);
		expect(history).toEqual([...history].sort((a, b) => a.height - b.height || a.indexInBlock - b.indexInBlock));
		expect(chain.getWalletHistory([...addresses, ...addresses])).toEqual(history); // duplicates count once

		// A pending payment between the wallet's addresses is one entry: the fee leaves the wallet
		const pendingSelf = chain.createTransaction(miner.address, second, COIN, miner);
		const pendingFee = feeOf(pendingSelf);
		await chain.addTransaction(pendingSelf);
		const pending = chain.getPendingActivity(addresses);
		expect(pending.map((entry) => [entry.txid, entry.received - entry.sent])).toEqual([[pendingSelf.calculateHash(), -pendingFee]]);
		expect(chain.getPendingActivity([second])).toEqual([{ txid: pendingSelf.calculateHash(), received: COIN, sent: 0n }]);
		expectConsistent(chain);
	});
});
