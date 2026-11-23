// Regression tests for the attack scenarios in tasks/assessment-2026-11-23.md. Each asserts the
// desired behaviour; open scenarios are marked test.failing until the fixing task lands.
import { Block } from '../../blockchain/Block.js';
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { Transaction } from '../../blockchain/Transaction.js';
import type { Wallet } from '../../blockchain/Wallet.js';
import { BLOCK_TIME, COIN_MATURITY, POS_BLOCK_REWARD, POW_BLOCK_REWARD } from '../../config.js';
import {
	advanceTime,
	findStakeBlock,
	finishPowPhase,
	makeTempDir,
	mineBlocks,
	openChain,
	openPosChain,
	openWallet,
	removeTempDir,
	solve,
	stakeBlocks,
	useTestClock,
} from './helpers.js';

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

	// F-004 — fixed by TASK-0005
	describe('spending a victim output (F-004)', () => {
		async function victimUtxoSpend(): Promise<{ chain: Blockchain; tx: Transaction; victim: Wallet; attacker: Wallet }> {
			const victim = openWallet(dir, 'victim');
			const attacker = openWallet(dir, 'attacker');
			const chain = openChain(dir);
			await mineBlocks(chain, victim.address, COIN_MATURITY + 2);
			const utxo = chain.getUTXOs(victim.address)[0];
			const tx = new Transaction(
				[{ previousTx: utxo.txHash, outputIndex: utxo.outputIndex, publicKey: '', signature: '' }],
				[{ address: attacker.address, amount: utxo.output.amount }],
			);
			return { chain, tx, victim, attacker };
		}

		test('should reject a spend signed with another wallet key', async () => {
			const { chain, tx, attacker } = await victimUtxoSpend();
			attacker.signTransaction(tx); // valid signature, but not by the output owner

			await expect(chain.addTransaction(tx)).rejects.toThrow(
				'input public key does not own the spent output',
			);
		});

		test('should reject a forged signature under the victim public key', async () => {
			const { chain, tx, victim } = await victimUtxoSpend();
			tx.inputs[0].publicKey = victim.publicKey.toString('hex');
			tx.inputs[0].signature = 'aa'.repeat(64);

			await expect(chain.addTransaction(tx)).rejects.toThrow('invalid input signature');
		});
	});

	// F-005 — fixed by TASK-0006
	test('should reject a block that spends a non-existent output', async () => {
		const attacker = openWallet(dir, 'attacker');
		const chain = openChain(dir);
		await mineBlocks(chain, attacker.address, 1);

		advanceTime(BLOCK_TIME * 1000);
		const coinbase = Transaction.coinbase(attacker.address, POW_BLOCK_REWARD, chain.getChain().length);
		const fromNothing = new Transaction(
			[{ previousTx: 'aa'.repeat(32), outputIndex: 0, publicKey: '', signature: '' }],
			[{ address: attacker.address, amount: 1_000_000n * POW_BLOCK_REWARD }],
		);
		attacker.signTransaction(fromNothing); // validly signed; the spent output doesn't exist
		const block = solve(
			new Block(
				Date.now(),
				[coinbase, fromNothing],
				chain.getLatestBlock().hash,
				0,
				chain.getRequiredBits(),
				chain.getChain().length,
			),
		);

		await expect(chain.addMinedBlock(block)).rejects.toThrow(
			'transaction 1: input references a missing or spent output',
		);
		expect(chain.getBalance(attacker.address)).toBe(POW_BLOCK_REWARD);
	});

	// F-006 — fixed by TASK-0009/TASK-0011: no node-local stake state; the stake modifier is
	// derived from the chain, so a restarted node validates the next PoS block
	test('should rebuild PoS state from the chain after a restart', async () => {
		const staker = openWallet(dir, 'staker');
		const chain = openPosChain(dir);
		await finishPowPhase(chain, staker.address);
		await stakeBlocks(chain, staker, 3);

		const restarted = openPosChain(dir);
		expect(restarted.getStakeModifier()).toBe(chain.getStakeModifier());
		const next = findStakeBlock(chain, staker);
		await expect(restarted.addMinedBlock(next)).resolves.toBe('connected');
	});

	// F-007 — fixed by TASK-0009: coinstakes never enter the mempool, and a block classified as
	// PoS (coinstake at tx[1]) is rejected in the PoW phase
	test('should not let a coinstake turn a PoW-phase block into a PoS block', async () => {
		const staker = openWallet(dir, 'staker');
		const chain = openChain(dir);
		await mineBlocks(chain, staker.address, COIN_MATURITY + 2);
		const utxo = chain.getUTXOs(staker.address)[0];
		const coinstakeShaped = new Transaction(
			[{ previousTx: utxo.txHash, outputIndex: utxo.outputIndex, publicKey: '', signature: '' }],
			[
				{ address: staker.address, amount: 0n },
				{ address: staker.address, amount: utxo.output.amount },
			],
		);
		staker.signTransaction(coinstakeShaped);

		await expect(chain.addTransaction(coinstakeShaped)).rejects.toThrow(
			'coinstake transactions are only valid in blocks',
		);

		advanceTime(BLOCK_TIME * 1000);
		const height = chain.getChain().length;
		const block = new Block(
			Date.now(),
			[Transaction.coinbase(staker.address, POS_BLOCK_REWARD, height), coinstakeShaped],
			chain.getLatestBlock().hash,
			0,
			chain.getRequiredBits(true),
			height,
		);
		expect(block.isProofOfStake()).toBe(true);
		await expect(chain.addMinedBlock(block)).rejects.toThrow('PoS blocks not accepted before block');
	});

	// F-009 — closed by TASK-0006 (coinstakes go through the same input checks as other txs)
	test('should reject a coinstake that pays out more than its inputs', async () => {
		const staker = openWallet(dir, 'staker');
		const chain = openPosChain(dir);
		await finishPowPhase(chain, staker.address);
		const block = findStakeBlock(chain, staker);
		const coinstake = block.transactions[1];
		coinstake.outputs[1].amount += 1_000n * POW_BLOCK_REWARD;
		staker.signTransaction(coinstake); // validly signed, but outputs exceed inputs
		block.hash = block.calculateHash();
		block.signature = staker.signDigest(Buffer.from(block.hash, 'hex'));

		await expect(chain.addMinedBlock(block)).rejects.toThrow('output amounts exceed input amounts');
	});
});
