import type { Block } from './Block.js';
import type { Blockchain } from './Blockchain.js';
import type { Wallet } from './Wallet.js';
import { STAKE_CHECK_INTERVAL, STAKE_CHECK_OFFSET, STAKE_TIMESTAMP_GRANULARITY } from '../config.js';

/**
 * Stakes PoS blocks with the node's wallet. For each 16 s timestamp slot (and again when the
 * tip changes, which changes the stake modifier) it asks the chain whether one of the wallet's
 * mature outputs has a kernel that meets the target, and submits the resulting block.
 *
 * Checks run on wall-clock interval boundaries (plus a small offset), so every staker tries a
 * new slot at the same moment. With free-running timers the node whose timer fires first after
 * a slot starts always wins it: the others see its block before they try, so same-slot
 * candidates never meet and the lower-hash tie-break never gets a choice.
 */
export class StakingService {
	private _timer: NodeJS.Timeout | null = null;
	private _lastAttempt = ''; // `${tipHash}:${slot}`
	private _isBusy = false;

	constructor(
		private readonly _blockchain: Blockchain,
		private readonly _wallet: Wallet,
		private readonly _onBlockStaked: (block: Block) => void = () => {},
	) {}

	isRunning(): boolean {
		return this._timer !== null;
	}

	start(): void {
		if (this._timer) return;
		this._scheduleCheck();
		void this.tryStake();
	}

	stop(): void {
		if (this._timer) clearTimeout(this._timer);
		this._timer = null;
	}

	/** Next check just after the next multiple of STAKE_CHECK_INTERVAL on the wall clock. */
	private _scheduleCheck(): void {
		const delay = STAKE_CHECK_INTERVAL - (Date.now() % STAKE_CHECK_INTERVAL) + STAKE_CHECK_OFFSET;
		this._timer = setTimeout(() => {
			void this.tryStake();
			this._scheduleCheck();
		}, delay);
	}

	/** One staking attempt for the slot containing `now`; returns the staked block, if any. */
	async tryStake(now = Date.now()): Promise<Block | null> {
		if (this._isBusy || !this._blockchain.isProofOfStakePhase()) return null;
		const slot = Math.floor(now / STAKE_TIMESTAMP_GRANULARITY) * STAKE_TIMESTAMP_GRANULARITY;
		const attempt = `${this._blockchain.getLatestBlock().hash}:${slot}`;
		if (attempt === this._lastAttempt) return null;
		this._lastAttempt = attempt;

		const block = this._blockchain.createStakeBlock(this._wallet, slot);
		if (!block) return null;

		this._isBusy = true;
		try {
			await this._blockchain.addMinedBlock(block);
			console.log(`[Staking] staked block ${block.index} (${block.hash.slice(0, 16)})`);
			this._onBlockStaked(block);
			return block;
		} catch (error) {
			// e.g. another block arrived first; the next slot or tip gets a fresh attempt
			console.error('[Staking] block rejected:', (error as Error).message);
			return null;
		} finally {
			this._isBusy = false;
		}
	}
}
