// HD wallet addresses (TASK-0041): receiving addresses from one seed, a watched lookahead, older
// single-key wallets upgraded in place, payments and staking across all addresses. Real files.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import protobuf from 'protobufjs';
import { Transaction } from '../../blockchain/Transaction.js';
import { Wallet } from '../../blockchain/Wallet.js';
import { addressFromPublicKey } from '../../blockchain/address.js';
import { WALLET_SCHEMA } from '../../blockchain/protoSchemas.js';
import { secp256k1 } from '../../blockchain/secp256k1.js';
import { COIN, COIN_MATURITY, POS_BLOCK_REWARD, POW_BLOCK_REWARD, WALLET_ADDRESS_LOOKAHEAD } from '../../config.js';
import {
	finishPowPhase,
	findStakeBlock,
	makeTempDir,
	mineBlocks,
	openChain,
	openPosChain,
	openWallet,
	removeTempDir,
	useTestClock,
} from './helpers.js';

const PASSPHRASE = 'correct horse battery';

/** A wallet file as versions before TASK-0041 wrote it: one key, optionally encrypted. */
function writeOlderWallet(file: string, privateKey: Buffer, passphrase?: string): string {
	const type = protobuf.parse(WALLET_SCHEMA).root.lookupType('WalletData');
	const publicKey = Buffer.from(secp256k1.publicKeyCreate(privateKey, true));
	const address = addressFromPublicKey(publicKey);
	const data: Record<string, unknown> = { publicKey, address };
	if (passphrase) {
		// TASK-0024's format: the key alone, with its public key as authenticated data
		const salt = crypto.randomBytes(16);
		const nonce = crypto.randomBytes(12);
		const key = crypto.scryptSync(passphrase.normalize('NFKC'), salt, 32, { N: 2 ** 10, r: 8, p: 1 });
		const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
		cipher.setAAD(publicKey);
		const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
		data.encryptedKey = { salt, nonce, ciphertext, authTag: cipher.getAuthTag(), scryptLogN: 10, scryptR: 8, scryptP: 1 };
	} else {
		data.privateKey = privateKey;
	}
	fs.writeFileSync(file, type.encode(type.fromObject(data)).finish());
	return address;
}

/** Sign a transaction whose inputs belong to `owners`; returns the address of each input's key. */
function signers(wallet: Wallet, owners: string[]): string[] {
	const tx = new Transaction(
		owners.map((_, i) => ({ previousTx: 'ab'.repeat(32), outputIndex: i, publicKey: '', signature: '' })),
		[{ address: wallet.address, amount: COIN }],
	);
	wallet.signTransaction(tx, 'spend', owners);
	tx.inputs.forEach((_, i) => expect(tx.verifyInputSignature(i)).toBe(true));
	return tx.inputs.map((input) => addressFromPublicKey(Buffer.from(input.publicKey, 'hex')));
}

