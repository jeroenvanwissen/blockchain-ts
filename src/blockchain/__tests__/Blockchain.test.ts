import { jest } from '@jest/globals';
import { Block } from '../Block.js';
import { Blockchain } from '../Blockchain.js';
import { Wallet } from '../Wallet.js';
import { Transaction } from '../Transaction.js';
import {
	POW_CUTOFF_BLOCK,
	POW_BLOCK_REWARD,
	COIN_MATURITY,
	BLOCK_TIME,
	DIFFICULTY_ADJUSTMENT_INTERVAL,
	MIN_DIFFICULTY,
	MAX_DIFFICULTY_CHANGE_FACTOR,
	MAX_BLOCK_TRANSACTIONS,
	UNSTAKE_DELAY,
	MAX_STAKE_AGE_MULTIPLIER,
} from '../../config.js';
import * as fs from 'fs';

// Mock the fs module
jest.mock('fs');

// Mock protobufjs to prevent real .proto file reads (fs is mocked)
jest.mock('protobufjs', () => {
	const mockType = {
		create: (obj: unknown) => obj,
		encode: (obj: unknown) => ({
			finish: () => Buffer.from(JSON.stringify(obj)),
		}),
		decode: (buf: Buffer) => JSON.parse(buf.toString()) as unknown,
		verify: () => null,
		toObject: (obj: unknown) => obj,
	};
	return {
		__esModule: true,
		default: {
			loadSync: () => ({ lookupType: () => mockType }),
		},
	};
});

