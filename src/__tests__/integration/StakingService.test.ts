// Staking loop (TASK-0010) with accelerated params: short PoW phase and no minimum stake age
// (confirmations and maturity still apply), so outputs can restake within a short simulation.
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { StakingService } from '../../blockchain/StakingService.js';
import {
	COIN,
	STAKE_CHECK_INTERVAL,
	STAKE_CHECK_OFFSET,
	STAKE_TIMESTAMP_GRANULARITY,
	TARGET_SPACING,
} from '../../config.js';
import {
	advanceTime,
	finishPowPhase,
	makeTempDir,
	mineBlocks,
	openChain,
	openWallet,
	removeTempDir,
	useTestClock,
} from './helpers.js';

const SLOT = STAKE_TIMESTAMP_GRANULARITY;

/** Advance one slot at a time, letting every service try once per slot. */
async function runSlots(services: StakingService[], slots: number, until?: () => boolean): Promise<void> {
	for (let i = 0; i < slots && !until?.(); i++) {
		advanceTime(SLOT);
		for (const service of services) await service.tryStake();
	}
}

function posBlocks(chain: Blockchain) {
	return chain.getChain().filter((b) => b.isProofOfStake());
}

describe('StakingService', () => {
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

	it('should not stake during the PoW phase', async () => {
		const staker = openWallet(dir, 'staker');
		const chain = openChain(dir, { powCutoffBlock: 12, minStakeAge: 0 });
		await mineBlocks(chain, staker.address, 5);

		await expect(new StakingService(chain, staker).tryStake()).resolves.toBeNull();
	});

	it('should move to PoS at the cutoff and settle near the target spacing', async () => {
		const staker = openWallet(dir, 'staker');
		const chain = openChain(dir, { powCutoffBlock: 12, minStakeAge: 0 });
		await finishPowPhase(chain, staker.address);
		const service = new StakingService(chain, staker);

		await runSlots([service], 5000, () => posBlocks(chain).length >= 300);

		const blocks = chain.getChain();
		expect(blocks[13].isProofOfStake()).toBe(true);
		expect(blocks.slice(13).every((b) => b.isProofOfStake())).toBe(true);
		const pos = posBlocks(chain);
		expect(pos.length).toBeGreaterThanOrEqual(300);
		// The first ~120 PoS blocks win every slot while the target tightens from POS_LIMIT;
		// afterwards the average spacing should hover around TARGET_SPACING (30 s)
		const recent = pos.slice(-100);
		const averageSpacing = (recent[recent.length - 1].timestamp - recent[0].timestamp) / 99;
		expect(averageSpacing).toBeGreaterThan(0.6 * TARGET_SPACING);
		expect(averageSpacing).toBeLessThan(2 * TARGET_SPACING);
		expect(chain.isChainValid()).toBe(true);
	});

	it('should let two stakers both produce blocks (same-slot blocks settled by the tie-break)', async () => {
		const a = openWallet(dir, 'a');
		const b = openWallet(dir, 'b');
		const chain = openChain(dir, { powCutoffBlock: 30, minStakeAge: 0 });
		await mineBlocks(chain, a.address, 25);
		await chain.addTransaction(chain.createTransaction(a.address, b.address, 100n * COIN, a));
		await mineBlocks(chain, a.address, 5);
		advanceTime(60_000);

		// Like a network: both stakers build on the same tip in each slot, both blocks arrive,
		// and fork choice (equal work → lower stake tie-break) keeps one
		for (let i = 0; i < 3000 && posBlocks(chain).length < 200; i++) {
			advanceTime(SLOT);
			const slot = Math.floor(Date.now() / SLOT) * SLOT;
			const candidates = [a, b]
				.map((wallet) => chain.createStakeBlock(wallet, slot))
				.filter((block): block is NonNullable<typeof block> => block !== null);
			for (const block of candidates) await chain.addMinedBlock(block);
		}

		const stakedBy = (address: string) =>
			posBlocks(chain).filter((block) => block.transactions[1].outputs[1].address === address).length;
		expect(stakedBy(a.address)).toBeGreaterThan(10);
		expect(stakedBy(b.address)).toBeGreaterThan(10);
		expect(chain.isChainValid()).toBe(true);
	});

	it('should try each slot once per tip and retry when the tip changes', async () => {
		const staker = openWallet(dir, 'staker');
		const chain = openChain(dir, { powCutoffBlock: 12, minStakeAge: 0 });
		await finishPowPhase(chain, staker.address);
		const service = new StakingService(chain, staker);
		const create = jest.spyOn(chain, 'createStakeBlock').mockReturnValueOnce(null);

		advanceTime(SLOT);
		await service.tryStake();
		await service.tryStake(); // same slot, same tip: skipped
		expect(create).toHaveBeenCalledTimes(1);

		advanceTime(SLOT);
		const block = await service.tryStake();
		expect(block?.isProofOfStake()).toBe(true);
		expect(create).toHaveBeenCalledTimes(2);
	});

	it('should check on wall-clock interval boundaries, whenever it starts', () => {
		const staker = openWallet(dir, 'staker');
		const service = new StakingService(openChain(dir), staker);
		const checks: number[] = [];
		jest.spyOn(service, 'tryStake').mockImplementation(() => {
			checks.push(Date.now());
			return Promise.resolve(null);
		});
		const boundary = Math.ceil(Date.now() / STAKE_CHECK_INTERVAL) * STAKE_CHECK_INTERVAL;
		jest.setSystemTime(boundary + 377); // mid-interval

		service.start();
		jest.advanceTimersByTime(3 * STAKE_CHECK_INTERVAL);
		service.stop();
		jest.advanceTimersByTime(3 * STAKE_CHECK_INTERVAL);

		// Every node ticks at the same moments, so all stakers try a new slot together
		expect(checks).toEqual([
			boundary + 377, // immediately on start
			...[1, 2, 3].map((i) => boundary + i * STAKE_CHECK_INTERVAL + STAKE_CHECK_OFFSET),
		]);
	});

	it('should keep staking after a rejected block', async () => {
		const staker = openWallet(dir, 'staker');
		const chain = openChain(dir, { powCutoffBlock: 12, minStakeAge: 0 });
		await finishPowPhase(chain, staker.address);
		const service = new StakingService(chain, staker);
		const add = chain.addMinedBlock.bind(chain);
		jest.spyOn(chain, 'addMinedBlock').mockRejectedValueOnce(new Error('simulated')).mockImplementation(add);
		const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

		await runSlots([service], 1);
		expect(errors).toHaveBeenCalledWith(expect.stringContaining('WARN  [Staking] block rejected:'), 'simulated');
		await runSlots([service], 5, () => posBlocks(chain).length > 0);
		expect(posBlocks(chain).length).toBe(1);
	});
});
