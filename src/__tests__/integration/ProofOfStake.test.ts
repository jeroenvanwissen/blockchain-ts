// Kernel proof of stake (TASK-0009): any mature UTXO can stake; PoS blocks are signed by the
// coinstake owner; all PoS state (the stake modifier) is derived from the chain.
import * as fs from 'fs';
import * as path from 'path';
import { Block } from '../../blockchain/Block.js';
import { stakeTieBreak } from '../../blockchain/kernel.js';
import { Transaction } from '../../blockchain/Transaction.js';
import type { Wallet } from '../../blockchain/Wallet.js';
import { COIN, POS_BLOCK_REWARD, STAKE_MIN_AGE, STAKE_TIMESTAMP_GRANULARITY } from '../../config.js';
import {
	findStakeBlock,
	finishPowPhase,
	makeTempDir,
	mineBlocks,
	nextStakeTime,
	openChain,
	openPosChain,
	openWallet,
	POS_TEST_CUTOFF,
	removeTempDir,
	stakeBlocks,
	useTestClock,
} from './helpers.js';

describe('Proof of stake (kernel)', () => {
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

	async function readyChain() {
		const staker = openWallet(dir, 'staker');
		const chain = openPosChain(dir);
		await finishPowPhase(chain, staker.address);
		return { chain, staker };
	}

	it('should accept a signed PoS block after the PoW phase and pay the fixed reward', async () => {
		const { chain, staker } = await readyChain();
		const balanceBefore = chain.getBalance(staker.address);

		const block = findStakeBlock(chain, staker);
		await chain.addMinedBlock(block);

		expect(block.isProofOfStake()).toBe(true);
		expect(block.index).toBe(POS_TEST_CUTOFF + 1);
		expect(block.timestamp % STAKE_TIMESTAMP_GRANULARITY).toBe(0);
		expect(block.transactions[0].outputs).toEqual([
			{ address: staker.address, amount: POS_BLOCK_REWARD },
		]);
		expect(chain.getBalance(staker.address)).toBe(balanceBefore + POS_BLOCK_REWARD);
	});

	it('should keep producing PoS blocks with a fresh stake modifier each block', async () => {
		const { chain, staker } = await readyChain();
		const modifiers = [chain.getStakeModifier()];
		for (let i = 0; i < 5; i++) {
			await stakeBlocks(chain, staker, 1);
			modifiers.push(chain.getStakeModifier());
		}

		expect(new Set(modifiers).size).toBe(6);
		expect(chain.getChain().slice(-5).every((b) => b.isProofOfStake())).toBe(true);
		expect(chain.isChainValid()).toBe(true);
	});

	it('should accept a PoS block received as JSON (signature survives the wire)', async () => {
		const { chain, staker } = await readyChain();
		const block = findStakeBlock(chain, staker);
		const received = Block.fromJSON(JSON.parse(JSON.stringify(block)));

		expect(received.signature).toBe(block.signature);
		await expect(chain.addMinedBlock(received)).resolves.toBe('connected');
	});

	it('should reject PoW blocks after the cutoff and PoS blocks before it', async () => {
		const { chain, staker } = await readyChain();
		await expect(chain.minePendingTransactions(staker.address)).rejects.toThrow(
			`PoW blocks no longer accepted after block ${POS_TEST_CUTOFF}`,
		);

		const block = findStakeBlock(chain, staker);
		chain['_options'].powCutoffBlock = POS_TEST_CUTOFF + 5; // the same height is now PoW phase
		await expect(chain.addMinedBlock(block)).rejects.toThrow(
			`PoS blocks not accepted before block ${POS_TEST_CUTOFF + 6}`,
		);
	});

	it('should reject a PoS block not signed by the stake owner', async () => {
		const { chain, staker } = await readyChain();
		const block = findStakeBlock(chain, staker);
		const other = openWallet(dir, 'other');

		block.signature = other.signDigest(Buffer.from(block.hash, 'hex'));
		await expect(chain.addMinedBlock(block)).rejects.toThrow('invalid block signature');

		block.signature = '';
		await expect(chain.addMinedBlock(block)).rejects.toThrow('invalid block signature');
	});

	it('should reject a PoS timestamp off the 16 s grid', async () => {
		const { chain, staker } = await readyChain();
		const block = findStakeBlock(chain, staker);
		block.timestamp += 1000;
		block.hash = block.calculateHash();
		block.signature = staker.signDigest(Buffer.from(block.hash, 'hex'));

		await expect(chain.addMinedBlock(block)).rejects.toThrow(
			`PoS block timestamp must be a multiple of ${STAKE_TIMESTAMP_GRANULARITY} ms`,
		);
	});

	it('should allow at most one PoS block per 16 s slot', async () => {
		const { chain, staker } = await readyChain();
		const [first] = await stakeBlocks(chain, staker, 1);
		expect(chain.createStakeBlock(staker, first.timestamp)).toBeNull(); // same slot

		// A block forced into the same slot is rejected by validation too
		const next = findStakeBlock(chain, staker);
		next.timestamp = first.timestamp;
		next.transactions[0].timestamp = first.timestamp;
		next.transactions[1].timestamp = first.timestamp;
		staker.signTransaction(next.transactions[1]);
		next.hash = next.calculateHash();
		next.signature = staker.signDigest(Buffer.from(next.hash, 'hex'));
		await expect(chain.addMinedBlock(next)).rejects.toThrow(
			'PoS block timestamp must be later than its parent',
		);
	});

	it('should reject a kernel younger than the minimum stake age', async () => {
		const staker = openWallet(dir, 'staker');
		const chain = openPosChain(dir);
		await mineBlocks(chain, staker.address, POS_TEST_CUTOFF); // no time for coins to age

		chain['_options'].minStakeAge = 0;
		const block = findStakeBlock(chain, staker);
		chain['_options'].minStakeAge = STAKE_MIN_AGE;

		await expect(chain.addMinedBlock(block)).rejects.toThrow('kernel input is too young to stake');
	});

	it('should keep coinstake outputs immature for COIN_MATURITY blocks', async () => {
		const { chain, staker } = await readyChain();
		const [block] = await stakeBlocks(chain, staker, 1);
		const coinstake = block.transactions[1];
		const spend = new Transaction(
			[{ previousTx: coinstake.calculateHash(), outputIndex: 1, publicKey: '', signature: '' }],
			[{ address: openWallet(dir, 'other').address, amount: coinstake.outputs[1].amount }],
		);
		staker.signTransaction(spend);

		await expect(chain.addTransaction(spend)).rejects.toThrow(
			'coinstake output has not reached maturity',
		);
	});

	it('should settle same-slot ties by the stake used, not by block contents a staker can vary', async () => {
		const a = openWallet(dir, 'a');
		const b = openWallet(dir, 'b');
		const options = { powCutoffBlock: 30, minStakeAge: 0 };
		const chain = openChain(dir, options);
		await mineBlocks(chain, a.address, 25);
		await chain.addTransaction(chain.createTransaction(a.address, b.address, 100n * COIN, a));
		await mineBlocks(chain, a.address, 5);
		await stakeBlocks(chain, a, 6); // until B's output has its confirmations

		// Both stake the same slot (every kernel hits while the PoS target is near its limit)
		const slot = nextStakeTime(chain);
		const [blockA, blockB] = [chain.createStakeBlock(a, slot)!, chain.createStakeBlock(b, slot)!];
		const tie = (block: Block) =>
			stakeTieBreak(block.previousHash, block.transactions[1].inputs[0].previousTx, block.transactions[1].inputs[0].outputIndex);
		const [winner, loser, loserWallet] = tie(blockA) < tie(blockB) ? [blockA, blockB, b] : [blockB, blockA, a];

		// The loser reworks its block (same stake, different coinbase) until its hash is lower than
		// the winner's: that used to win the tie
		const rework = (i: number, wallet: Wallet) => {
			const [coinbase, coinstake, ...rest] = loser.transactions;
			const changed = Transaction.coinbase(coinbase.outputs[0].address, coinbase.outputs[0].amount, loser.index, loser.timestamp - i);
			const variant = new Block(loser.timestamp, [changed, coinstake, ...rest], loser.previousHash, 0, loser.bits, loser.index);
			variant.signature = wallet.signDigest(Buffer.from(variant.hash, 'hex'));
			return variant;
		};
		let ground = loser;
		for (let i = 1; ground.hash >= winner.hash; i++) ground = rework(i, loserWallet);
		expect(tie(ground)).toBe(tie(loser));

		for (const order of [[winner, ground], [ground, winner]]) {
			const copy = makeTempDir(); // a fresh node with a copy of the stored chain
			try {
				fs.cpSync(path.join(dir, 'blocks'), path.join(copy, 'blocks'), { recursive: true });
				const node = openChain(copy, options);
				for (const block of order) await node.addMinedBlock(block);
				expect(node.getLatestBlock().hash).toBe(winner.hash);
			} finally {
				removeTempDir(copy);
			}
		}
	});
});
