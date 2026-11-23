import * as fs from 'fs';
import * as path from 'path';
import protobuf from 'protobufjs';
import { Wallet } from '../../blockchain/Wallet.js';
import { addressFromPublicKey } from '../../blockchain/address.js';
import { secp256k1 } from '../../blockchain/secp256k1.js';
import { COIN, COIN_MATURITY, POW_BLOCK_REWARD } from '../../config.js';
import {
	makeTempDir,
	mineBlocks,
	openChain,
	openWallet,
	removeTempDir,
	useTestClock,
} from './helpers.js';

describe('Persistence (real filesystem)', () => {
	let dir: string;

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
		useTestClock();
		dir = makeTempDir();
	});

	afterEach(() => {
		jest.useRealTimers();
		removeTempDir(dir);
	});

	it('should write genesis to disk and load it again', () => {
		const first = openChain(dir);
		expect(fs.existsSync(path.join(dir, 'blocks', 'blk00000.dat'))).toBe(true);
		expect(fs.existsSync(path.join(dir, 'blocks', 'index.dat'))).toBe(true);

		const second = openChain(dir);
		expect(second.getChain().map((b) => b.hash)).toEqual(first.getChain().map((b) => b.hash));
	});

	it('should reload mined blocks with identical hashes and UTXO set', async () => {
		const miner = openWallet(dir, 'miner');
		const first = openChain(dir);
		await mineBlocks(first, miner.address, 5);

		const second = openChain(dir);
		expect(second.getChain()).toHaveLength(6);
		expect(second.getChain().map((b) => b.hash)).toEqual(first.getChain().map((b) => b.hash));
		expect(second.getUTXOs(miner.address)).toEqual(first.getUTXOs(miner.address));
		expect(second.getBalance(miner.address)).toBe(5n * POW_BLOCK_REWARD);
	});

	it('should reload a spending transaction with its inputs and signatures', async () => {
		const miner = openWallet(dir, 'miner');
		const recipient = openWallet(dir, 'recipient');
		const first = openChain(dir);
		await mineBlocks(first, miner.address, COIN_MATURITY + 1);

		const tx = first.createTransaction(miner.address, recipient.address, 7n * COIN, miner);
		await first.addTransaction(tx);
		await mineBlocks(first, miner.address, 1);

		const second = openChain(dir);
		const reloadedTx = second
			.getChain()
			.flatMap((b) => b.transactions)
			.find((t) => t.calculateHash() === tx.calculateHash());
		expect(reloadedTx?.inputs).toEqual(tx.inputs);
		expect(second.getBalance(recipient.address)).toBe(7n * COIN);
		expect(second.getUTXOs(miner.address)).toEqual(first.getUTXOs(miner.address));
	});

	it('should continue mining on top of a reloaded chain', async () => {
		const miner = openWallet(dir, 'miner');
		await mineBlocks(openChain(dir), miner.address, 3);

		await mineBlocks(openChain(dir), miner.address, 2);

		expect(openChain(dir).getChain()).toHaveLength(6);
	});

	it('should keep the wallet key across reopen', () => {
		const first = openWallet(dir, 'node');
		const second = openWallet(dir, 'node');
		expect(second.address).toBe(first.address);
		expect(second.publicKey.equals(first.publicKey)).toBe(true);
	});

	it('should load a wallet file written with the old history and UTXO fields', () => {
		// The wallet schema before TASK-0017 (fields 4 and 5 are reserved now)
		const oldSchema = `syntax = "proto3";
			message WalletTransaction { string hash = 1; int64 timestamp = 2; string type = 3; string other_party = 5; uint64 amount = 6; }
			message WalletUtxo { string tx_hash = 1; uint32 output_index = 2; uint64 amount = 4; }
			message WalletData { bytes private_key = 1; bytes public_key = 2; string address = 3;
				repeated WalletTransaction transactions = 4; repeated WalletUtxo utxos = 5; }`;
		const WalletData = protobuf.parse(oldSchema).root.lookupType('WalletData');
		const privateKey = Buffer.alloc(32, 7);
		const publicKey = Buffer.from(secp256k1.publicKeyCreate(privateKey, true));
		const original = { publicKey, address: addressFromPublicKey(publicKey) };
		const file = path.join(dir, 'old.dat');
		const legacy = WalletData.encode(
			WalletData.fromObject({
				privateKey,
				publicKey,
				address: original.address,
				transactions: [{ hash: 'ab'.repeat(32), timestamp: '1', type: 'received', otherParty: 'x', amount: '5' }],
				utxos: [{ txHash: 'ab'.repeat(32), outputIndex: 0, amount: '5' }],
			}),
		).finish();
		fs.writeFileSync(file, legacy);

		const reopened = new Wallet(file);

		expect(reopened.address).toBe(original.address);
		expect(reopened.publicKey.equals(original.publicKey)).toBe(true);
	});
});
