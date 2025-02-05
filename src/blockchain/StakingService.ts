// In StakingService.ts
import { Blockchain } from './Blockchain';

export class StakingService {
	private checkInterval: NodeJS.Timeout | null = null;
	private readonly CHECK_FREQUENCY = 60000; // 1 minute

	constructor(
		private blockchain: Blockchain,
		private stakeholderAddress: string
	) {}

	start(): void {
		if (this.checkInterval) return;

		this.checkInterval = setInterval(() => {
			this.tryGenerateStakeBlock();
		}, this.CHECK_FREQUENCY);

		// Initial check
		this.tryGenerateStakeBlock();
	}

	stop(): void {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
		}
	}

	private tryGenerateStakeBlock(): void {
		try {
			const block = this.blockchain.generateStakeBlock(this.stakeholderAddress);
			if (block) {
				this.blockchain.addMinedBlock(block);
				console.log(`Generated PoS block at height ${block.index}`);
			}
		} catch (error) {
			console.error('Failed to generate stake block:', error);
			// Retry after a short delay
			setTimeout(() => this.tryGenerateStakeBlock(), 5000);
		}
	}
}