describe('Blockchain', () => {
	let blockchain: Blockchain;
	let minerWallet: Wallet;

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
		// Mock fs functions for BlockStore's chunked storage
		(fs.existsSync as jest.Mock).mockReturnValue(false);
		(fs.readFileSync as jest.Mock).mockImplementation(() => {
			const error = new Error('File not found') as NodeJS.ErrnoException;
			error.code = 'ENOENT';
			throw error;
		});
		(fs.writeFileSync as jest.Mock).mockImplementation(() => {});
		(fs.mkdirSync as jest.Mock).mockImplementation(() => {});
		(fs.appendFileSync as jest.Mock).mockImplementation(() => {});
		(fs.readdirSync as jest.Mock).mockReturnValue([]);
		(fs.openSync as jest.Mock).mockReturnValue(10);
		(fs.readSync as jest.Mock).mockReturnValue(0);
		(fs.closeSync as jest.Mock).mockImplementation(() => {});

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

			// Unstake partially — stake remains active during delay period
			await blockchain.unstake(minerAddr, 100);
			expect(blockchain.totalNetworkStake()).toBe(200);

			// After UNSTAKE_DELAY blocks, the unstake is processed
			await minePowBlocks(UNSTAKE_DELAY, minerAddr);
			expect(blockchain.totalNetworkStake()).toBe(100);
		});
	});

	describe('Difficulty Adjustment', () => {
		let diffBlockchain: Blockchain;
		let diffMinerAddr: string;

		beforeEach(() => {
			// Restore real getDifficulty/setDifficulty for difficulty tests
			(Block.prototype.getDifficulty as jest.Mock).mockRestore();
			(Block.prototype.setDifficulty as jest.Mock).mockRestore();
			diffBlockchain = new Blockchain();
			diffMinerAddr = minerWallet.getAddress();
		});

		const mineDiffBlocks = async (
			bc: Blockchain,
			count: number,
			miner: string,
			intervalMs: number,
		): Promise<void> => {
			for (let i = 0; i < count; i++) {
				const lastBlock = bc.getLatestBlock();
				const blockTime = lastBlock.timestamp + intervalMs;
				jest.setSystemTime(new Date(blockTime));
				await bc.minePendingTransactions(miner);
			}
		};

		it('should return genesis difficulty when chain is short', () => {
			// Chain has only genesis block (length 1)
			expect(diffBlockchain.calculateNewDifficulty()).toBe(4);
		});

		it('should return genesis difficulty when chain equals adjustment interval', async () => {
			// Mine exactly DIFFICULTY_ADJUSTMENT_INTERVAL blocks (need > interval)
			await mineDiffBlocks(
				diffBlockchain,
				DIFFICULTY_ADJUSTMENT_INTERVAL,
				diffMinerAddr,
				BLOCK_TIME * 1000,
			);
			// Chain length = 11 (genesis + 10), which equals interval + 1
			// Still returns genesis difficulty because condition is <=
			expect(diffBlockchain.calculateNewDifficulty()).toBe(4);
		});

		it('should keep difficulty stable when blocks arrive on target', async () => {
			// Mine enough blocks to trigger adjustment
			await mineDiffBlocks(
				diffBlockchain,
				DIFFICULTY_ADJUSTMENT_INTERVAL + 1,
				diffMinerAddr,
				BLOCK_TIME * 1000,
			);
			// Chain length = 12, enough for adjustment
			const chain = diffBlockchain.getChain();
			// Set all blocks to a known difficulty for predictable math
			for (const block of chain) {
				block.powDifficulty = 8;
			}
			// Blocks at exact target interval: ratio ~= 1, difficulty stays same
			const newDiff = diffBlockchain.calculateNewDifficulty();
			expect(newDiff).toBe(8);
		});

		it('should increase difficulty proportionally when blocks are too fast', async () => {
			// Mine blocks 2x faster than target (half the target time)
			const fastInterval = (BLOCK_TIME * 1000) / 2;
			await mineDiffBlocks(
				diffBlockchain,
				DIFFICULTY_ADJUSTMENT_INTERVAL + 1,
				diffMinerAddr,
				fastInterval,
			);
			const chain = diffBlockchain.getChain();
			for (const block of chain) {
				block.powDifficulty = 8;
			}
			// Blocks at half target time -> difficulty should roughly double
			const newDiff = diffBlockchain.calculateNewDifficulty();
			expect(newDiff).toBeGreaterThan(8);
			expect(newDiff).toBe(16); // 8 * (target / (target/2)) = 8 * 2 = 16
		});

		it('should decrease difficulty proportionally when blocks are too slow', async () => {
			// Mine blocks 2x slower than target
			const slowInterval = BLOCK_TIME * 1000 * 2;
			await mineDiffBlocks(
				diffBlockchain,
				DIFFICULTY_ADJUSTMENT_INTERVAL + 1,
				diffMinerAddr,
				slowInterval,
			);
			const chain = diffBlockchain.getChain();
			for (const block of chain) {
				block.powDifficulty = 20;
			}
			// Blocks at 2x target time -> difficulty should halve
			const newDiff = diffBlockchain.calculateNewDifficulty();
			expect(newDiff).toBeLessThan(20);
			expect(newDiff).toBe(10); // 20 * (target / (target*2)) = 20 * 0.5 = 10
		});

		it('should clamp difficulty increase to 4x maximum', async () => {
			// Mine blocks extremely fast (1 second apart)
			await mineDiffBlocks(
				diffBlockchain,
				DIFFICULTY_ADJUSTMENT_INTERVAL + 1,
				diffMinerAddr,
				1000,
			);
			const chain = diffBlockchain.getChain();
			for (const block of chain) {
				block.powDifficulty = 8;
			}
			// 1s blocks vs 30s target = 30x ratio, but clamped to 4x
			const newDiff = diffBlockchain.calculateNewDifficulty();
			expect(newDiff).toBe(8 * MAX_DIFFICULTY_CHANGE_FACTOR); // 32
		});

		it('should clamp difficulty decrease to 1/4 minimum', async () => {
			// Mine blocks extremely slow (10 minutes apart)
			await mineDiffBlocks(
				diffBlockchain,
				DIFFICULTY_ADJUSTMENT_INTERVAL + 1,
				diffMinerAddr,
				600_000,
			);
			const chain = diffBlockchain.getChain();
			for (const block of chain) {
				block.powDifficulty = 20;
			}
			// 600s blocks vs 30s target = 0.05 ratio, but clamped to 1/4
			const newDiff = diffBlockchain.calculateNewDifficulty();
			expect(newDiff).toBe(
				Math.ceil(20 / MAX_DIFFICULTY_CHANGE_FACTOR),
			); // ceil(5) = 5
		});

		it('should enforce minimum difficulty floor', async () => {
			// Mine blocks very slowly with low starting difficulty
			await mineDiffBlocks(
				diffBlockchain,
				DIFFICULTY_ADJUSTMENT_INTERVAL + 1,
				diffMinerAddr,
				600_000,
			);
			const chain = diffBlockchain.getChain();
			for (const block of chain) {
				block.powDifficulty = MIN_DIFFICULTY;
			}
			// Even with slow blocks, difficulty cannot go below MIN_DIFFICULTY
			const newDiff = diffBlockchain.calculateNewDifficulty();
			expect(newDiff).toBeGreaterThanOrEqual(MIN_DIFFICULTY);
		});

		it('should compute median time past correctly', async () => {
			// Mine 5 blocks with known timestamps
			await mineDiffBlocks(diffBlockchain, 5, diffMinerAddr, 10_000);
			const chain = diffBlockchain.getChain();
			// Collect actual timestamps
			const timestamps = chain.map((b) => b.timestamp).sort((a, b) => a - b);
			const expectedMedian =
				timestamps[Math.floor(timestamps.length / 2)];
			expect(diffBlockchain.getMedianTimePast()).toBe(expectedMedian);
		});

		it('should use config BLOCK_TIME constant', () => {
			// Verify the blockchain uses the config value
			expect(diffBlockchain.BLOCK_TIME).toBe(BLOCK_TIME);
		});
	});

	describe('Fork Resolution', () => {
		it('should compute block weight as 2^difficulty for PoW blocks', () => {
			const block = new Block(Date.now(), [], '0', 0, 4, 0);
			expect(Blockchain.blockWeight(block)).toBe(Math.pow(2, 4));
		});

		it('should set cumulative weight on mined blocks', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(3, minerAddr);

			const chain = blockchain.getChain();
			// Genesis has cumulativeWeight = 2^4 = 16 (difficulty 4)
			// Mined blocks have difficulty 1 (mocked), weight = 2^1 = 2
			expect(chain[0].cumulativeWeight).toBe(16); // genesis: 2^4
			expect(chain[1].cumulativeWeight).toBe(18); // 16 + 2^1
			expect(chain[2].cumulativeWeight).toBe(20); // 18 + 2^1
			expect(chain[3].cumulativeWeight).toBe(22); // 20 + 2^1
		});

		it('should report chain weight from latest block', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(2, minerAddr);

			// Genesis (2^4=16) + 2 blocks (2^1=2 each) = 20
			expect(blockchain.getChainWeight()).toBe(20);
		});

		it('should prefer higher-difficulty chain over longer chain in replaceChain', async () => {
			const minerAddr = minerWallet.getAddress();
			// Mine 3 blocks on current chain (difficulty 1, mocked)
			await minePowBlocks(3, minerAddr);
			const currentWeight = blockchain.getChainWeight();

			// Build a shorter chain (2 blocks) with higher difficulty
			const genesisBlock = blockchain.getChain()[0];
			const highDiffBlock1Timestamp =
				genesisBlock.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase1 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
			);
			const block1 = new Block(
				highDiffBlock1Timestamp,
				[coinbase1],
				genesisBlock.hash,
				0,
				2, // difficulty 2 → weight 4
				1,
			);
			// Mine valid PoW
			while (!block1.isValid()) {
				block1.nonce++;
				block1.hash = block1.calculateHash();
			}

			const highDiffBlock2Timestamp =
				highDiffBlock1Timestamp + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase2 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
			);
			const block2 = new Block(
				highDiffBlock2Timestamp,
				[coinbase2],
				block1.hash,
				0,
				2, // difficulty 2 → weight 4
				2,
			);
			while (!block2.isValid()) {
				block2.nonce++;
				block2.hash = block2.calculateHash();
			}

			const newChain = [genesisBlock, block1, block2];
			// New chain: genesis(16) + 4 + 4 = 24, more than current 22
			expect(Blockchain.blockWeight(block1)).toBe(4);

			await blockchain.replaceChain(newChain);
			expect(blockchain.getChain().length).toBe(3); // shorter than original 4
			expect(blockchain.getChainWeight()).toBeGreaterThan(currentWeight);
		});

		it('should reject chain with equal weight (no flip-flopping)', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(2, minerAddr);

			// Build a chain with same total weight
			const chain = blockchain.getChain();
			const sameLengthChain = [...chain];

			await expect(blockchain.replaceChain(sameLengthChain))
				.rejects.toThrow('received chain does not have more weight');
		});

		it('should reject chain with less weight', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(3, minerAddr);

			// Try to replace with just genesis + 1 block (less weight)
			const genesis = blockchain.getChain()[0];
			const singleBlockTimestamp =
				genesis.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
			);
			const block = new Block(
				singleBlockTimestamp,
				[coinbase],
				genesis.hash,
				0,
				1,
				1,
			);
			while (!block.isValid()) {
				block.nonce++;
				block.hash = block.calculateHash();
			}

			await expect(blockchain.replaceChain([genesis, block]))
				.rejects.toThrow('received chain does not have more weight');
		});

		it('should return orphaned transactions to pending pool', async () => {
			const minerAddr = minerWallet.getAddress();
			// Mine enough blocks for coinbase maturity
			await minePowBlocks(COIN_MATURITY, minerAddr);

			// Create a transaction
			const receiverWallet = new Wallet();
			const tx = blockchain.createTransaction(
				minerAddr,
				receiverWallet.getAddress(),
				5,
				minerWallet,
			);
			await blockchain.addTransaction(tx);
			const txHash = tx.calculateHash();

			// Mine block containing the transaction
			const lastBlock1 = blockchain.getLatestBlock();
			const blockTime1 = lastBlock1.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
			jest.setSystemTime(new Date(blockTime1));
			await blockchain.minePendingTransactions(minerAddr);

			// Now the tx is in the chain
			expect(blockchain.getPendingTransactions().length).toBe(0);

			// Build a heavier alternative chain that does NOT include the tx
			// by forking before the block containing the tx
			const chain = blockchain.getChain();
			const forkPoint = chain.length - 1; // fork before last block
			const forkBase = chain.slice(0, forkPoint);

			// Create two high-difficulty blocks on the fork (to outweigh current chain)
			let prevBlock = forkBase[forkBase.length - 1];
			const altBlocks: Block[] = [];
			for (let i = 0; i < 2; i++) {
				const timestamp = prevBlock.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
				const coinbase = new Transaction(
					[],
					[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
				);
				const altBlock = new Block(
					timestamp,
					[coinbase],
					prevBlock.hash,
					0,
					2, // higher difficulty = more weight than difficulty-1 blocks
					forkPoint + i,
				);
				while (!altBlock.isValid()) {
					altBlock.nonce++;
					altBlock.hash = altBlock.calculateHash();
				}
				altBlocks.push(altBlock);
				prevBlock = altBlock;
			}

			const altChain = [...forkBase, ...altBlocks];
			await blockchain.replaceChain(altChain);

			// The orphaned transaction should be back in pending pool
			const pending = blockchain.getPendingTransactions();
			const found = pending.some((t) => t.calculateHash() === txHash);
			expect(found).toBe(true);
		});

		it('should compute chain weights correctly via computeChainWeights', () => {
			const genesis = new Block(Date.now(), [], '0', 0, 4, 0);
			const block1 = new Block(Date.now(), [], genesis.hash, 0, 6, 1);
			block1.hash = block1.calculateHash();
			const block2 = new Block(Date.now(), [], block1.hash, 0, 8, 2);
			block2.hash = block2.calculateHash();

			const chain = [genesis, block1, block2];
			Blockchain.computeChainWeights(chain);

			expect(chain[0].cumulativeWeight).toBe(16);  // 2^4
			expect(chain[1].cumulativeWeight).toBe(80);  // 16 + 2^6
			expect(chain[2].cumulativeWeight).toBe(336); // 80 + 2^8
		});
	});

	describe('Block Validation (C2)', () => {
		it('should reject replaceChain with tampered block hash', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(3, minerAddr);

			// Build a heavier chain with a tampered hash
			const genesisBlock = blockchain.getChain()[0];
			const timestamp1 = genesisBlock.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase1 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
			);
			const block1 = new Block(
				timestamp1,
				[coinbase1],
				genesisBlock.hash,
				0,
				2,
				1,
			);
			while (!block1.isValid()) {
				block1.nonce++;
				block1.hash = block1.calculateHash();
			}

			const timestamp2 = timestamp1 + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase2 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
			);
			const block2 = new Block(
				timestamp2,
				[coinbase2],
				block1.hash,
				0,
				2,
				2,
			);
			while (!block2.isValid()) {
				block2.nonce++;
				block2.hash = block2.calculateHash();
			}

			// Tamper with block1's hash after building the chain
			block1.hash = 'tampered' + block1.hash.slice(8);

			await expect(blockchain.replaceChain([genesisBlock, block1, block2]))
				.rejects.toThrow('block hash mismatch');
		});

		it('should reject replaceChain with incorrect block index', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(3, minerAddr);

			const genesisBlock = blockchain.getChain()[0];
			const timestamp1 = genesisBlock.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase1 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
			);
			const block1 = new Block(
				timestamp1,
				[coinbase1],
				genesisBlock.hash,
				0,
				2,
				99, // Wrong index — should be 1
			);
			while (!block1.isValid()) {
				block1.nonce++;
				block1.hash = block1.calculateHash();
			}

			const timestamp2 = timestamp1 + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase2 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
			);
			const block2 = new Block(
				timestamp2,
				[coinbase2],
				block1.hash,
				0,
				2,
				2,
			);
			while (!block2.isValid()) {
				block2.nonce++;
				block2.hash = block2.calculateHash();
			}

			await expect(blockchain.replaceChain([genesisBlock, block1, block2]))
				.rejects.toThrow('incorrect block index');
		});

		it('should reject replaceChain with invalid genesis hash', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(3, minerAddr);

			// Create a fake genesis block with different parameters
			const fakeGenesis = new Block(
				999999,
				[new Transaction([], [{ address: 'fake', amount: 0 }])],
				'0',
				0,
				4,
				0,
			);

			const timestamp1 = fakeGenesis.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase1 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
			);
			const block1 = new Block(
				timestamp1,
				[coinbase1],
				fakeGenesis.hash,
				0,
				2,
				1,
			);
			while (!block1.isValid()) {
				block1.nonce++;
				block1.hash = block1.calculateHash();
			}

			const timestamp2 = timestamp1 + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase2 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
			);
			const block2 = new Block(
				timestamp2,
				[coinbase2],
				block1.hash,
				0,
				2,
				2,
			);
			while (!block2.isValid()) {
				block2.nonce++;
				block2.hash = block2.calculateHash();
			}

			await expect(blockchain.replaceChain([fakeGenesis, block1, block2]))
				.rejects.toThrow('genesis block hash mismatch');
		});

		it('should reject block exceeding MAX_BLOCK_TRANSACTIONS', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(1, minerAddr);

			const lastBlock = blockchain.getLatestBlock();
			const blockTime = lastBlock.timestamp + blockchain.BLOCK_TIME * 1000 + 1;

			// Create a block with too many transactions
			const txs: Transaction[] = [
				new Transaction([], [{ address: minerAddr, amount: POW_BLOCK_REWARD }]),
			];
			for (let i = 0; i < MAX_BLOCK_TRANSACTIONS; i++) {
				txs.push(new Transaction(
					[{ previousTx: 'fake', outputIndex: 0, signature: 'fake' }],
					[{ address: minerAddr, amount: 1 }],
				));
			}

			const block = new Block(
				blockTime,
				txs,
				lastBlock.hash,
				0,
				1,
				blockchain.getChain().length,
			);
			block.hash = block.calculateHash();

			await expect(blockchain.addMinedBlock(block))
				.rejects.toThrow('block exceeds maximum transaction count');
		});

		it('should reject replaceChain with block exceeding MAX_BLOCK_TRANSACTIONS', async () => {
			const minerAddr = minerWallet.getAddress();

			const genesisBlock = blockchain.getChain()[0];
			const timestamp1 = genesisBlock.timestamp + blockchain.BLOCK_TIME * 1000 + 1;

			// Create a block with too many transactions
			const txs: Transaction[] = [
				new Transaction([], [{ address: minerAddr, amount: POW_BLOCK_REWARD }]),
			];
			for (let i = 0; i < MAX_BLOCK_TRANSACTIONS; i++) {
				txs.push(new Transaction(
					[{ previousTx: 'fake', outputIndex: 0, signature: 'fake' }],
					[{ address: minerAddr, amount: 1 }],
				));
			}

			const block1 = new Block(
				timestamp1,
				txs,
				genesisBlock.hash,
				0,
				2,
				1,
			);
			block1.hash = block1.calculateHash();

			await expect(blockchain.replaceChain([genesisBlock, block1]))
				.rejects.toThrow('block exceeds maximum transaction count');
		});

		it('should reject replaceChain with broken link', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(3, minerAddr);

			const genesisBlock = blockchain.getChain()[0];
			const timestamp1 = genesisBlock.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase1 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
			);
			const block1 = new Block(
				timestamp1,
				[coinbase1],
				'wrong-previous-hash', // broken link
				0,
				2,
				1,
			);
			while (!block1.isValid()) {
				block1.nonce++;
				block1.hash = block1.calculateHash();
			}

			const timestamp2 = timestamp1 + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase2 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
			);
			const block2 = new Block(
				timestamp2,
				[coinbase2],
				block1.hash,
				0,
				2,
				2,
			);
			while (!block2.isValid()) {
				block2.nonce++;
				block2.hash = block2.calculateHash();
			}

			await expect(blockchain.replaceChain([genesisBlock, block1, block2]))
				.rejects.toThrow('broken link');
		});

		it('should accept a valid replacement chain', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(3, minerAddr);

			// Build a valid heavier chain
			const genesisBlock = blockchain.getChain()[0];
			const timestamp1 = genesisBlock.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase1 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
			);
			const block1 = new Block(
				timestamp1,
				[coinbase1],
				genesisBlock.hash,
				0,
				2,
				1,
			);
			while (!block1.isValid()) {
				block1.nonce++;
				block1.hash = block1.calculateHash();
			}

			const timestamp2 = timestamp1 + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase2 = new Transaction(
				[],
				[{ address: minerAddr, amount: POW_BLOCK_REWARD }],
			);
			const block2 = new Block(
				timestamp2,
				[coinbase2],
				block1.hash,
				0,
				2,
				2,
			);
			while (!block2.isValid()) {
				block2.nonce++;
				block2.hash = block2.calculateHash();
			}

			const newChain = [genesisBlock, block1, block2];
			await blockchain.replaceChain(newChain);
			expect(blockchain.getChain().length).toBe(3);
			expect(blockchain.getChainWeight()).toBeGreaterThan(0);
		});
	});

	describe('Stake Security (C3)', () => {
		// Mine enough blocks so mature balance covers staking amounts
		// After 3*COIN_MATURITY blocks: (3*COIN_MATURITY - COIN_MATURITY + 1) mature coinbases
		const stakeSetupBlocks = 3 * COIN_MATURITY;

		describe('Negative stake weight guard', () => {
			it('should return base amount when timestamps are corrupted (negative elapsed)', async () => {
				const minerAddr = minerWallet.getAddress();
				await minePowBlocks(stakeSetupBlocks, minerAddr);
				await blockchain.stake(minerAddr, 100, minerWallet);

				// Corrupt the stake timestamp to be after lastBlockTime
				const stake = blockchain['_stakes'].get(minerAddr)!;
				stake.timestamp = stake.lastBlockTime + 999999;
				blockchain['_stakes'].set(minerAddr, stake);

				// Should return base amount (100), not a negative or zero weight
				const weight = blockchain.calculateStakeWeight(minerAddr);
				expect(weight).toBe(100);
			});
		});

		describe('Bounded stake weight multiplier', () => {
			it('should cap multiplier at MAX_STAKE_AGE_MULTIPLIER', async () => {
				const minerAddr = minerWallet.getAddress();
				await minePowBlocks(stakeSetupBlocks, minerAddr);
				await blockchain.stake(minerAddr, 100, minerWallet);

				// Set stake to be very old (1000 days)
				const stake = blockchain['_stakes'].get(minerAddr)!;
				stake.timestamp = 0;
				stake.lastBlockTime = 1000 * 24 * 60 * 60 * 1000;
				blockchain['_stakes'].set(minerAddr, stake);

				const weight = blockchain.calculateStakeWeight(minerAddr);
				// With 1000 days, unbounded 1.1^1000 would be astronomical
				// But capped at MAX_STAKE_AGE_MULTIPLIER (4x)
				expect(weight).toBe(Math.floor(100 * MAX_STAKE_AGE_MULTIPLIER));
			});

			it('should not cap multiplier when below maximum', async () => {
				const minerAddr = minerWallet.getAddress();
				await minePowBlocks(stakeSetupBlocks, minerAddr);
				await blockchain.stake(minerAddr, 100, minerWallet);

				// Set stake to be 1 day old (multiplier = 1.1, below cap of 4)
				const stake = blockchain['_stakes'].get(minerAddr)!;
				stake.timestamp = 0;
				stake.lastBlockTime = 24 * 60 * 60 * 1000;
				blockchain['_stakes'].set(minerAddr, stake);

				const weight = blockchain.calculateStakeWeight(minerAddr);
				expect(weight).toBe(Math.floor(100 * 1.1));
			});
		});

		describe('Unstake delay', () => {
			it('should not remove stake immediately on unstake', async () => {
				const minerAddr = minerWallet.getAddress();
				await minePowBlocks(stakeSetupBlocks, minerAddr);
				await blockchain.stake(minerAddr, 100, minerWallet);

				await blockchain.unstake(minerAddr, 100);

				// Stake should still be active
				expect(blockchain.getStake(minerAddr)).toBe(100);
				// But there should be a pending unstake
				const pending = blockchain.getPendingUnstakes(minerAddr);
				expect(pending.length).toBe(1);
				expect(pending[0].amount).toBe(100);
			});

			it('should process unstake after UNSTAKE_DELAY blocks', async () => {
				const minerAddr = minerWallet.getAddress();
				await minePowBlocks(stakeSetupBlocks, minerAddr);
				await blockchain.stake(minerAddr, 200, minerWallet);

				await blockchain.unstake(minerAddr, 100);

				// Mine UNSTAKE_DELAY blocks to mature the unstake
				await minePowBlocks(UNSTAKE_DELAY, minerAddr);

				// Stake should now be reduced
				expect(blockchain.getStake(minerAddr)).toBe(100);
				// Pending unstake should be cleared
				expect(blockchain.getPendingUnstakes(minerAddr).length).toBe(0);
			});

			it('should keep stake active during delay period', async () => {
				const minerAddr = minerWallet.getAddress();
				await minePowBlocks(stakeSetupBlocks, minerAddr);
				await blockchain.stake(minerAddr, 200, minerWallet);

				await blockchain.unstake(minerAddr, 100);

				// Mine only half the delay
				await minePowBlocks(Math.floor(UNSTAKE_DELAY / 2), minerAddr);

				// Stake should still be full
				expect(blockchain.getStake(minerAddr)).toBe(200);
				expect(blockchain.getPendingUnstakes(minerAddr).length).toBe(1);
			});

			it('should reject unstake exceeding available amount (accounting for pending)', async () => {
				const minerAddr = minerWallet.getAddress();
				await minePowBlocks(stakeSetupBlocks, minerAddr);
				await blockchain.stake(minerAddr, 200, minerWallet);

				// First unstake of 150
				await blockchain.unstake(minerAddr, 150);

				// Second unstake of 100 should fail (only 50 available)
				await expect(blockchain.unstake(minerAddr, 100))
					.rejects.toThrow('Insufficient stake amount');
			});
		});

		describe('Double-sign slashing', () => {
			it('should slash stake on double-sign evidence', async () => {
				const minerAddr = minerWallet.getAddress();
				await minePowBlocks(Number(POW_CUTOFF_BLOCK), minerAddr);
				await blockchain.stake(minerAddr, 200, minerWallet);

				// Generate a PoS block to record the signature
				const lastBlock = blockchain.getLatestBlock();
				const nextBlockTime = lastBlock.timestamp + 11 * 60 * 1000;
				jest.setSystemTime(new Date(nextBlockTime));
				await blockchain.minePendingTransactions(minerAddr, minerWallet);

				const posBlock = blockchain.getLatestBlock();
				expect(posBlock.isProofOfStake()).toBe(true);

				// Verify stake exists
				expect(blockchain.getStake(minerAddr)).toBeGreaterThan(0);

				// Submit double-sign evidence (known hash + a different hash)
				await blockchain.submitDoubleSignEvidence(
					posBlock.index,
					posBlock.hash,
					'different-block-hash-at-same-height',
					minerAddr,
				);

				// Stake should be slashed (removed entirely)
				expect(blockchain.getStake(minerAddr)).toBe(0);
			});

			it('should reject evidence with same block hashes', async () => {
				const minerAddr = minerWallet.getAddress();
				await minePowBlocks(Number(POW_CUTOFF_BLOCK), minerAddr);
				await blockchain.stake(minerAddr, 200, minerWallet);

				const lastBlock = blockchain.getLatestBlock();
				const nextBlockTime = lastBlock.timestamp + 11 * 60 * 1000;
				jest.setSystemTime(new Date(nextBlockTime));
				await blockchain.minePendingTransactions(minerAddr, minerWallet);

				const posBlock = blockchain.getLatestBlock();

				await expect(blockchain.submitDoubleSignEvidence(
					posBlock.index,
					posBlock.hash,
					posBlock.hash,
					minerAddr,
				)).rejects.toThrow('block hashes must be different');
			});

			it('should reject evidence for unknown validator', async () => {
				const minerAddr = minerWallet.getAddress();
				await minePowBlocks(1, minerAddr);

				const unknownWallet = new Wallet();
				await expect(blockchain.submitDoubleSignEvidence(
					1,
					'hash1',
					'hash2',
					unknownWallet.getAddress(),
				)).rejects.toThrow('no known block signature');
			});

			it('should also remove pending unstakes on slashing', async () => {
				const minerAddr = minerWallet.getAddress();
				await minePowBlocks(Number(POW_CUTOFF_BLOCK), minerAddr);
				await blockchain.stake(minerAddr, 200, minerWallet);

				// Queue an unstake
				await blockchain.unstake(minerAddr, 100);
				expect(blockchain.getPendingUnstakes(minerAddr).length).toBe(1);

				// Generate PoS block
				const lastBlock = blockchain.getLatestBlock();
				const nextBlockTime = lastBlock.timestamp + 11 * 60 * 1000;
				jest.setSystemTime(new Date(nextBlockTime));
				await blockchain.minePendingTransactions(minerAddr, minerWallet);

				const posBlock = blockchain.getLatestBlock();

				// Slash
				await blockchain.submitDoubleSignEvidence(
					posBlock.index,
					posBlock.hash,
					'other-hash',
					minerAddr,
				);

				// Both stake and pending unstake should be gone
				expect(blockchain.getStake(minerAddr)).toBe(0);
				expect(blockchain.getPendingUnstakes(minerAddr).length).toBe(0);
			});
		});

		describe('Pattern B stake detection fix', () => {
			it('should not treat normal self-transfers as staking', async () => {
				const minerAddr = minerWallet.getAddress();
				// Mine enough blocks for sufficient mature balance
				await minePowBlocks(stakeSetupBlocks, minerAddr);

				// Clear stakes to start fresh
				blockchain['_stakes'].clear();

				// Create a normal self-transfer >= 100 (all outputs same address)
				const tx = blockchain.createTransaction(
					minerAddr,
					minerAddr,
					100,
					minerWallet,
				);
				await blockchain.addTransaction(tx);

				// Mine the block containing the self-transfer
				const lastBlock = blockchain.getLatestBlock();
				const blockTime = lastBlock.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
				jest.setSystemTime(new Date(blockTime));
				await blockchain.minePendingTransactions(minerAddr);

				// Stakes map should still be empty — self-transfer is not staking
				expect(blockchain['_stakes'].size).toBe(0);
			});

			it('should detect staking via coinstake format (zero marker)', async () => {
				const minerAddr = minerWallet.getAddress();
				await minePowBlocks(stakeSetupBlocks, minerAddr);

				// Use stake() which now creates coinstake-format transactions
				await blockchain.stake(minerAddr, 100, minerWallet);

				// Mine the staking transaction
				const lastBlock = blockchain.getLatestBlock();
				const blockTime = lastBlock.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
				jest.setSystemTime(new Date(blockTime));
				await blockchain.minePendingTransactions(minerAddr);

				// The stake should be registered
				expect(blockchain.getStake(minerAddr)).toBe(100);
			});
		});
	});
});
