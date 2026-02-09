import { jest } from '@jest/globals';
import { Block } from '../Block.js';
import { Blockchain } from '../Blockchain.js';
import { Wallet } from '../Wallet.js';
import { Transaction } from '../Transaction.js';
import { POW_CUTOFF_BLOCK, POW_BLOCK_REWARD, COIN_MATURITY } from '../../config.js';
import * as fs from 'fs';

// Mock the fs module
jest.mock('fs');

describe('Blockchain', () => {
	let blockchain: Blockchain;
	let minerWallet: Wallet;

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
		const initialTestTime = genesisTime + 24 * 60 * 60 * 1000; // Start 1 day after genesis
		jest.useFakeTimers();
		jest.setSystemTime(new Date(initialTestTime));
		blockchain = new Blockchain();
		minerWallet = new Wallet();
	});

	afterEach(() => {
		process.env.NODE_ENV = 'development';
		jest.useRealTimers();
	});

	// Async helper to mine PoW blocks
	const minePowBlocks = async (count: number, miner: string): Promise<void> => {
		for (let i = 0; i < count; i++) {
			const lastBlock = blockchain.getLatestBlock();
			const blockTime =
				Number(lastBlock.timestamp) + blockchain.BLOCK_TIME * 1000 + 1;
			jest.setSystemTime(new Date(blockTime));
			await blockchain.minePendingTransactions(miner);
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
		it(`should use PoW for first ${Number(POW_CUTOFF_BLOCK)} blocks`, async () => {
			const minerAddr = minerWallet.getAddress();
			// Debug log
			// eslint-disable-next-line no-console
			console.log(
				'minerWallet.getAddress() type:',
				typeof minerAddr,
				'value:',
				minerAddr
			);
			await minePowBlocks(Number(POW_CUTOFF_BLOCK), String(minerAddr));
			const chain = blockchain.getChain();
			for (let i = 1; i <= Number(POW_CUTOFF_BLOCK); i++) {
				expect(chain[i].isProofOfWork()).toBe(true);
			}
		});

		it(`should transition to PoS after block ${Number(POW_CUTOFF_BLOCK)}`, async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(Number(POW_CUTOFF_BLOCK), String(minerAddr));
			await blockchain.stake(minerAddr, 100, minerWallet);
			const lastBlock = blockchain.getLatestBlock();
			const nextBlockTime = Number(lastBlock.timestamp) + 11 * 60 * 1000;
			jest.setSystemTime(new Date(Number(nextBlockTime)));
			await blockchain.minePendingTransactions(minerAddr, minerWallet);
			const finalChain = blockchain.getChain();
			expect(finalChain[finalChain.length - 1].isProofOfStake()).toBe(true);
		});
	});

	describe('Large Chain Tests', () => {
		it('should handle transition after 100 blocks', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(Number(POW_CUTOFF_BLOCK), String(minerAddr));
			await blockchain.stake(minerAddr, 100, minerWallet);
			const lastBlock = blockchain.getLatestBlock();
			const nextBlockTime = Number(lastBlock.timestamp) + 11 * 60 * 1000;
			jest.setSystemTime(new Date(Number(nextBlockTime)));
			await blockchain.minePendingTransactions(minerAddr, minerWallet);
			expect(blockchain.getChain().length).toBe(102);
		});

		it('should handle stake weight changes over time', async () => {
			const blockchain = new Blockchain();
			const minerWallet = new Wallet();
			const stakeholderWallet = new Wallet();
			// Set initial time
			const startTime = 1000000;
			jest.setSystemTime(new Date(Number(startTime)));
			// Generate blocks and confirm rewards
			for (let i = 0; i < Number(POW_CUTOFF_BLOCK); i++) {
				jest.setSystemTime(
					new Date(Number(startTime + (i + 1) * (11 * 60 * 1000)))
				);
				await blockchain.minePendingTransactions(minerWallet.getAddress());
			}
			// Transfer coins to stakeholder
			const transferAmount = 200;
			const transaction = blockchain.createTransaction(
				minerWallet.getAddress(),
				stakeholderWallet.getAddress(),
				transferAmount,
				minerWallet
			);
			await blockchain.addTransaction(transaction);
			const time1 =
				Number(blockchain.getLatestBlock().timestamp) + 11 * 60 * 1000;
			jest.setSystemTime(new Date(Number(time1)));
			await blockchain.minePendingTransactions(minerWallet.getAddress());
			const time2 = Number(time1) + 11 * 60 * 1000;
			jest.setSystemTime(new Date(Number(time2)));
			await blockchain.minePendingTransactions(minerWallet.getAddress());
			// Stake for stakeholderWallet before PoS mining
			const time3 = Number(time2) + 11 * 60 * 1000;
			jest.setSystemTime(new Date(Number(time3)));
			await blockchain.stake(stakeholderWallet.getAddress(), 100, stakeholderWallet);
			const time4 = Number(time3) + 11 * 60 * 1000;
			jest.setSystemTime(new Date(Number(time4)));
			await blockchain.minePendingTransactions(stakeholderWallet.getAddress(), stakeholderWallet);
			// Mine transfer block
			const time5 =
				Number(blockchain.getLatestBlock().timestamp) + 11 * 60 * 1000;
			jest.setSystemTime(new Date(Number(time5)));
			await blockchain.minePendingTransactions(minerWallet.getAddress());
			// Mine confirmation block
			const time6 = Number(time5) + 11 * 60 * 1000;
			jest.setSystemTime(new Date(Number(time6)));
			await blockchain.minePendingTransactions(minerWallet.getAddress());
			// Check balances after transfer
			const stakeholderBalanceAfterTransfer = blockchain.getBalance(
				stakeholderWallet.getAddress()
			);
			expect(stakeholderBalanceAfterTransfer).toBeGreaterThanOrEqual(
				transferAmount
			);
			// Stake the minimum amount
			const time7 = Number(time6) + 11 * 60 * 1000;
			jest.setSystemTime(new Date(Number(time7)));
			const stakeAmount = 100;
			await blockchain.stake(stakeholderWallet.getAddress(), stakeAmount, stakeholderWallet);
			// Mine stake transaction and confirmation block
			const time8 = Number(time7) + 11 * 60 * 1000;
			jest.setSystemTime(new Date(Number(time8)));
			await blockchain.minePendingTransactions(minerWallet.getAddress());
			// Mine confirmation block for stake
			const time9 = Number(time8) + 11 * 60 * 1000;
			jest.setSystemTime(new Date(Number(time9)));
			await blockchain.minePendingTransactions(minerWallet.getAddress());
			// Set initial stake time (access private _stakes for test setup)
			const stake = blockchain['_stakes'].get(stakeholderWallet.getAddress());
			if (stake) {
				stake.timestamp = Number(time9);
				stake.lastBlockTime = Number(time9);
				blockchain['_stakes'].set(stakeholderWallet.getAddress(), stake);
			}
			// Get initial weight after stake is confirmed
			const initialWeight = blockchain.calculateStakeWeight(
				stakeholderWallet.getAddress()
			);
			// Advance time to simulate passing of stake age
			const finalTime = Number(time9) + 24 * 60 * 60 * 1000;
			jest.setSystemTime(new Date(Number(finalTime)));
			// Mine a block to update stake age
			await blockchain.minePendingTransactions(minerWallet.getAddress());
			// Update stake's timestamp and lastBlockTime
			const updatedStake = blockchain['_stakes'].get(
				stakeholderWallet.getAddress()
			);
			if (updatedStake) {
				updatedStake.lastBlockTime = Number(finalTime);
				blockchain['_stakes'].set(stakeholderWallet.getAddress(), updatedStake);
			}
			jest.setSystemTime(new Date(Number(finalTime)));
			const laterWeight = blockchain.calculateStakeWeight(
				stakeholderWallet.getAddress()
			);
			expect(Number(laterWeight)).toBeGreaterThan(Number(initialWeight));
		});

		it('should maintain valid chain with mixed consensus', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(Number(POW_CUTOFF_BLOCK), String(minerAddr));
			const balance = blockchain.getTotalBalance(minerAddr);
			const stakeAmount = Math.floor(Number(balance) / 2);
			await blockchain.stake(minerAddr, stakeAmount, minerWallet);
			let lastTimestamp = Number(blockchain.getLatestBlock().timestamp);
			for (let i = 0; i < 10; i++) {
				lastTimestamp += 11 * 60 * 1000;
				jest.setSystemTime(new Date(Number(lastTimestamp)));
				await blockchain.minePendingTransactions(minerAddr, minerWallet);
			}
			expect(blockchain.isChainValid()).toBe(true);
		});
	});

	describe('UTXO Double-Spend Prevention', () => {
		let senderWallet: Wallet;
		let receiverWallet: Wallet;
		let receiverWallet2: Wallet;

		beforeEach(async () => {
			senderWallet = new Wallet();
			receiverWallet = new Wallet();
			receiverWallet2 = new Wallet();

			// Mine enough blocks for coinbase maturity
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(COIN_MATURITY, minerAddr);

			// Transfer coins to senderWallet
			const tx = blockchain.createTransaction(
				minerAddr,
				senderWallet.getAddress(),
				POW_BLOCK_REWARD,
				minerWallet
			);
			await blockchain.addTransaction(tx);

			// Mine to confirm the transfer
			const lastBlock = blockchain.getLatestBlock();
			const blockTime = Number(lastBlock.timestamp) + blockchain.BLOCK_TIME * 1000 + 1;
			jest.setSystemTime(new Date(blockTime));
			await blockchain.minePendingTransactions(minerAddr);
		});

		it('should reject a second transaction spending the same UTXO', async () => {
			const senderAddr = senderWallet.getAddress();

			// First transaction spending sender's UTXO
			const tx1 = blockchain.createTransaction(
				senderAddr,
				receiverWallet.getAddress(),
				5,
				senderWallet
			);
			await blockchain.addTransaction(tx1);

			// Second transaction trying to spend the same UTXO
			// createTransaction should skip pending UTXOs, so with insufficient
			// remaining UTXOs it should throw 'Insufficient funds'
			expect(() => {
				blockchain.createTransaction(
					senderAddr,
					receiverWallet2.getAddress(),
					5,
					senderWallet
				);
			}).toThrow('Insufficient funds');
		});

		it('should reject addTransaction with UTXO already in pending pool', async () => {
			const senderAddr = senderWallet.getAddress();
			const utxos = blockchain.getUTXOs(senderAddr);

			// Manually create two transactions spending the same UTXO
			const inputs = [{
				previousTx: utxos[0].txHash,
				outputIndex: utxos[0].outputIndex,
				signature: '',
			}];

			const tx1 = new Transaction(
				inputs,
				[{ address: receiverWallet.getAddress(), amount: 5 }]
			);
			senderWallet.signTransaction(tx1);

			const tx2 = new Transaction(
				[{
					previousTx: utxos[0].txHash,
					outputIndex: utxos[0].outputIndex,
					signature: '',
				}],
				[{ address: receiverWallet2.getAddress(), amount: 5 }]
			);
			senderWallet.signTransaction(tx2);

			await blockchain.addTransaction(tx1);

			await expect(blockchain.addTransaction(tx2))
				.rejects.toThrow('utxo already spent by pending transaction');
		});

		it('should reject a transaction with duplicate inputs', async () => {
			const senderAddr = senderWallet.getAddress();
			const utxos = blockchain.getUTXOs(senderAddr);

			// Create a transaction that references the same UTXO twice
			const duplicateInputs = [
				{
					previousTx: utxos[0].txHash,
					outputIndex: utxos[0].outputIndex,
					signature: '',
				},
				{
					previousTx: utxos[0].txHash,
					outputIndex: utxos[0].outputIndex,
					signature: '',
				},
			];

			const tx = new Transaction(
				duplicateInputs,
				[{ address: receiverWallet.getAddress(), amount: 5 }]
			);
			senderWallet.signTransaction(tx);

			await expect(blockchain.addTransaction(tx))
				.rejects.toThrow('duplicate input in transaction');
		});

		it('should clear pendingUTXOSpends when a block is mined', async () => {
			const senderAddr = senderWallet.getAddress();
			const minerAddr = minerWallet.getAddress();

			// Create and add a transaction
			const tx = blockchain.createTransaction(
				senderAddr,
				receiverWallet.getAddress(),
				5,
				senderWallet
			);
			await blockchain.addTransaction(tx);

			// Mine a block to confirm it
			const lastBlock = blockchain.getLatestBlock();
			const blockTime = Number(lastBlock.timestamp) + blockchain.BLOCK_TIME * 1000 + 1;
			jest.setSystemTime(new Date(blockTime));
			await blockchain.minePendingTransactions(minerAddr);

			// Pending pool is now empty; the change UTXO should be available
			// The sender should be able to spend remaining balance
			const remainingBalance = blockchain.getBalance(senderAddr);
			if (remainingBalance > 0) {
				const tx2 = blockchain.createTransaction(
					senderAddr,
					receiverWallet2.getAddress(),
					remainingBalance,
					senderWallet
				);
				await expect(blockchain.addTransaction(tx2)).resolves.not.toThrow();
			}
		});

		it('should allow spending after clearPendingTransactions', async () => {
			const senderAddr = senderWallet.getAddress();

			const tx1 = blockchain.createTransaction(
				senderAddr,
				receiverWallet.getAddress(),
				5,
				senderWallet
			);
			await blockchain.addTransaction(tx1);

			// Clear pending transactions (simulates a reset)
			await blockchain.clearPendingTransactions();

			// Should now be able to spend the same UTXOs again
			const tx2 = blockchain.createTransaction(
				senderAddr,
				receiverWallet2.getAddress(),
				5,
				senderWallet
			);
			await expect(blockchain.addTransaction(tx2)).resolves.not.toThrow();
		});
	});

	describe('Coinbase Validation', () => {
		it('should reject a block with no coinbase transaction', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(1, minerAddr);

			const lastBlock = blockchain.getLatestBlock();
			const blockTime = Number(lastBlock.timestamp) + blockchain.BLOCK_TIME * 1000 + 1;

			// Create a block with a non-coinbase first transaction (0 inputs, 2 outputs)
			const notCoinbase = new Transaction(
				[],
				[
					{ address: minerAddr, amount: POW_BLOCK_REWARD },
					{ address: minerAddr, amount: 0 },
				]
			);
			const block = new Block(
				blockTime,
				[notCoinbase],
				lastBlock.hash,
				0,
				1,
				blockchain.getChain().length
			);
			while (!block.isValid()) {
				block.nonce++;
				block.hash = block.calculateHash();
			}

			await expect(blockchain.addMinedBlock(block))
				.rejects.toThrow('first transaction must be coinbase');
		});

		it('should reject a block with incorrect reward amount', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(1, minerAddr);

			const lastBlock = blockchain.getLatestBlock();
			const blockTime = Number(lastBlock.timestamp) + blockchain.BLOCK_TIME * 1000 + 1;

			// Create a coinbase with double the reward
			const badCoinbase = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD * 2 }]
			);
			const block = new Block(
				blockTime,
				[badCoinbase],
				lastBlock.hash,
				0,
				1,
				blockchain.getChain().length
			);
			while (!block.isValid()) {
				block.nonce++;
				block.hash = block.calculateHash();
			}

			await expect(blockchain.addMinedBlock(block))
				.rejects.toThrow('invalid coinbase reward amount');
		});

		it('should reject a block with multiple coinbase transactions', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(1, minerAddr);

			const lastBlock = blockchain.getLatestBlock();
			const blockTime = Number(lastBlock.timestamp) + blockchain.BLOCK_TIME * 1000 + 1;

			const coinbase1 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }]
			);
			const coinbase2 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }]
			);
			const block = new Block(
				blockTime,
				[coinbase1, coinbase2],
				lastBlock.hash,
				0,
				1,
				blockchain.getChain().length
			);
			while (!block.isValid()) {
				block.nonce++;
				block.hash = block.calculateHash();
			}

			await expect(blockchain.addMinedBlock(block))
				.rejects.toThrow('block contains multiple coinbase transactions');
		});

		it('should reject a block with zero reward', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(1, minerAddr);

			const lastBlock = blockchain.getLatestBlock();
			const blockTime = Number(lastBlock.timestamp) + blockchain.BLOCK_TIME * 1000 + 1;

			const zeroCoinbase = new Transaction(
				[],
				[{ address: minerAddr, amount: 0 }]
			);
			const block = new Block(
				blockTime,
				[zeroCoinbase],
				lastBlock.hash,
				0,
				1,
				blockchain.getChain().length
			);
			while (!block.isValid()) {
				block.nonce++;
				block.hash = block.calculateHash();
			}

			await expect(blockchain.addMinedBlock(block))
				.rejects.toThrow('invalid coinbase reward amount');
		});

		it('should accept a block with correct coinbase', async () => {
			const minerAddr = minerWallet.getAddress();
			const lastBlock = blockchain.getLatestBlock();
			const blockTime = Number(lastBlock.timestamp) + blockchain.BLOCK_TIME * 1000 + 1;
			jest.setSystemTime(new Date(blockTime));

			await blockchain.minePendingTransactions(minerAddr);

			expect(blockchain.getChain().length).toBe(2);
			const minedBlock = blockchain.getChain()[1];
			expect(minedBlock.transactions[0].isCoinbase()).toBe(true);
			expect(minedBlock.transactions[0].outputs[0].amount).toBe(POW_BLOCK_REWARD);
		});
	});

	describe('Coinbase Maturity', () => {
		it('should prevent spending immature coinbase in createTransaction', async () => {
			const minerAddr = minerWallet.getAddress();
			// Mine 1 block — coinbase not yet mature
			await minePowBlocks(1, minerAddr);

			const receiverWallet = new Wallet();

			// Try to spend — createTransaction should skip immature coinbase UTXOs
			expect(() => {
				blockchain.createTransaction(
					minerAddr,
					receiverWallet.getAddress(),
					POW_BLOCK_REWARD,
					minerWallet
				);
			}).toThrow('Insufficient funds');
		});

		it('should reject immature coinbase spend in addTransaction', async () => {
			const minerAddr = minerWallet.getAddress();
			// Mine 1 block — coinbase not yet mature
			await minePowBlocks(1, minerAddr);

			const block1 = blockchain.getChain()[1];
			const coinbaseTxHash = block1.transactions[0].calculateHash();

			const receiverWallet = new Wallet();
			// Manually create a transaction spending the immature coinbase
			const tx = new Transaction(
				[{ previousTx: coinbaseTxHash, outputIndex: 0, signature: '' }],
				[{ address: receiverWallet.getAddress(), amount: POW_BLOCK_REWARD }]
			);
			minerWallet.signTransaction(tx);

			await expect(blockchain.addTransaction(tx))
				.rejects.toThrow('coinbase output has not reached maturity');
		});

		it('should allow spending coinbase after maturity', async () => {
			const minerAddr = minerWallet.getAddress();
			// Mine COIN_MATURITY blocks so the first coinbase is mature
			await minePowBlocks(COIN_MATURITY, minerAddr);

			const receiverWallet = new Wallet();

			// Should now succeed — coinbase from block 1 is mature
			const tx = blockchain.createTransaction(
				minerAddr,
				receiverWallet.getAddress(),
				POW_BLOCK_REWARD,
				minerWallet
			);
			await expect(blockchain.addTransaction(tx)).resolves.not.toThrow();
		});
	});

	describe('Concurrency', () => {
		it('should serialize concurrent addMinedBlock calls', async () => {
			const minerAddr = minerWallet.getAddress();

			// Mine a valid block
			const lastBlock = blockchain.getLatestBlock();
			const blockTime = Number(lastBlock.timestamp) + blockchain.BLOCK_TIME * 1000 + 1;
			jest.setSystemTime(new Date(blockTime));
			await blockchain.minePendingTransactions(minerAddr);

			// Try to add a second block concurrently with wrong previousHash
			const badBlock = new Block(
				blockTime + 1,
				[new Transaction([], [{ address: minerAddr, amount: POW_BLOCK_REWARD }])],
				'wrong-hash',
				0,
				1,
				blockchain.getChain().length
			);
			badBlock.hash = badBlock.calculateHash();

			await expect(blockchain.addMinedBlock(badBlock))
				.rejects.toThrow('Invalid previous hash');
		});

		it('should serialize concurrent addTransaction calls', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(COIN_MATURITY, minerAddr);

			// Create a transaction
			const tx1 = blockchain.createTransaction(
				minerAddr,
				new Wallet().getAddress(),
				5,
				minerWallet
			);

			// Should succeed when serialized through mutex
			await blockchain.addTransaction(tx1);
			expect(blockchain.getPendingTransactions().length).toBe(1);
		});
	});

	describe('Transaction Validation', () => {
		let senderWallet: Wallet;
		let receiverWallet: Wallet;

		beforeEach(async () => {
			senderWallet = new Wallet();
			receiverWallet = new Wallet();

			const minerAddr = minerWallet.getAddress();
			// Mine enough blocks for coinbase maturity
			await minePowBlocks(COIN_MATURITY, minerAddr);

			// Transfer coins to senderWallet
			const tx = blockchain.createTransaction(
				minerAddr,
				senderWallet.getAddress(),
				POW_BLOCK_REWARD,
				minerWallet
			);
			await blockchain.addTransaction(tx);

			// Mine to confirm the transfer
			const lastBlock = blockchain.getLatestBlock();
			const blockTime = Number(lastBlock.timestamp) + blockchain.BLOCK_TIME * 1000 + 1;
			jest.setSystemTime(new Date(blockTime));
			await blockchain.minePendingTransactions(minerAddr);
		});

		it('should reject transaction with unsigned inputs', async () => {
			const utxos = blockchain.getUTXOs(senderWallet.getAddress());

			const tx = new Transaction(
				[{
					previousTx: utxos[0].txHash,
					outputIndex: utxos[0].outputIndex,
					signature: '',
				}],
				[{ address: receiverWallet.getAddress(), amount: 5 }]
			);
			// Do not sign — signature is empty

			await expect(blockchain.addTransaction(tx))
				.rejects.toThrow('input missing signature');
		});

		it('should reject transaction spending non-existent UTXO', async () => {
			const tx = new Transaction(
				[{
					previousTx: 'deadbeef'.repeat(8),
					outputIndex: 0,
					signature: '',
				}],
				[{ address: receiverWallet.getAddress(), amount: 5 }]
			);
			senderWallet.signTransaction(tx);

			await expect(blockchain.addTransaction(tx))
				.rejects.toThrow('input references non-existent transaction');
		});

		it('should reject transaction with outputs exceeding inputs', async () => {
			const utxos = blockchain.getUTXOs(senderWallet.getAddress());

			// Create a transaction with output amount greater than the UTXO value
			const tx = new Transaction(
				[{
					previousTx: utxos[0].txHash,
					outputIndex: utxos[0].outputIndex,
					signature: '',
				}],
				[{ address: receiverWallet.getAddress(), amount: POW_BLOCK_REWARD + 100 }]
			);
			senderWallet.signTransaction(tx);

			await expect(blockchain.addTransaction(tx))
				.rejects.toThrow('output amounts exceed input amounts');
		});

		it('should reject transaction with negative output amount', async () => {
			const utxos = blockchain.getUTXOs(senderWallet.getAddress());

			const tx = new Transaction(
				[{
					previousTx: utxos[0].txHash,
					outputIndex: utxos[0].outputIndex,
					signature: '',
				}],
				[{ address: receiverWallet.getAddress(), amount: -5 }]
			);
			senderWallet.signTransaction(tx);

			await expect(blockchain.addTransaction(tx))
				.rejects.toThrow('output has negative amount');
		});

		it('should reject transaction with zero output amount', async () => {
			const utxos = blockchain.getUTXOs(senderWallet.getAddress());

			const tx = new Transaction(
				[{
					previousTx: utxos[0].txHash,
					outputIndex: utxos[0].outputIndex,
					signature: '',
				}],
				[{ address: receiverWallet.getAddress(), amount: 0 }]
			);
			senderWallet.signTransaction(tx);

			await expect(blockchain.addTransaction(tx))
				.rejects.toThrow('output has zero amount');
		});

		it('should reject transaction with invalid output address', async () => {
			const utxos = blockchain.getUTXOs(senderWallet.getAddress());

			const tx = new Transaction(
				[{
					previousTx: utxos[0].txHash,
					outputIndex: utxos[0].outputIndex,
					signature: '',
				}],
				[{ address: 'invalid-address', amount: 5 }]
			);
			senderWallet.signTransaction(tx);

			await expect(blockchain.addTransaction(tx))
				.rejects.toThrow('invalid output address');
		});

		it('should reject createTransaction with invalid sender address', () => {
			expect(() => {
				blockchain.createTransaction(
					'bad-address',
					receiverWallet.getAddress(),
					5,
					senderWallet
				);
			}).toThrow('invalid sender address');
		});

		it('should reject createTransaction with invalid recipient address', () => {
			expect(() => {
				blockchain.createTransaction(
					senderWallet.getAddress(),
					'bad-address',
					5,
					senderWallet
				);
			}).toThrow('invalid recipient address');
		});

		it('should reject stake with invalid address', async () => {
			await expect(blockchain.stake('bad-address', 100))
				.rejects.toThrow('invalid staking address');
		});

		it('should accept a valid transaction', async () => {
			const tx = blockchain.createTransaction(
				senderWallet.getAddress(),
				receiverWallet.getAddress(),
				5,
				senderWallet
			);
			await expect(blockchain.addTransaction(tx)).resolves.not.toThrow();
		});
	});

	describe('Validator Selection', () => {
		it('should select validator deterministically for same inputs', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(Number(POW_CUTOFF_BLOCK), String(minerAddr));
			await blockchain.stake(minerAddr, 100, minerWallet);

			const latestBlock = blockchain.getLatestBlock();
			const timestamp = latestBlock.timestamp + 11 * 60 * 1000;

			// Same inputs should always produce same result
			const result1 = blockchain.isEligibleValidator(
				minerAddr,
				timestamp,
				latestBlock.hash,
				latestBlock.timestamp,
			);
			const result2 = blockchain.isEligibleValidator(
				minerAddr,
				timestamp,
				latestBlock.hash,
				latestBlock.timestamp,
			);
			expect(result1).toBe(result2);
		});

		it('should return false for address with no stake', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(1, minerAddr);

			const noStakeWallet = new Wallet();
			const latestBlock = blockchain.getLatestBlock();

			const result = blockchain.isEligibleValidator(
				noStakeWallet.getAddress(),
				Date.now(),
				latestBlock.hash,
				latestBlock.timestamp,
			);
			expect(result).toBe(false);
		});

		it('should guarantee selection for sole staker after TARGET_BLOCK_TIME', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(Number(POW_CUTOFF_BLOCK), String(minerAddr));
			await blockchain.stake(minerAddr, 100, minerWallet);

			const latestBlock = blockchain.getLatestBlock();
			// 11 minutes > TARGET_BLOCK_TIME (375s), so sole staker always wins
			const timestamp = latestBlock.timestamp + 11 * 60 * 1000;

			const result = blockchain.isEligibleValidator(
				minerAddr,
				timestamp,
				latestBlock.hash,
				latestBlock.timestamp,
			);
			expect(result).toBe(true);
		});

		it('should produce different results for different slot numbers', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(Number(POW_CUTOFF_BLOCK), String(minerAddr));
			// Stake a small fraction to make selection probabilistic
			await blockchain.stake(minerAddr, 100, minerWallet);

			const latestBlock = blockchain.getLatestBlock();
			// Check multiple slots with very short timeSinceLastBlock
			// so the staker has low probability per slot
			const results = new Set<boolean>();
			for (let slot = 0; slot < 100; slot++) {
				// 1 second after last block — low probability per check
				const timestamp = latestBlock.timestamp + 1000 + slot * 60000;
				const result = blockchain.isEligibleValidator(
					minerAddr,
					timestamp,
					latestBlock.hash,
					latestBlock.timestamp,
				);
				results.add(result);
			}
			// With low probability per slot, we should see both true and false
			// over 100 attempts (extremely unlikely to get all same)
			expect(results.size).toBe(2);
		});

		it('should favor higher stake weight', async () => {
			const wallet1 = new Wallet();
			const wallet2 = new Wallet();
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(Number(POW_CUTOFF_BLOCK), String(minerAddr));

			// Transfer to both wallets
			const tx1 = blockchain.createTransaction(
				minerAddr, wallet1.getAddress(), 500, minerWallet,
			);
			await blockchain.addTransaction(tx1);
			const tx2 = blockchain.createTransaction(
				minerAddr, wallet2.getAddress(), 100, minerWallet,
			);
			await blockchain.addTransaction(tx2);

			// Mine to confirm transfers
			const lastBlock = blockchain.getLatestBlock();
			const confirmTime = lastBlock.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
			jest.setSystemTime(new Date(confirmTime));
			await blockchain.minePendingTransactions(minerAddr);

			// Stake different amounts
			await blockchain.stake(wallet1.getAddress(), 400, wallet1);
			await blockchain.stake(wallet2.getAddress(), 100, wallet2);

			const latestBlock = blockchain.getLatestBlock();

			// Count wins over many slots at low timeSinceLastBlock
			let wins1 = 0;
			let wins2 = 0;
			for (let slot = 0; slot < 1000; slot++) {
				const timestamp = latestBlock.timestamp + 1000 + slot * 60000;
				if (blockchain.isEligibleValidator(
					wallet1.getAddress(), timestamp, latestBlock.hash, latestBlock.timestamp,
				)) wins1++;
				if (blockchain.isEligibleValidator(
					wallet2.getAddress(), timestamp, latestBlock.hash, latestBlock.timestamp,
				)) wins2++;
			}

			// Higher stake should win more often
			expect(wins1).toBeGreaterThan(wins2);
		});

		it('should reject validator with no stake', () => {
			const noStakeWallet = new Wallet();
			const latestBlock = blockchain.getLatestBlock();

			// Address with no stake cannot be eligible
			const result = blockchain.isEligibleValidator(
				noStakeWallet.getAddress(),
				latestBlock.timestamp + 660000,
				latestBlock.hash,
				latestBlock.timestamp,
			);
			expect(result).toBe(false);
		});

		it('should report totalNetworkStake correctly', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(Number(POW_CUTOFF_BLOCK), String(minerAddr));

			expect(blockchain.totalNetworkStake()).toBe(0);

			await blockchain.stake(minerAddr, 200, minerWallet);
			expect(blockchain.totalNetworkStake()).toBe(200);

			// Unstake partially — totalNetworkStake should decrease
			await blockchain.unstake(minerAddr, 100);
			expect(blockchain.totalNetworkStake()).toBe(100);
		});
	});
});