describe('Wallet addresses', () => {
	let dir: string;

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
		jest.spyOn(console, 'log').mockImplementation(() => {});
		dir = makeTempDir();
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
		removeTempDir(dir);
	});

	it('should hand out new addresses that survive a restart and sign with their own keys', () => {
		const wallet = openWallet(dir, 'w');
		expect(wallet.issuedCount()).toBe(1);
		const issued = [wallet.newAddress(), wallet.newAddress()];

		expect(new Set([wallet.address, ...issued]).size).toBe(3);
		const reopened = openWallet(dir, 'w');
		expect(reopened.address).toBe(wallet.address);
		expect(reopened.issuedCount()).toBe(3);
		expect(reopened.addresses()).toHaveLength(3 + WALLET_ADDRESS_LOOKAHEAD);
		expect(reopened.listAddresses().filter((a) => a.issued).map((a) => a.address)).toEqual([wallet.address, ...issued]);
		expect(signers(reopened, [issued[1], wallet.address, issued[0]])).toEqual([issued[1], wallet.address, issued[0]]);
		expect(() => signers(reopened, [openWallet(dir, 'other').address])).toThrow('has no key for');
	});

	it('should still see addresses created after a backup was made (the lookahead)', () => {
		const wallet = openWallet(dir, 'w');
		const backup = path.join(dir, 'backup.dat');
		fs.copyFileSync(path.join(dir, 'w.dat'), backup);
		const later = Array.from({ length: 5 }, () => wallet.newAddress());

		const restored = new Wallet(backup);

		expect(restored.issuedCount()).toBe(1);
		for (const address of later) expect(restored.owns(address)).toBe(true);
		expect(signers(restored, [later[4]])).toEqual([later[4]]);
	});

	it('should hand out addresses while encrypted and locked, and sign for them once unlocked', () => {
		const wallet = openWallet(dir, 'w');
		wallet.encrypt(PASSPHRASE);

		const address = wallet.newAddress();

		const reopened = openWallet(dir, 'w');
		expect(reopened.isLocked()).toBe(true);
		expect(reopened.owns(address)).toBe(true);
		expect(reopened.issuedCount()).toBe(2);
		expect(() => signers(reopened, [address])).toThrow('wallet is locked');
		reopened.unlock(PASSPHRASE);
		expect(signers(reopened, [address, reopened.address])).toEqual([address, reopened.address]);
	});

	it('should upgrade an older unencrypted wallet on load and keep its key as the primary address', () => {
		const file = path.join(dir, 'old.dat');
		const oldAddress = writeOlderWallet(file, Buffer.alloc(32, 7));

		const wallet = new Wallet(file);
		const next = wallet.newAddress();

		expect(wallet.address).toBe(oldAddress);
		const reopened = new Wallet(file);
		expect(reopened.address).toBe(oldAddress);
		expect(reopened.issuedCount()).toBe(2);
		expect(signers(reopened, [oldAddress, next])).toEqual([oldAddress, next]);
	});

	it('should upgrade an older encrypted wallet at its first unlock', () => {
		const file = path.join(dir, 'old.dat');
		const oldAddress = writeOlderWallet(file, Buffer.alloc(32, 9), PASSPHRASE);

		const wallet = new Wallet(file);
		expect(wallet.address).toBe(oldAddress);
		expect(wallet.isLocked()).toBe(true);
		expect(wallet.addresses()).toEqual([oldAddress]);
		expect(() => wallet.newAddress()).toThrow('unlock the wallet once first');
		expect(() => wallet.unlock('wrong passphrase')).toThrow('wrong passphrase');

		wallet.unlock(PASSPHRASE);
		const next = wallet.newAddress();
		expect(signers(wallet, [oldAddress, next])).toEqual([oldAddress, next]);

		// Reopened: still encrypted under the same passphrase, and addresses work while locked
		const reopened = new Wallet(file);
		expect(reopened.isLocked()).toBe(true);
		expect(reopened.address).toBe(oldAddress);
		expect(reopened.owns(next)).toBe(true);
		const third = reopened.newAddress();
		reopened.unlock(PASSPHRASE);
		expect(signers(reopened, [third, oldAddress])).toEqual([third, oldAddress]);
	});

	it('should pay from several addresses, each input signed by its own key, change to the primary address', async () => {
		useTestClock();
		const chain = openChain(dir);
		const wallet = openWallet(dir, 'w');
		const second = wallet.newAddress();
		await mineBlocks(chain, wallet.address, 1);
		await mineBlocks(chain, second, 1);
		await mineBlocks(chain, openWallet(dir, 'miner').address, COIN_MATURITY);
		const to = openWallet(dir, 'to').address;

		const { transaction } = chain.createPayment(wallet, [{ address: to, amount: POW_BLOCK_REWARD + COIN }]);

		const keys = transaction.inputs.map((input) => addressFromPublicKey(Buffer.from(input.publicKey, 'hex')));
		expect(new Set(keys)).toEqual(new Set([wallet.address, second]));
		expect(transaction.outputs[1].address).toBe(wallet.address);
		await chain.addTransaction(transaction);
		await mineBlocks(chain, openWallet(dir, 'miner').address, 1);
		expect(chain.getBalance(to)).toBe(POW_BLOCK_REWARD + COIN);
		expect(chain.getBalance(second)).toBe(0n);
	});

	it('should stake with an output on a non-primary address, paying and signing with that address', async () => {
		useTestClock();
		const chain = openPosChain(dir);
		const wallet = openWallet(dir, 'w');
		const second = wallet.newAddress();
		await finishPowPhase(chain, second);

		const block = findStakeBlock(chain, wallet);

		expect(block.transactions[1].outputs.map((o) => o.address)).toEqual([second, second]);
		expect(block.transactions[0].outputs[0]).toEqual({ address: second, amount: POS_BLOCK_REWARD });
		await expect(chain.addMinedBlock(block)).resolves.toBe('connected');
		expect(chain.findLastStakedBlock(wallet.addresses())?.hash).toBe(block.hash);
		expect(chain.findLastStakedBlock([wallet.address])).toBeUndefined();
	});
});
