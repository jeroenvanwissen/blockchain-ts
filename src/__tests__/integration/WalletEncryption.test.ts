// Wallet encryption at rest (TASK-0024): scrypt + AES-256-GCM, locked on load, unlock with a
// passphrase (optionally timed or for staking only). Real files and protobuf.
import * as fs from 'fs';
import * as path from 'path';
import protobuf from 'protobufjs';
import { Wallet } from '../../blockchain/Wallet.js';
import { StakingService } from '../../blockchain/StakingService.js';
import { Transaction } from '../../blockchain/Transaction.js';
import { WALLET_SCHEMA } from '../../blockchain/protoSchemas.js';
import { COIN } from '../../config.js';
import {
	finishPowPhase,
	findStakeBlock,
	makeTempDir,
	nextStakeTime,
	openPosChain,
	openWallet,
	removeTempDir,
	useTestClock,
} from './helpers.js';

const PASSPHRASE = 'correct horse battery';

/** The stored private key bytes, read with the current schema (empty when encrypted). */
function storedPrivateKey(file: string): Buffer {
	const type = protobuf.parse(WALLET_SCHEMA).root.lookupType('WalletData');
	const { privateKey } = type.decode(fs.readFileSync(file)) as unknown as { privateKey: Uint8Array };
	return Buffer.from(privateKey);
}

/** A transaction to sign (signing doesn't need a real output). */
function anyTransaction(wallet: Wallet): Transaction {
	return new Transaction(
		[{ previousTx: 'ab'.repeat(32), outputIndex: 0, publicKey: '', signature: '' }],
		[{ address: wallet.address, amount: COIN }],
	);
}

