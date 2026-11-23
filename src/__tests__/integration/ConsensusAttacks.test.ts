// Regression tests for the attack scenarios in tasks/assessment-2026-11-23.md.
// Each asserts the *desired* behaviour and is marked test.failing until the fixing task lands;
// that task turns it into a normal test (rewriting it if the API changed).
import { Block } from '../../blockchain/Block.js';
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { Transaction } from '../../blockchain/Transaction.js';
import type { Wallet } from '../../blockchain/Wallet.js';
import { BLOCK_TIME, COIN_MATURITY, POW_BLOCK_REWARD } from '../../config.js';
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

const STAKE_AMOUNT = 100;
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

describe('Consensus attacks (assessment 2026-11-23)', () => {
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

	/** Mine enough blocks for STAKE_AMOUNT of mature coins, stake them, and let stake age pass. */
	async function stakeDuringPowPhase(chain: Blockchain, staker: Wallet): Promise<void> {
		const matureBlocksNeeded = Math.ceil(STAKE_AMOUNT / POW_BLOCK_REWARD);
		await mineBlocks(chain, staker.address, COIN_MATURITY + matureBlocksNeeded + 1);
		await chain.stake(staker.address, STAKE_AMOUNT, staker);
		advanceTime(TWO_DAYS_MS);
	}

	// F-004 — fixed by TASK-0005
	test.failing('should reject spending a victim output with a forged signature', async () => {
		const victim = openWallet(dir, 'victim');
		const attacker = openWallet(dir, 'attacker');
		const chain = openChain(dir);
		await mineBlocks(chain, victim.address, COIN_MATURITY + 2);

		const utxo = chain.getUTXOs(victim.address)[0];
		const forged = new Transaction(
			[{ previousTx: utxo.txHash, outputIndex: utxo.outputIndex, signature: 'ff' }],
			[{ address: attacker.address, amount: utxo.output.amount }],
		);

		await expect(chain.addTransaction(forged)).rejects.toThrow();
	});

	// F-005 — fixed by TASK-0006
	test.failing('should reject a block that spends a non-existent output', async () => {
		const attacker = openWallet(dir, 'attacker');
		const chain = openChain(dir);
		await mineBlocks(chain, attacker.address, 1);

		advanceTime(BLOCK_TIME * 1000);
		const coinbase = new Transaction([], [{ address: attacker.address, amount: POW_BLOCK_REWARD }]);
		const fromNothing = new Transaction(
			[{ previousTx: 'aa'.repeat(32), outputIndex: 0, signature: 'ff' }],
			[{ address: attacker.address, amount: 1_000_000 }],
		);
		const block = solve(
			new Block(
				Date.now(),
				[coinbase, fromNothing],
				chain.getLatestBlock().hash,
				0,
				chain.calculateNewDifficulty(),
				chain.getChain().length,
			),
		);

		await expect(chain.addMinedBlock(block)).rejects.toThrow();
	});

	// F-006 — fixed by TASK-0009 / TASK-0011
	test.failing('should rebuild stake state from the chain after a restart', async () => {
		const staker = openWallet(dir, 'staker');
		const chain = openChain(dir);
		await stakeDuringPowPhase(chain, staker);
		await chain.minePendingTransactions(staker.address); // puts the stake tx on chain
		expect(chain.getStake(staker.address)).toBe(STAKE_AMOUNT);

		const restarted = openChain(dir);
		expect(restarted.getChain()).toHaveLength(chain.getChain().length);
		expect(restarted.getStake(staker.address)).toBe(STAKE_AMOUNT);
	});

	// F-007 — fixed by TASK-0009
	test.failing('should not turn a PoW-phase block into an unchecked PoS block', async () => {
		const staker = openWallet(dir, 'staker');
		const chain = openChain(dir);
		await stakeDuringPowPhase(chain, staker);

		const block = await chain.minePendingTransactions(staker.address);

		expect(block.isProofOfStake()).toBe(false);
	});
});
