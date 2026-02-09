// In StakingService.ts
import { Blockchain } from './Blockchain.js';
import { Wallet } from './Wallet.js';

export class StakingService {
	private checkInterval: NodeJS.Timeout | null = null;
	private readonly CHECK_FREQUENCY = 60000; // 1 minute

	constructor(
		private blockchain: Blockchain,
		private stakeholderAddress: string,
		private wallet: Wallet,
	) {}

	start(): void {
		if (this.checkInterval) return;

		this.checkInterval = setInterval(() => {
			void this.tryGenerateStakeBlock();
		}, this.CHECK_FREQUENCY);

		// Initial check
		void this.tryGenerateStakeBlock();
	}

	stop(): void {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
		}
	}

	private async tryGenerateStakeBlock(): Promise<void> {
		try {
			const block = this.blockchain.generateStakeBlock(this.stakeholderAddress, this.wallet);
			if (block) {
				await this.blockchain.addMinedBlock(block);
				console.log(`Generated PoS block at height ${block.index}`);
			}
		} catch (error) {
			console.error('Failed to generate stake block:', error);
			// Retry after a short delay
			setTimeout(() => void this.tryGenerateStakeBlock(), 5000);
		}
	}
}