describe('Wallet encryption', () => {
	let dir: string;

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
		jest.spyOn(console, 'log').mockImplementation(() => {});
		jest.spyOn(console, 'error').mockImplementation(() => {});
		dir = makeTempDir();
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
		removeTempDir(dir);
	});

	it('should store only the encrypted key, delete unencrypted backups, and load locked', () => {
		const wallet = openWallet(dir, 'node');
		const file = path.join(dir, 'node.dat');
		const privateKey = storedPrivateKey(file);
		const backup = `${file}.1000.backup`;
		fs.copyFileSync(file, backup); // an older save: holds the key unencrypted

		wallet.encrypt(PASSPHRASE);

		const contents = fs.readFileSync(file);
		expect(contents.includes(privateKey)).toBe(false);
		expect(storedPrivateKey(file)).toHaveLength(0);
		expect(fs.existsSync(backup)).toBe(false);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(wallet.isLocked()).toBe(true);

		const reopened = new Wallet(file);
		expect(reopened.address).toBe(wallet.address);
		expect(reopened.isEncrypted()).toBe(true);
		expect(reopened.isLocked()).toBe(true);
		expect(() => reopened.signTransaction(anyTransaction(reopened))).toThrow('wallet is locked');
	});

	it('should unlock only with the right passphrase, sign while unlocked, and wipe the key on lock', () => {
		const wallet = openWallet(dir, 'node');
		wallet.encrypt(PASSPHRASE);

		expect(() => wallet.unlock('wrong passphrase')).toThrow('wrong passphrase');
		expect(wallet.isLocked()).toBe(true);

		wallet.unlock(PASSPHRASE);
		const tx = anyTransaction(wallet);
		wallet.signTransaction(tx);
		expect(tx.isValid()).toBe(true);

		wallet.lock();
		expect(wallet.isLocked()).toBe(true);
		expect(() => wallet.signDigest(Buffer.alloc(32, 1))).toThrow('wallet is locked');
	});

	it('should lock again when a timed unlock expires', () => {
		useTestClock();
		const wallet = openWallet(dir, 'node');
		wallet.encrypt(PASSPHRASE);

		wallet.unlock(PASSPHRASE, { timeoutMs: 60_000 });
		expect(wallet.unlockedUntil()).toBe(Date.now() + 60_000);
		jest.advanceTimersByTime(59_999);
		expect(wallet.isLocked()).toBe(false);
		jest.advanceTimersByTime(1);
		expect(wallet.isLocked()).toBe(true);
		expect(wallet.unlockedUntil()).toBeNull();
	});

	it('should refuse weak passphrases, double encryption, tampered files and lock on plain wallets', () => {
		const wallet = openWallet(dir, 'node');
		expect(() => wallet.lock()).toThrow('wallet is not encrypted');
		expect(() => wallet.encrypt('short')).toThrow('at least 8 characters');
		wallet.encrypt(PASSPHRASE);
		expect(() => wallet.encrypt(PASSPHRASE)).toThrow('already encrypted');

		// Flip one byte of the ciphertext: authentication fails like a wrong passphrase
		const file = path.join(dir, 'node.dat');
		const type = protobuf.parse(WALLET_SCHEMA).root.lookupType('WalletData');
		const data = type.toObject(type.decode(fs.readFileSync(file))) as {
			encryptedKey: { ciphertext: Uint8Array };
		};
		data.encryptedKey.ciphertext[0] ^= 1;
		fs.writeFileSync(file, type.encode(type.fromObject(data)).finish());
		expect(() => new Wallet(file).unlock(PASSPHRASE)).toThrow('wrong passphrase');
	});

	it('should change the passphrase: the old one stops working, backups go, the lock state stays', () => {
		const wallet = openWallet(dir, 'node');
		const file = path.join(dir, 'node.dat');
		wallet.encrypt(PASSPHRASE);
		wallet.unlock(PASSPHRASE);
		fs.copyFileSync(file, `${file}.2000.backup`); // still opens with the old passphrase

		expect(() => wallet.changePassphrase('wrong passphrase', 'a new passphrase')).toThrow('wrong passphrase');
		expect(() => wallet.changePassphrase(PASSPHRASE, 'short')).toThrow('at least 8 characters');
		wallet.changePassphrase(PASSPHRASE, 'a new passphrase');

		expect(wallet.isLocked()).toBe(false); // was unlocked, still is
		expect(fs.existsSync(`${file}.2000.backup`)).toBe(false);
		const reopened = new Wallet(file);
		expect(() => reopened.unlock(PASSPHRASE)).toThrow('wrong passphrase');
		reopened.unlock('a new passphrase');
		expect(reopened.isLocked()).toBe(false);
		expect(() => openWallet(dir, 'plain').changePassphrase(PASSPHRASE, 'a new passphrase')).toThrow('not encrypted');
	});

	it('should import an encrypted wallet and keep it locked', () => {
		const wallet = openWallet(dir, 'node');
		wallet.encrypt(PASSPHRASE);

		const imported = Wallet.importWallet(path.join(dir, 'node.dat'), path.join(dir, 'copy.dat'));

		expect(imported.address).toBe(wallet.address);
		expect(imported.isLocked()).toBe(true);
		imported.unlock(PASSPHRASE);
		expect(imported.isLocked()).toBe(false);
	});

	it('should stake only while unlocked, and not spend when unlocked for staking only', async () => {
		useTestClock();
		const staker = openWallet(dir, 'staker');
		const chain = openPosChain(dir);
		await finishPowPhase(chain, staker.address);
		staker.encrypt(PASSPHRASE);

		expect(chain.createStakeBlock(staker, nextStakeTime(chain))).toBeNull();
		await expect(new StakingService(chain, staker).tryStake()).resolves.toBeNull();

		staker.unlock(PASSPHRASE, { stakingOnly: true });
		await expect(chain.addMinedBlock(findStakeBlock(chain, staker))).resolves.toBe('connected');
		expect(() => chain.createPayment(staker, [{ address: staker.address, amount: COIN }])).toThrow(
			'unlocked for staking only',
		);

		staker.unlock(PASSPHRASE); // full unlock
		expect(chain.createPayment(staker, [{ address: staker.address, amount: COIN }]).transaction.isValid()).toBe(true);
	});
});
