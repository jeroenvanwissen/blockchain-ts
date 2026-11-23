// Kernel proof of stake (TASK-0009): any mature UTXO can stake; PoS blocks are signed by the
// coinstake owner; all PoS state (the stake modifier) is derived from the chain.
import { Block } from '../../blockchain/Block.js';
import { Transaction } from '../../blockchain/Transaction.js';
import { POS_BLOCK_REWARD, STAKE_MIN_AGE, STAKE_TIMESTAMP_GRANULARITY } from '../../config.js';
import {
	findStakeBlock,
	finishPowPhase,
	makeTempDir,
	mineBlocks,
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
		await expect(chain.addMinedBlock(received)).resolves.toBeUndefined();
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
});
