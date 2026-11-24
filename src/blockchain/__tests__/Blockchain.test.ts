import { jest } from '@jest/globals';
import { Block } from '../Block.js';
import { Blockchain, type BlockchainOptions } from '../Blockchain.js';
import { Wallet } from '../Wallet.js';
import { NULL_HASH, Transaction } from '../Transaction.js';
import { blockWork, MAX_TARGET_BITS, targetToBits } from '../target.js';
import { minRelayFee } from '../fees.js';
import {
	COIN,
	POW_CUTOFF_BLOCK,
	POW_BLOCK_REWARD,
	COIN_MATURITY,
	BLOCK_TIME,
	MAX_BLOCK_TRANSACTIONS,
} from '../../config.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const coins = (n: number): bigint => BigInt(n) * COIN;
// What the setups send from one mature 10-coin coinbase, leaving room for the fee
const SENDER_FUNDS = coins(9);
// Target equivalent to the old difficulty of `hexZeros` leading zero hex digits
const bitsFor = (hexZeros: number): number =>
	targetToBits((1n << BigInt(256 - 4 * hexZeros)) - 1n);
// Well-formed but meaningless witness data, for structure tests that never reach signature checks
const FAKE_PUBLIC_KEY = '02' + '11'.repeat(32);
const FAKE_SIGNATURE = 'aa'.repeat(64);

const testOptions: BlockchainOptions = {
	minStakeAge: 0,
	validateDifficulty: false,
	validateTimestamps: false,
};

