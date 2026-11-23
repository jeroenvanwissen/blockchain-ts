import { Worker } from 'worker_threads';
import type { Block } from './Block.js';
import type { Blockchain } from './Blockchain.js';
import { MAX_BLOCK_NONCE, MINER_RETRY_DELAY, MINER_TIP_POLL_INTERVAL } from '../config.js';

type WorkerResult = { type: 'found'; nonce: number; hash: string } | { type: 'exhausted' };

interface Solution {
	nonce: number;
	hash: string;
}

/**
 * Proof-of-work miner running inside the node. Builds each block from the node's own
 * chain state, hashes in a worker thread, and abandons the job when the tip changes.
 * `workerPath` points at miningWorker.cjs (resolved by the entry point).
 */
export class Miner {
	private _running = false;
	private _loop: Promise<void> | null = null;
	private _cancelSearch: (() => void) | null = null;
	private _sleepTimer: NodeJS.Timeout | null = null;
	private _wake: (() => void) | null = null;

	constructor(
		private readonly _blockchain: Blockchain,
		private readonly _rewardAddress: string,
		private readonly _workerPath: string,
		private readonly _onBlockMined: (block: Block) => void = () => {},
	) {}

	isRunning(): boolean {
		return this._running;
	}

	start(): void {
		if (this._running) return;
		this._running = true;
		this._loop = this._run();
	}

	async stop(): Promise<void> {
		this._running = false;
		this._cancelSearch?.();
		if (this._sleepTimer) clearTimeout(this._sleepTimer);
		this._wake?.();
		await this._loop;
	}

	private async _run(): Promise<void> {
		while (this._running) {
			try {
				await this._mineOne();
			} catch (error) {
				console.error('[Miner] block rejected:', (error as Error).message);
				await this._sleep(MINER_RETRY_DELAY);
			}
		}
	}

	private async _mineOne(): Promise<void> {
		if (!this._blockchain.canAcceptPowBlock()) {
			console.log('[Miner] PoW phase is over; stopping');
			this._running = false;
			return;
		}

		const minTimestamp = this._blockchain.getNextBlockMinTimestamp();
		if (minTimestamp > Date.now()) {
			await this._sleep(minTimestamp - Date.now());
			return; // re-check the tip and phase before building a template
		}

		const block = this._blockchain.createBlockTemplate(
			this._rewardAddress,
			Math.max(Date.now(), minTimestamp),
		);
		const solution = await this._search(block);
		if (!solution || !this._running) return; // tip changed, stopped, or nonces exhausted

		block.nonce = solution.nonce;
		block.hash = solution.hash;
		await this._blockchain.addMinedBlock(block);
		console.log(`[Miner] mined block ${block.index} (${block.hash.slice(0, 16)})`);
		this._onBlockMined(block);
	}

	private _search(block: Block): Promise<Solution | null> {
		return new Promise((resolve, reject) => {
			const worker = new Worker(this._workerPath, {
				workerData: {
					prefix: block.powPrefix(),
					difficulty: block.powDifficulty,
					startNonce: 0,
					maxNonce: MAX_BLOCK_NONCE,
				},
			});
			let isDone = false;

			const finish = (result: Solution | null, error?: Error) => {
				if (isDone) return;
				isDone = true;
				clearInterval(tipWatch);
				this._cancelSearch = null;
				void worker.terminate();
				if (error) reject(error);
				else resolve(result);
			};

			// Abandon the job if another block extended the chain meanwhile
			const tipWatch = setInterval(() => {
				if (this._blockchain.getLatestBlock().hash !== block.previousHash) finish(null);
			}, MINER_TIP_POLL_INTERVAL);

			this._cancelSearch = () => finish(null);
			worker.once('message', (message: WorkerResult) => {
				finish(message.type === 'found' ? { nonce: message.nonce, hash: message.hash } : null);
			});
			worker.once('error', (error) => finish(null, error));
		});
	}

	private _sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this._wake = () => {
				this._wake = null;
				this._sleepTimer = null;
				resolve();
			};
			this._sleepTimer = setTimeout(this._wake, ms);
		});
	}
}
