import { jest } from '@jest/globals';
import { Block } from '../Block.js';
import { Blockchain } from '../Blockchain.js';
import { Wallet } from '../Wallet.js';
// import { Transaction } from '../Transaction';
// import { ConsensusType } from '../Block';
import { POW_CUTOFF_BLOCK, POW_BLOCK_REWARD } from '../../config.js';
import * as fs from 'fs';

// Mock the fs module
jest.mock('fs');

describe('Blockchain', () => {
	let blockchain: Blockchain;
	let minerWallet: Wallet;

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
		minerWallet = new Wallet();
	});

	afterEach(() => {
		process.env.NODE_ENV = 'development';
		jest.useRealTimers();
		mockNow.mockRestore();
	});

	// Fix the generateBlocks helper function
	const minePowBlocks = (count: number, miner: string): void => {
    for (let i = 0; i < count; i++) {
        const lastBlock = blockchain.getLatestBlock();
        const blockTime = Number(lastBlock.timestamp) + (blockchain.BLOCK_TIME * 1000) + 1;
        mockNow.mockImplementation(() => blockTime);
        const block = blockchain.minePendingTransactions(miner);
        // No need to manually update lastTimestamp; always use latest block
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
		it(`should use PoW for first ${Number(POW_CUTOFF_BLOCK)} blocks`, () => {
            const minerAddr = minerWallet.getAddress();
            // Debug log
            // eslint-disable-next-line no-console
            console.log('minerWallet.getAddress() type:', typeof minerAddr, 'value:', minerAddr);
            minePowBlocks(Number(POW_CUTOFF_BLOCK), String(minerAddr));
            const chain = blockchain.getChain();
            for (let i = 1; i <= Number(POW_CUTOFF_BLOCK); i++) {
                expect(chain[i].isProofOfWork()).toBe(true);
            }
        });

		it(`should transition to PoS after block ${Number(POW_CUTOFF_BLOCK)}`, () => {
            const minerAddr = minerWallet.getAddress();
            minePowBlocks(Number(POW_CUTOFF_BLOCK), String(minerAddr));
            blockchain.stake(minerAddr, 100);
            const lastBlock = blockchain.getLatestBlock();
            const nextBlockTime = Number(lastBlock.timestamp) + (11 * 60 * 1000);
            mockNow.mockImplementation(() => Number(nextBlockTime));
            blockchain.minePendingTransactions(minerAddr);
            const finalChain = blockchain.getChain();
            expect(finalChain[finalChain.length - 1].isProofOfStake()).toBe(true);
        });
	});

	describe('Large Chain Tests', () => {
		it('should handle transition after 100 blocks', () => {
            const minerAddr = minerWallet.getAddress();
            minePowBlocks(Number(POW_CUTOFF_BLOCK), String(minerAddr));
            blockchain.stake(minerAddr, 100);
            const lastBlock = blockchain.getLatestBlock();
            const nextBlockTime = Number(lastBlock.timestamp) + (11 * 60 * 1000);
            mockNow.mockImplementation(() => Number(nextBlockTime));
            blockchain.minePendingTransactions(minerAddr);
            expect(blockchain.getChain().length).toBe(102);
        });

		it('should handle stake weight changes over time', () => {
			const blockchain = new Blockchain();
			const minerWallet = new Wallet();
			const stakeholderWallet = new Wallet();
			// Set initial time
			const startTime = 1000000;
			mockNow.mockImplementation(() => Number(startTime));
			// Generate blocks and confirm rewards
			for (let i = 0; i < Number(POW_CUTOFF_BLOCK); i++) {
				mockNow.mockImplementation(() => Number(startTime + (i + 1) * (11 * 60 * 1000)));
				blockchain.minePendingTransactions(minerWallet.getAddress());
			}
			// Transfer coins to stakeholder
			const transferAmount = 200;
			const transaction = blockchain.createTransaction(
				minerWallet.getAddress(),
				stakeholderWallet.getAddress(),
				transferAmount,
				minerWallet
			);
			blockchain.addTransaction(transaction);
			const time1 = Number(blockchain.getLatestBlock().timestamp) + (11 * 60 * 1000);
			mockNow.mockImplementation(() => Number(time1));
			blockchain.minePendingTransactions(minerWallet.getAddress());
			const time2 = Number(time1) + (11 * 60 * 1000);
			mockNow.mockImplementation(() => Number(time2));
			blockchain.minePendingTransactions(minerWallet.getAddress());
			// Stake for stakeholderWallet before PoS mining
			const time3 = Number(time2) + (11 * 60 * 1000);
			mockNow.mockImplementation(() => Number(time3));
			blockchain.stake(stakeholderWallet.getAddress(), 100);
			const time4 = Number(time3) + (11 * 60 * 1000);
			mockNow.mockImplementation(() => Number(time4));
			blockchain.minePendingTransactions(stakeholderWallet.getAddress());
			// Mine transfer block
			const time5 = Number(blockchain.getLatestBlock().timestamp) + (11 * 60 * 1000);
			mockNow.mockImplementation(() => Number(time5));
			blockchain.minePendingTransactions(minerWallet.getAddress());
			// Mine confirmation block
			const time6 = Number(time5) + (11 * 60 * 1000);
			mockNow.mockImplementation(() => Number(time6));
			blockchain.minePendingTransactions(minerWallet.getAddress());
			// Check balances after transfer
			const stakeholderBalanceAfterTransfer = blockchain.getBalance(stakeholderWallet.getAddress());
			expect(stakeholderBalanceAfterTransfer).toBeGreaterThanOrEqual(transferAmount);
			// Stake the minimum amount
			const time7 = Number(time6) + (11 * 60 * 1000);
			mockNow.mockImplementation(() => Number(time7));
			const stakeAmount = 100;
			blockchain.stake(stakeholderWallet.getAddress(), stakeAmount);
			// Mine stake transaction and confirmation block
			const time8 = Number(time7) + (11 * 60 * 1000);
			mockNow.mockImplementation(() => Number(time8));
			blockchain.minePendingTransactions(minerWallet.getAddress());
			// Mine confirmation block for stake
			const time9 = Number(time8) + (11 * 60 * 1000);
			mockNow.mockImplementation(() => Number(time9));
			blockchain.minePendingTransactions(minerWallet.getAddress());
			// Set initial stake time
			const stake = blockchain.stakes.get(stakeholderWallet.getAddress());
			if (stake) {
				stake.timestamp = Number(time9);
				stake.lastBlockTime = Number(time9);
				blockchain.stakes.set(stakeholderWallet.getAddress(), stake);
			}
			// Get initial weight after stake is confirmed
			const initialWeight = blockchain.calculateStakeWeight(stakeholderWallet.getAddress());
			// Advance time to simulate passing of stake age
			const finalTime = Number(time9) + (24 * 60 * 60 * 1000);
			mockNow.mockImplementation(() => Number(finalTime));
			// Mine a block to update stake age
			blockchain.minePendingTransactions(minerWallet.getAddress());
			// Update stake's timestamp and lastBlockTime
			const updatedStake = blockchain.stakes.get(stakeholderWallet.getAddress());
			if (updatedStake) {
				updatedStake.lastBlockTime = Number(finalTime);
				blockchain.stakes.set(stakeholderWallet.getAddress(), updatedStake);
			}
			mockNow.mockImplementation(() => Number(finalTime));
			const laterWeight = blockchain.calculateStakeWeight(stakeholderWallet.getAddress());
			expect(Number(laterWeight)).toBeGreaterThan(Number(initialWeight));
		});

		it('should maintain valid chain with mixed consensus', () => {
            const minerAddr = minerWallet.getAddress();
            minePowBlocks(Number(POW_CUTOFF_BLOCK), String(minerAddr));
            const balance = blockchain.getTotalBalance(minerAddr);
            const stakeAmount = Math.floor(Number(balance) / 2);
            blockchain.stake(minerAddr, stakeAmount);
            let lastTimestamp = Number(blockchain.getLatestBlock().timestamp);
            for (let i = 0; i < 10; i++) {
                lastTimestamp += (11 * 60 * 1000);
                mockNow.mockImplementation(() => Number(lastTimestamp));
                blockchain.minePendingTransactions(minerAddr);
            }
            expect(blockchain.isChainValid()).toBe(true);
        });
	});
});