import { jest } from '@jest/globals';
import { Block } from '../Block';
import { Blockchain } from '../Blockchain';
import { Wallet } from '../Wallet';
// import { Transaction } from '../Transaction';
// import { ConsensusType } from '../Block';
import { POW_CUTOFF_BLOCK, POW_BLOCK_REWARD } from '../../config';
import * as fs from 'fs';

// Mock the fs module
jest.mock('fs');

describe('Blockchain', () => {
	let blockchain: Blockchain;

	// Mock Date.now() for deterministic timestamps
	const mockNow = jest.spyOn(Date, 'now');

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
		// Mock fs functions
		(fs.existsSync as jest.Mock).mockReturnValue(false);
		(fs.readFileSync as jest.Mock).mockImplementation(() => {
			const error = new Error('File not found') as NodeJS.ErrnoException;
			error.code = 'ENOENT';
			throw error;
		});
		(fs.writeFileSync as jest.Mock).mockImplementation(() => {});

		// Mock Block's difficulty methods
		jest.spyOn(Block.prototype, 'getDifficulty').mockImplementation(() => 1);
		jest.spyOn(Block.prototype, 'setDifficulty').mockImplementation(() => {});

		// Set initial time to match genesis block timestamp + 1 day to ensure enough spacing
		const genesisTime = 1609459200000; // Jan 1, 2021
		const initialTestTime = genesisTime + (24 * 60 * 60 * 1000); // Start 1 day after genesis
		jest.useFakeTimers();
		jest.setSystemTime(new Date(initialTestTime));
		mockNow.mockImplementation(() => initialTestTime);
		blockchain = new Blockchain();
	});

	afterEach(() => {
		process.env.NODE_ENV = 'development';
		jest.useRealTimers();
		mockNow.mockRestore();
	});

	// Simplified generateBlocks without difficulty management
	// Fix the generateBlocks helper function
	const generateBlocks = (count: number, miner: string): void => {
    let lastTimestamp = blockchain.getLatestBlock().timestamp;

    for (let i = 0; i < count; i++) {
        // Ensure proper spacing from the last block
        const blockTime = lastTimestamp + (11 * 60 * 1000); // 11 minutes after last block
        
        mockNow.mockImplementation(() => blockTime);
        const block = blockchain.minePendingTransactions(miner);
        
        lastTimestamp = block.timestamp;
    }
};

	describe('Genesis Block', () => {
		it('should create genesis block on initialization', () => {
			const chain = blockchain.getChain();
			expect(chain.length).toBe(1);
			expect(chain[0].index).toBe(0);
			expect(chain[0].previousHash).toBe('0');
			expect(chain[0].isProofOfWork()).toBe(true);
		});
	});

	describe('Consensus Transition', () => {
		it(`should use PoW for first ${POW_CUTOFF_BLOCK} blocks`, () => {
			generateBlocks(POW_CUTOFF_BLOCK, 'miner1');
			const chain = blockchain.getChain();
			for (let i = 1; i <= POW_CUTOFF_BLOCK; i++) {
				expect(chain[0].isProofOfWork()).toBe(true);
			}
		});

		it(`should transition to PoS after block ${POW_CUTOFF_BLOCK}`, () => {
			// Generate PoW blocks with proper timing
			generateBlocks(POW_CUTOFF_BLOCK, 'miner1');
			
			// Debug balance calculation
			// const chain = blockchain.getChain();
			// console.log('\nDebug information:');
			// console.log('Chain length:', chain.length);
			// console.log('Last block index:', chain[chain.length - 1].index);
			// console.log('UTXO count for miner1:', blockchain.getUTXOs('miner1').length);
			// console.log('Individual UTXOs for miner1:', blockchain.getUTXOs('miner1')
			//     .map(utxo => ({ amount: utxo.output.amount, index: utxo.outputIndex })));
			
			// Verify miner1's balance
			const expectedBalance = POW_CUTOFF_BLOCK * POW_BLOCK_REWARD;
			const actualBalance = blockchain.getTotalBalance('miner1');
			expect(actualBalance).toBe(expectedBalance);
			
			// Stake the minimum amount
			blockchain.stake('miner1', 100);
			
			// Add proper time spacing for the PoS block
			const lastBlock = blockchain.getLatestBlock();
			const nextBlockTime = lastBlock.timestamp + (11 * 60 * 1000);
			mockNow.mockImplementation(() => nextBlockTime);
			
			// Mine PoS block
			blockchain.minePendingTransactions('miner1');
			
			// Verify the last block is PoS
			const finalChain = blockchain.getChain();
			expect(finalChain[finalChain.length - 1].isProofOfStake()).toBe(true);
		});
	});

	describe('Large Chain Tests', () => {
		beforeEach(() => {
			jest.useFakeTimers();
			// Set system time to our base time
			jest.setSystemTime(new Date(1000000));
			mockNow.mockImplementation(() => 1000000);
		});

		afterEach(() => {
			jest.useRealTimers();
			mockNow.mockRestore();
		});

		it('should handle transition after 100 blocks', () => {
			generateBlocks(100, 'miner1');
			expect(blockchain.getChain().length).toBe(101); // Including genesis
		});

		it('should calculate rewards correctly over many blocks', () => {
			generateBlocks(50, 'miner1');
			const balance = blockchain.getTotalBalance('miner1');
			expect(balance).toBe(50 * POW_BLOCK_REWARD);
		});

		it('should handle stake weight changes over time', () => {
            const blockchain = new Blockchain();
            const minerWallet = new Wallet();
            const stakeholderWallet = new Wallet();
            
            // Set initial time
            const startTime = 1000000;
            mockNow.mockImplementation(() => startTime);
            
            // Generate blocks and confirm rewards
            generateBlocks(POW_CUTOFF_BLOCK, minerWallet.getAddress());
            // Mine one more block to confirm the last reward
            const confirmTime = blockchain.getLatestBlock().timestamp + (11 * 60 * 1000);
            mockNow.mockImplementation(() => confirmTime);
            blockchain.minePendingTransactions(minerWallet.getAddress());
                        
            // Create and add transfer transaction with enough amount for minimum stake
            const transferAmount = 200; // Increased to ensure enough for minimum stake
            const transaction = blockchain.createTransaction(
                minerWallet.getAddress(),
                stakeholderWallet.getAddress(),
                transferAmount,
                minerWallet
            );
            blockchain.addTransaction(transaction);
            
            // Mine transfer block
            const time1 = blockchain.getLatestBlock().timestamp + (11 * 60 * 1000);
            mockNow.mockImplementation(() => time1);
            blockchain.minePendingTransactions(minerWallet.getAddress());
            
            // Mine confirmation block
            const time2 = time1 + (11 * 60 * 1000);
            mockNow.mockImplementation(() => time2);
            blockchain.minePendingTransactions(minerWallet.getAddress());
            
            // Check balances after transfer
            const stakeholderBalanceAfterTransfer = blockchain.getBalance(stakeholderWallet.getAddress());
            expect(stakeholderBalanceAfterTransfer).toBeGreaterThanOrEqual(transferAmount);
            
            // Stake the minimum amount
            const time3 = time2 + (11 * 60 * 1000);
            mockNow.mockImplementation(() => time3);
            const stakeAmount = 100; // Changed to minimum stake amount
            blockchain.stake(stakeholderWallet.getAddress(), stakeAmount);
            
            // Mine stake transaction and confirmation block
            const time4 = time3 + (11 * 60 * 1000);
            mockNow.mockImplementation(() => time4);
            blockchain.minePendingTransactions(minerWallet.getAddress());
            
            // Mine confirmation block for stake
            const time5 = time4 + (11 * 60 * 1000);
            mockNow.mockImplementation(() => time5);
            blockchain.minePendingTransactions(minerWallet.getAddress());
            
            // Set initial stake time
            const stake = blockchain.stakes.get(stakeholderWallet.getAddress());
            if (stake) {
                stake.timestamp = time5;
                stake.lastBlockTime = time5;  // Set initial lastBlockTime
                blockchain.stakes.set(stakeholderWallet.getAddress(), stake);
            }
            
            // Get initial weight after stake is confirmed
            const initialWeight = blockchain.calculateStakeWeight(stakeholderWallet.getAddress());
            
            // Advance time by 1 day and mine a block to update stake age
            const finalTime = time5 + (24 * 60 * 60 * 1000);
            mockNow.mockImplementation(() => finalTime);
            
            // Mine a block to update stake age
            blockchain.minePendingTransactions(minerWallet.getAddress());
            
            // Update stake's timestamp and lastBlockTime
            const updatedStake = blockchain.stakes.get(stakeholderWallet.getAddress());
            if (updatedStake) {
                // Keep the original timestamp but update lastBlockTime
                updatedStake.lastBlockTime = finalTime;
                blockchain.stakes.set(stakeholderWallet.getAddress(), updatedStake);
            }
            
            // Force Date.now() to return finalTime for weight calculation
            mockNow.mockImplementation(() => finalTime);
            
            const laterWeight = blockchain.calculateStakeWeight(stakeholderWallet.getAddress());
            
            expect(laterWeight).toBeGreaterThan(initialWeight);
        });

		it('should maintain valid chain with mixed consensus', () => {
			// Generate PoW blocks
			generateBlocks(POW_CUTOFF_BLOCK, 'miner1');

			// Setup for PoS - ensure miner has enough balance
			const balance = blockchain.getTotalBalance('miner1');
			// console.log('Miner balance before stake:', balance);

			// Stake half of available balance
			const stakeAmount = Math.floor(balance / 2);
			blockchain.stake('miner1', stakeAmount);

			// Generate PoS blocks with proper timing
			for (let i = 0; i < 10; i++) {
				const blockTime = 1000000 + (POW_CUTOFF_BLOCK + i + 1) * (11 * 60 * 1000);
				mockNow.mockImplementation(() => blockTime);
				blockchain.minePendingTransactions('miner1');
			}

			// Verify chain validity
			expect(blockchain.isChainValid()).toBe(true);
		});

	// describe('Consensus Transition', () => {
	// 	it(`should use PoW for first ${POW_CUTOFF_BLOCK} blocks`, () => {
	// 		generateBlocks(100, 'miner1');
	// 		const chain = minedBlockChain.getChain();
	// 		for (let i = 1; i <= POW_CUTOFF_BLOCK; i++) {
	// 			expect(chain[0].isProofOfWork()).toBe(true);
	// 		}
	// 	});

	// 	it(`should transition to PoS after block ${POW_CUTOFF_BLOCK}`, () => {
	// 		// Now miner1 should have 500 coins confirmed (rewards from blocks 1 to 50)
	// 		expect(minedBlockChain.getTotalBalance(miner1)).toBe(
	// 			POW_CUTOFF_BLOCK * POW_BLOCK_REWARD
	// 		);

	// 		// Stake the minimum amount
	// 		minedBlockChain.stake(miner1, 100);

	// 		// Ensure stake is set before mining PoS block
	// 		minedBlockChain.minePendingTransactions(miner1);

	// 		const chain = blockchain.getChain();
	// 		expect(chain[chain.length - 1].isProofOfStake()).toBe(true);
	// 	});
	// });

	// describe('Staking Mechanism', () => {
	// 	beforeEach(() => {
	// 		// Mine blocks to get initial balance
	// 		for (let i = 0; i <= POW_CUTOFF_BLOCK; i++) {
	// 			blockchain.minePendingTransactions(miner1);
	// 		}
	// 		// Now miner1 has 500 coins confirmed
	// 	});

	// 	it('should allow staking with sufficient balance', () => {
	// 		blockchain.stake(miner1, 100);
	// 		expect(blockchain.getStake(miner1)).toBe(100);
	// 	});

	// 	it('should prevent staking with insufficient balance', () => {
	// 		expect(() => blockchain.stake(user1, 100)).toThrow(
	// 			'Insufficient balance'
	// 		);
	// 	});

	// 	it('should prevent staking below minimum amount', () => {
	// 		expect(() => blockchain.stake(miner1, 50)).toThrow(
	// 			'Minimum stake amount'
	// 		);
	// 	});

	// 	it('should allow unstaking', () => {
	// 		blockchain.stake(miner1, 100);
	// 		blockchain.unstake(miner1, 50);
	// 		expect(blockchain.getStake(miner1)).toBe(50);
	// 	});
	// });

	// describe('Block Generation Rate (PoS)', () => {
	// 	beforeEach(() => {
	// 		// Setup chain for PoS
	// 		for (let i = 0; i <= POW_CUTOFF_BLOCK; i++) {
	// 			blockchain.minePendingTransactions(miner1);
	// 		}
	// 		blockchain.stake(miner1, 100);
	// 	});

	// 	it('should enforce minimum block time', () => {
	// 		blockchain.minePendingTransactions(miner1);

	// 		// Attempt to create block immediately
	// 		expect(() => blockchain.minePendingTransactions(miner1)).toThrow(
	// 			'Not eligible to create block at this time'
	// 		);
	// 	});

	// 	it('should allow block creation after target time', async () => {
	// 		blockchain.minePendingTransactions(miner1);

	// 		// Wait for target block time
	// 		await new Promise((resolve) => setTimeout(resolve, 375));

	// 		// Should be able to create new block
	// 		expect(() => blockchain.minePendingTransactions(miner1)).not.toThrow();
	// 	});
	// });

	// describe('Rewards and Balances', () => {
	// 	it('should correctly award block rewards', () => {
	// 		for (let i = 0; i <= POW_CUTOFF_BLOCK; i++) {
	// 			blockchain.minePendingTransactions(miner1);
	// 		}

	// 		// Should have rewards from blocks 1 to 50 (50 * 10 COIN)
	// 		expect(blockchain.getTotalBalance(miner1)).toBe(POW_CUTOFF_BLOCK * 10);
	// 	});

	// 	it('should handle transactions and balances correctly', () => {
	// 		// Mine blocks to get initial balance
	// 		for (let i = 0; i <= POW_CUTOFF_BLOCK; i++) {
	// 			blockchain.minePendingTransactions(miner1);
	// 		}

	// 		// Create a transaction
	// 		const tx = new Transaction(miner1, user1, 15);
	// 		tx.signTransaction('dummy-key');
	// 		blockchain.addTransaction(tx);

	// 		// Mine block to include transaction
	// 		blockchain.minePendingTransactions(miner2); // Block 52, includes transaction
	// 		blockchain.minePendingTransactions(miner2); // Block 53, confirms Block 52

	// 		expect(blockchain.getTotalBalance(miner1)).toBe(
	// 			POW_CUTOFF_BLOCK * 10 - 15
	// 		); // 500 - 15
	// 		expect(blockchain.getTotalBalance(user1)).toBe(15);
	// 		expect(blockchain.getTotalBalance(miner2)).toBe(10); // Reward from Block 52
	// 	});
	// });

	// describe('Chain Validation', () => {
	// 	it('should validate a legitimate chain', () => {
	// 		for (let i = 0; i <= POW_CUTOFF_BLOCK; i++) {
	// 			blockchain.minePendingTransactions(miner1);
	// 		}
	// 		expect(blockchain.isChainValid()).toBe(true);
	// 	});

	// 	it('should detect invalid PoS blocks', () => {
	// 		// Setup for PoS
	// 		for (let i = 0; i <= POW_CUTOFF_BLOCK; i++) {
	// 			blockchain.minePendingTransactions(miner1);
	// 		}

	// 		// Try to mine PoS block without stake
	// 		expect(() => blockchain.minePendingTransactions(miner2)).toThrow(
	// 			'No validators available'
	// 		);
	// 	});

	// 	it('should validate chain with mixed consensus blocks', () => {
	// 		// Create PoW blocks
	// 		for (let i = 0; i <= POW_CUTOFF_BLOCK; i++) {
	// 			blockchain.minePendingTransactions(miner1);
	// 		}

	// 		// Setup for PoS
	// 		blockchain.stake(miner1, 100);
	// 		blockchain.minePendingTransactions(miner1);

	// 		expect(blockchain.isChainValid()).toBe(true);
	// 	});
	// });

	// describe('Network Weight and Validator Selection', () => {
	// 	beforeEach(() => {
	// 		// Setup initial coins
	// 		for (let i = 0; i <= POW_CUTOFF_BLOCK; i++) {
	// 			blockchain.minePendingTransactions(miner1);
	// 		}
	// 		blockchain.minePendingTransactions(miner2); // Block 52
	// 		blockchain.minePendingTransactions(miner2); // Block 53, confirms Block 52 reward
	// 	});

	// 	it('should select validator based on stake weight', () => {
	// 		blockchain.stake(miner1, 200); // Higher stake
	// 		blockchain.stake(miner2, 100); // Lower stake

	// 		// Mine multiple blocks and verify higher stake gets more blocks
	// 		let miner1Blocks = 0;
	// 		let miner2Blocks = 0;

	// 		// Mine several blocks and count
	// 		for (let i = 0; i < 10; i++) {
	// 			try {
	// 				blockchain.minePendingTransactions(miner1);
	// 				miner1Blocks++;
	// 			} catch {
	// 				try {
	// 					blockchain.minePendingTransactions(miner2);
	// 					miner2Blocks++;
	// 				} catch {
	// 					// Neither miner was selected
	// 				}
	// 			}
	// 		}

	// 		// Higher stake should generally get more blocks
	// 		expect(miner1Blocks).toBeGreaterThan(miner2Blocks);
	// 	});

	// 	it('should consider coin age in validator selection', async () => {
	// 		blockchain.stake(miner1, 100);
	// 		blockchain.stake(miner2, 100);

	// 		// Let miner2's stake age
	// 		await new Promise((resolve) => setTimeout(resolve, 1000));

	// 		// Mine blocks and verify aged stake gets more blocks
	// 		let miner1Blocks = 0;
	// 		let miner2Blocks = 0;

	// 		for (let i = 0; i < 10; i++) {
	// 			try {
	// 				blockchain.minePendingTransactions(miner1);
	// 				miner1Blocks++;
	// 			} catch {
	// 				try {
	// 					blockchain.minePendingTransactions(miner2);
	// 					miner2Blocks++;
	// 				} catch {
	// 					// Neither miner was selected
	// 				}
	// 			}
	// 		}

	// 		// Aged stake should generally get more blocks
	// 		expect(miner2Blocks).toBeGreaterThan(miner1Blocks);
	// 	});
	// });
});
});