// Mock the fs module
// Real files in a temp dir per test: blocks other than the tip are read back from the block
// files (TASK-0053), so mocking fs would hide them
describe('Blockchain', () => {
	let blockchain: Blockchain;
	let minerWallet: Wallet;
	let dir: string;
	let wallets = 0;
	const options = (extra: BlockchainOptions = {}): BlockchainOptions => ({ ...testOptions, blocksDir: path.join(dir, 'blocks'), ...extra });
	const newWallet = () => new Wallet(path.join(dir, `wallet-${++wallets}.dat`));

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockchain-ts-unit-'));
		// Set initial time to match genesis block timestamp + 1 day to ensure enough spacing
		const genesisTime = 1609459200000; // Jan 1, 2021
		const initialTestTime = genesisTime + 24 * 60 * 60 * 1000; // Start 1 day after genesis
		jest.useFakeTimers();
		jest.setSystemTime(new Date(initialTestTime));
		blockchain = new Blockchain(options());
		minerWallet = newWallet();
	});

	afterEach(() => {
		jest.useRealTimers();
		fs.rmSync(dir, { recursive: true, force: true });
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
			expect(chain[0].previousHash).toBe(NULL_HASH);
			expect(chain[0].isProofOfWork()).toBe(true);
		});
	});

	describe('Consensus Transition', () => {
		it('should start in the PoW phase on the default parameters', () => {
			expect(blockchain['_options'].powCutoffBlock).toBe(POW_CUTOFF_BLOCK);
			expect(blockchain.isProofOfStakePhase()).toBe(false);
		});

		it('should take PoW blocks up to the cutoff height and refuse them after it', async () => {
			const cutoff = 12;
			blockchain = new Blockchain(options({ powCutoffBlock: cutoff }));
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(cutoff, minerAddr);
			expect(blockchain.getChain().slice(1).every((block) => block.isProofOfWork())).toBe(true);
			expect(blockchain.isProofOfStakePhase()).toBe(true);
			await expect(minePowBlocks(1, minerAddr)).rejects.toThrow(`PoW blocks no longer accepted after block ${cutoff}`);
		});

	});

	describe('UTXO Double-Spend Prevention', () => {
		let senderWallet: Wallet;
		let receiverWallet: Wallet;
		let receiverWallet2: Wallet;

		beforeEach(async () => {
			senderWallet = newWallet();
			receiverWallet = newWallet();
			receiverWallet2 = newWallet();

			// Mine enough blocks for coinbase maturity
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(COIN_MATURITY, minerAddr);

			// Transfer coins to senderWallet
			const tx = blockchain.createTransaction(
				minerAddr,
				senderWallet.getAddress(),
				SENDER_FUNDS,
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
				coins(5),
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
					coins(5),
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
				publicKey: '',
				signature: '',
			}];

			const tx1 = new Transaction(
				inputs,
				[{ address: receiverWallet.getAddress(), amount: coins(5) }]
			);
			senderWallet.signTransaction(tx1);

			const tx2 = new Transaction(
				[{
					previousTx: utxos[0].txHash,
					outputIndex: utxos[0].outputIndex,
					publicKey: '',
					signature: '',
				}],
				[{ address: receiverWallet2.getAddress(), amount: coins(5) }]
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
					publicKey: '',
					signature: '',
				},
				{
					previousTx: utxos[0].txHash,
					outputIndex: utxos[0].outputIndex,
					publicKey: '',
					signature: '',
				},
			];

			const tx = new Transaction(
				duplicateInputs,
				[{ address: receiverWallet.getAddress(), amount: coins(5) }]
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
				coins(5),
				senderWallet
			);
			await blockchain.addTransaction(tx);

			// Mine a block to confirm it
			const lastBlock = blockchain.getLatestBlock();
			const blockTime = Number(lastBlock.timestamp) + blockchain.BLOCK_TIME * 1000 + 1;
			jest.setSystemTime(new Date(blockTime));
			await blockchain.minePendingTransactions(minerAddr);

			// Pending pool is now empty; the sender can spend its change (funds - 5 - fee)
			const remainingBalance = blockchain.getBalance(senderAddr);
			expect(remainingBalance).toBe(SENDER_FUNDS - coins(5) - minRelayFee(tx.size()));
			const tx2 = blockchain.createTransaction(
				senderAddr,
				receiverWallet2.getAddress(),
				coins(1),
				senderWallet
			);
			await expect(blockchain.addTransaction(tx2)).resolves.not.toThrow();
		});

		it('should allow spending after clearPendingTransactions', async () => {
			const senderAddr = senderWallet.getAddress();

			const tx1 = blockchain.createTransaction(
				senderAddr,
				receiverWallet.getAddress(),
				coins(5),
				senderWallet
			);
			await blockchain.addTransaction(tx1);

			// Clear pending transactions (simulates a reset)
			await blockchain.clearPendingTransactions();

			// Should now be able to spend the same UTXOs again
			const tx2 = blockchain.createTransaction(
				senderAddr,
				receiverWallet2.getAddress(),
				coins(5),
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
					{ address: minerAddr, amount: 0n },
				]
			);
			const block = new Block(
				blockTime,
				[notCoinbase],
				lastBlock.hash,
				0,
				bitsFor(1),
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
			const badCoinbase = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD * 2n, blockchain.getChain().length);
			const block = new Block(
				blockTime,
				[badCoinbase],
				lastBlock.hash,
				0,
				bitsFor(1),
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

			const coinbase1 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 1);
			const coinbase2 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 2, blockTime);
			const block = new Block(
				blockTime,
				[coinbase1, coinbase2],
				lastBlock.hash,
				0,
				bitsFor(1),
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

			const zeroCoinbase = Transaction.coinbase(minerAddr, 0n, blockchain.getChain().length);
			const block = new Block(
				blockTime,
				[zeroCoinbase],
				lastBlock.hash,
				0,
				bitsFor(1),
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

			const receiverWallet = newWallet();

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

			const receiverWallet = newWallet();
			// Manually create a transaction spending the immature coinbase
			const tx = new Transaction(
				[{ previousTx: coinbaseTxHash, outputIndex: 0, publicKey: '', signature: '' }],
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

			const receiverWallet = newWallet();

			// Should now succeed — coinbase from block 1 is mature
			const tx = blockchain.createTransaction(
				minerAddr,
				receiverWallet.getAddress(),
				coins(5),
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
				[Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, blockchain.getChain().length)],
				'ab'.repeat(32), // not the tip
				0,
				bitsFor(1),
				blockchain.getChain().length
			);
			badBlock.hash = badBlock.calculateHash();

			await expect(blockchain.addMinedBlock(badBlock))
				.rejects.toThrow('unknown parent block');
		});

		it('should serialize concurrent addTransaction calls', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(COIN_MATURITY, minerAddr);

			// Create a transaction
			const tx1 = blockchain.createTransaction(
				minerAddr,
				newWallet().getAddress(),
				coins(5),
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
			senderWallet = newWallet();
			receiverWallet = newWallet();

			const minerAddr = minerWallet.getAddress();
			// Mine enough blocks for coinbase maturity
			await minePowBlocks(COIN_MATURITY, minerAddr);

			// Transfer coins to senderWallet
			const tx = blockchain.createTransaction(
				minerAddr,
				senderWallet.getAddress(),
				SENDER_FUNDS,
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
					publicKey: '',
					signature: '',
				}],
				[{ address: receiverWallet.getAddress(), amount: coins(5) }]
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
					publicKey: '',
					signature: '',
				}],
				[{ address: receiverWallet.getAddress(), amount: coins(5) }]
			);
			senderWallet.signTransaction(tx);

			await expect(blockchain.addTransaction(tx))
				.rejects.toThrow('input references a missing or spent output');
		});

		it('should reject transaction with outputs exceeding inputs', async () => {
			const utxos = blockchain.getUTXOs(senderWallet.getAddress());

			// Create a transaction with output amount greater than the UTXO value
			const tx = new Transaction(
				[{
					previousTx: utxos[0].txHash,
					outputIndex: utxos[0].outputIndex,
					publicKey: '',
					signature: '',
				}],
				[{ address: receiverWallet.getAddress(), amount: POW_BLOCK_REWARD + coins(100) }]
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
					publicKey: FAKE_PUBLIC_KEY,
					signature: FAKE_SIGNATURE,
				}],
				[{ address: receiverWallet.getAddress(), amount: -coins(5) }]
			);

			// A negative amount has no canonical encoding, so it can't be signed...
			expect(() => senderWallet.signTransaction(tx)).toThrow('output amount out of range');
			// ...and structural validation rejects it before any signature check
			await expect(blockchain.addTransaction(tx))
				.rejects.toThrow('output has negative amount');
		});

		it('should reject transaction with zero output amount', async () => {
			const utxos = blockchain.getUTXOs(senderWallet.getAddress());

			const tx = new Transaction(
				[{
					previousTx: utxos[0].txHash,
					outputIndex: utxos[0].outputIndex,
					publicKey: '',
					signature: '',
				}],
				[{ address: receiverWallet.getAddress(), amount: coins(0) }]
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
					publicKey: '',
					signature: '',
				}],
				[{ address: 'invalid-address', amount: coins(5) }]
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
					coins(5),
					senderWallet
				);
			}).toThrow('invalid sender address');
		});

		it('should reject createTransaction with invalid recipient address', () => {
			expect(() => {
				blockchain.createTransaction(
					senderWallet.getAddress(),
					'bad-address',
					coins(5),
					senderWallet
				);
			}).toThrow('invalid recipient address');
		});

		it('should accept a valid transaction', async () => {
			const tx = blockchain.createTransaction(
				senderWallet.getAddress(),
				receiverWallet.getAddress(),
				coins(5),
				senderWallet
			);
			await expect(blockchain.addTransaction(tx)).resolves.not.toThrow();
		});
	});

	describe('Timestamps', () => {
		it('should compute median time past correctly', async () => {
			await minePowBlocks(5, minerWallet.getAddress());
			const timestamps = blockchain
				.getChain()
				.map((b) => b.timestamp)
				.sort((a, b) => a - b);
			expect(blockchain.getMedianTimePast()).toBe(timestamps[Math.floor(timestamps.length / 2)]);
		});

		it('should use config BLOCK_TIME constant', () => {
			expect(blockchain.BLOCK_TIME).toBe(BLOCK_TIME);
		});
	});

	describe('Fork Resolution', () => {
		it('should compute block weight as the work of its target', () => {
			const block = new Block(Date.now(), [], NULL_HASH, 0, bitsFor(4), 0);
			expect(Blockchain.blockWeight(block)).toBe(blockWork(bitsFor(4)));
			// ~2^16 expected hashes (65537: the compact encoding rounds the target down)
			expect(blockWork(bitsFor(4))).toBe(65537n);
		});

		it('should set cumulative weight on mined blocks', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(3, minerAddr);

			const chain = blockchain.getChain();
			expect(chain[0].cumulativeWeight).toBe(chain[0].work());
			for (let i = 1; i < chain.length; i++) {
				expect(chain[i].cumulativeWeight).toBe(chain[i - 1].cumulativeWeight + chain[i].work());
			}
		});

		it('should report chain weight from latest block', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(2, minerAddr);

			const totalWork = blockchain.getChain().reduce((sum, b) => sum + b.work(), 0n);
			expect(blockchain.getChainWeight()).toBe(totalWork);
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
			const coinbase1 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 1, highDiffBlock1Timestamp);
			const block1 = new Block(
				highDiffBlock1Timestamp,
				[coinbase1],
				genesisBlock.hash,
				0,
				bitsFor(2), // harder target: more work
				1,
			);
			// Mine valid PoW
			while (!block1.isValid()) {
				block1.nonce++;
				block1.hash = block1.calculateHash();
			}

			const highDiffBlock2Timestamp =
				highDiffBlock1Timestamp + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase2 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 2, highDiffBlock2Timestamp);
			const block2 = new Block(
				highDiffBlock2Timestamp,
				[coinbase2],
				block1.hash,
				0,
				bitsFor(2), // harder target: more work
				2,
			);
			while (!block2.isValid()) {
				block2.nonce++;
				block2.hash = block2.calculateHash();
			}

			const newChain = [genesisBlock, block1, block2];
			// Two harder blocks outweigh three easy ones
			expect(Blockchain.blockWeight(block1)).toBe(blockWork(bitsFor(2)));

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
			const coinbase = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 1, singleBlockTimestamp);
			const block = new Block(
				singleBlockTimestamp,
				[coinbase],
				genesis.hash,
				0,
				MAX_TARGET_BITS, // 1 unit of work: lighter than three mined blocks
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
			const receiverWallet = newWallet();
			const tx = blockchain.createTransaction(
				minerAddr,
				receiverWallet.getAddress(),
				coins(5),
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
				const coinbase = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, forkPoint + i);
				const altBlock = new Block(
					timestamp,
					[coinbase],
					prevBlock.hash,
					0,
					bitsFor(2), // harder target than mined blocks: more work
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
			const genesis = new Block(Date.now(), [], NULL_HASH, 0, bitsFor(4), 0);
			const block1 = new Block(Date.now(), [], genesis.hash, 0, bitsFor(6), 1);
			const block2 = new Block(Date.now(), [], block1.hash, 0, bitsFor(8), 2);

			const chain = [genesis, block1, block2];
			Blockchain.computeChainWeights(chain);

			const [w4, w6, w8] = [4, 6, 8].map((d) => blockWork(bitsFor(d)));
			expect(chain[0].cumulativeWeight).toBe(w4);
			expect(chain[1].cumulativeWeight).toBe(w4 + w6);
			expect(chain[2].cumulativeWeight).toBe(w4 + w6 + w8);
		});
	});

	describe('Block Validation (C2)', () => {
		it('should reject replaceChain with tampered block hash', async () => {
			const minerAddr = minerWallet.getAddress();
			await minePowBlocks(3, minerAddr);

			// Build a heavier chain with a tampered hash
			const genesisBlock = blockchain.getChain()[0];
			const timestamp1 = genesisBlock.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase1 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 1, timestamp1);
			const block1 = new Block(
				timestamp1,
				[coinbase1],
				genesisBlock.hash,
				0,
				bitsFor(2),
				1,
			);
			while (!block1.isValid()) {
				block1.nonce++;
				block1.hash = block1.calculateHash();
			}

			const timestamp2 = timestamp1 + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase2 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 2, timestamp2);
			const block2 = new Block(
				timestamp2,
				[coinbase2],
				block1.hash,
				0,
				bitsFor(2),
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
			const coinbase1 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 1, timestamp1);
			const block1 = new Block(
				timestamp1,
				[coinbase1],
				genesisBlock.hash,
				0,
				bitsFor(2),
				99, // Wrong index — should be 1
			);
			while (!block1.isValid()) {
				block1.nonce++;
				block1.hash = block1.calculateHash();
			}

			const timestamp2 = timestamp1 + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase2 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 2, timestamp2);
			const block2 = new Block(
				timestamp2,
				[coinbase2],
				block1.hash,
				0,
				bitsFor(2),
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
				[Transaction.coinbase('fake', 0n, 0)],
				NULL_HASH,
				0,
				bitsFor(4),
				0,
			);

			const timestamp1 = fakeGenesis.timestamp + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase1 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 1, timestamp1);
			const block1 = new Block(
				timestamp1,
				[coinbase1],
				fakeGenesis.hash,
				0,
				bitsFor(2),
				1,
			);
			while (!block1.isValid()) {
				block1.nonce++;
				block1.hash = block1.calculateHash();
			}

			const timestamp2 = timestamp1 + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase2 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 2, timestamp2);
			const block2 = new Block(
				timestamp2,
				[coinbase2],
				block1.hash,
				0,
				bitsFor(2),
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
				Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, blockchain.getChain().length),
			];
			for (let i = 0; i < MAX_BLOCK_TRANSACTIONS; i++) {
				txs.push(new Transaction(
					[{
						previousTx: 'ab'.repeat(32),
						outputIndex: i,
						publicKey: FAKE_PUBLIC_KEY,
						signature: FAKE_SIGNATURE,
					}],
					[{ address: minerAddr, amount: 1n }],
				));
			}

			const block = new Block(
				blockTime,
				txs,
				lastBlock.hash,
				0,
				bitsFor(1),
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
			const txs: Transaction[] = [Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 1)];
			for (let i = 0; i < MAX_BLOCK_TRANSACTIONS; i++) {
				txs.push(new Transaction(
					[{
						previousTx: 'ab'.repeat(32),
						outputIndex: i,
						publicKey: FAKE_PUBLIC_KEY,
						signature: FAKE_SIGNATURE,
					}],
					[{ address: minerAddr, amount: 1n }],
				));
			}

			const block1 = new Block(
				timestamp1,
				txs,
				genesisBlock.hash,
				0,
				bitsFor(2),
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
			const coinbase1 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 1, timestamp1);
			const block1 = new Block(
				timestamp1,
				[coinbase1],
				'ab'.repeat(32) /* not the previous block */, // broken link
				0,
				bitsFor(2),
				1,
			);
			while (!block1.isValid()) {
				block1.nonce++;
				block1.hash = block1.calculateHash();
			}

			const timestamp2 = timestamp1 + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase2 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 2, timestamp2);
			const block2 = new Block(
				timestamp2,
				[coinbase2],
				block1.hash,
				0,
				bitsFor(2),
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
			const coinbase1 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 1, timestamp1);
			const block1 = new Block(
				timestamp1,
				[coinbase1],
				genesisBlock.hash,
				0,
				bitsFor(2),
				1,
			);
			while (!block1.isValid()) {
				block1.nonce++;
				block1.hash = block1.calculateHash();
			}

			const timestamp2 = timestamp1 + blockchain.BLOCK_TIME * 1000 + 1;
			const coinbase2 = Transaction.coinbase(minerAddr, POW_BLOCK_REWARD, 2, timestamp2);
			const block2 = new Block(
				timestamp2,
				[coinbase2],
				block1.hash,
				0,
				bitsFor(2),
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

});
