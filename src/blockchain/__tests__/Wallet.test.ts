import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as secp256k1 from 'secp256k1';
import { Wallet } from '../Wallet.js';
import { MAX_WALLET_BACKUPS } from '../../config.js';

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
			parse: () => ({ root: { lookupType: () => mockType } }),
		},
	};
});

// Helper to generate a valid key pair
function generateKeyPair(): { privateKey: Buffer; publicKey: Buffer } {
	let privateKey: Buffer;
	do {
		privateKey = crypto.randomBytes(32);
	} while (!secp256k1.privateKeyVerify(privateKey));
	const publicKey = Buffer.from(secp256k1.publicKeyCreate(privateKey));
	return { privateKey, publicKey };
}

// Helper to create valid wallet data as a Buffer (protobuf mock uses JSON internally)
function createWalletBuffer(keyPair?: { privateKey: Buffer; publicKey: Buffer }): Buffer {
	const { privateKey, publicKey } = keyPair || generateKeyPair();
	return Buffer.from(JSON.stringify({
		privateKey: Array.from(privateKey),
		publicKey: Array.from(publicKey),
		address: '1TestAddress',
		transactions: [],
		utxos: [],
	}));
}

describe('Wallet', () => {
	const testPath = '/tmp/test-wallet.dat';

	beforeEach(() => {
		process.env.NODE_ENV = 'test';
		jest.clearAllMocks();

		// Default: wallet file does not exist (generate new)
		(fs.existsSync as jest.Mock).mockReturnValue(false);
		(fs.writeFileSync as jest.Mock).mockImplementation(() => {});
		(fs.chmodSync as jest.Mock).mockImplementation(() => {});
		(fs.mkdirSync as jest.Mock).mockImplementation(() => {});
		(fs.readdirSync as jest.Mock).mockReturnValue([]);
	});

	describe('constructor', () => {
		it('should generate a new wallet when file does not exist', () => {
			const wallet = new Wallet(testPath);
			expect(wallet.publicKey).toBeDefined();
			expect(wallet.address).toBeDefined();
			expect(fs.writeFileSync).toHaveBeenCalled();
		});

		it('should load existing wallet from file', () => {
			const keyPair = generateKeyPair();
			const walletBuffer = createWalletBuffer(keyPair);

			(fs.existsSync as jest.Mock).mockReturnValue(true);
			(fs.readFileSync as jest.Mock).mockReturnValue(walletBuffer);
			(fs.readdirSync as jest.Mock).mockReturnValue([]);

			const wallet = new Wallet(testPath);
			expect(wallet.publicKey.equals(keyPair.publicKey)).toBe(true);
		});
	});

	describe('corrupted wallet recovery', () => {
		it('should generate new wallet when file contains invalid data', () => {
			(fs.existsSync as jest.Mock).mockImplementation((...args: unknown[]) => {
				return args[0] === testPath;
			});
			(fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('not valid protobuf'));

			const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
			const wallet = new Wallet(testPath);
			consoleSpy.mockRestore();

			expect(wallet.publicKey).toBeDefined();
			expect(wallet.address).toBeDefined();
		});

		it('should generate new wallet when file is missing required fields', () => {
			(fs.existsSync as jest.Mock).mockImplementation((...args: unknown[]) => args[0] === testPath);
			(fs.readFileSync as jest.Mock).mockReturnValue(
				Buffer.from(JSON.stringify({ privateKey: Array.from(Buffer.from('abc')) }))
			);

			const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
			const wallet = new Wallet(testPath);
			consoleSpy.mockRestore();

			expect(wallet.publicKey).toBeDefined();
			expect(wallet.address).toBeDefined();
		});

		it('should generate new wallet when private key is invalid', () => {
			(fs.existsSync as jest.Mock).mockImplementation((...args: unknown[]) => args[0] === testPath);
			(fs.readFileSync as jest.Mock).mockReturnValue(
				Buffer.from(JSON.stringify({
					privateKey: Array.from(Buffer.alloc(32, 0)),
					publicKey: Array.from(Buffer.alloc(33, 0xff)),
					address: '1BadKeys',
					transactions: [],
					utxos: [],
				}))
			);

			const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
			const wallet = new Wallet(testPath);
			consoleSpy.mockRestore();

			expect(wallet.publicKey).toBeDefined();
			expect(wallet.address).toBeDefined();
		});

		it('should generate new wallet when public key does not match private key', () => {
			const keyPair1 = generateKeyPair();
			const keyPair2 = generateKeyPair();

			(fs.existsSync as jest.Mock).mockImplementation((...args: unknown[]) => args[0] === testPath);
			(fs.readFileSync as jest.Mock).mockReturnValue(
				Buffer.from(JSON.stringify({
					privateKey: Array.from(keyPair1.privateKey),
					publicKey: Array.from(keyPair2.publicKey),
					address: '1Mismatch',
					transactions: [],
					utxos: [],
				}))
			);

			const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
			const wallet = new Wallet(testPath);
			consoleSpy.mockRestore();

			// Should have generated fresh keys, not the mismatched ones
			expect(wallet.publicKey.equals(keyPair2.publicKey)).toBe(false);
		});

		it('should generate new wallet when file cannot be read', () => {
			(fs.existsSync as jest.Mock).mockImplementation((...args: unknown[]) => args[0] === testPath);
			(fs.readFileSync as jest.Mock).mockImplementation(() => {
				throw new Error('Permission denied');
			});

			const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
			const wallet = new Wallet(testPath);
			consoleSpy.mockRestore();

			expect(wallet.publicKey).toBeDefined();
			expect(wallet.address).toBeDefined();
		});
	});

	describe('file permissions', () => {
		it('should set 0600 permissions on wallet file after save', () => {
			const wallet = new Wallet(testPath);
			expect(fs.chmodSync).toHaveBeenCalledWith(testPath, 0o600);
		});

		it('should set 0600 permissions on exported wallet file', () => {
			(fs.existsSync as jest.Mock).mockReturnValue(false);
			(fs.copyFileSync as jest.Mock).mockImplementation(() => {});

			const wallet = new Wallet(testPath);
			wallet.exportWallet('/tmp/exported-wallet.dat');

			expect(fs.chmodSync).toHaveBeenCalledWith('/tmp/exported-wallet.dat', 0o600);
		});
	});

	describe('backup pruning', () => {
		it('should keep only the last 3 backups', () => {
			const backupFiles = [
				'test-wallet.dat.1000.backup',
				'test-wallet.dat.2000.backup',
				'test-wallet.dat.3000.backup',
				'test-wallet.dat.4000.backup',
				'test-wallet.dat.5000.backup',
			];

			// Wallet file exists for backup creation
			let existsSyncCallCount = 0;
			(fs.existsSync as jest.Mock).mockImplementation(() => {
				existsSyncCallCount++;
				// First call is constructor check (file exists to trigger loadWallet)
				// We want it to NOT exist so generateNewWallet is called
				// Then in saveWallet, existsSync checks for backup: return true
				return existsSyncCallCount > 1;
			});
			(fs.readdirSync as jest.Mock).mockReturnValue(backupFiles);
			(fs.unlinkSync as jest.Mock).mockImplementation(() => {});
			(fs.copyFileSync as jest.Mock).mockImplementation(() => {});

			const wallet = new Wallet(testPath);

			const deletedCount = 5 - MAX_WALLET_BACKUPS;
			expect(fs.unlinkSync).toHaveBeenCalledTimes(deletedCount);
		});

		it('should not delete backups when count is within limit', () => {
			let existsSyncCallCount = 0;
			(fs.existsSync as jest.Mock).mockImplementation(() => {
				existsSyncCallCount++;
				return existsSyncCallCount > 1;
			});
			(fs.readdirSync as jest.Mock).mockReturnValue([
				'test-wallet.dat.1000.backup',
				'test-wallet.dat.2000.backup',
			]);
			(fs.copyFileSync as jest.Mock).mockImplementation(() => {});
			(fs.unlinkSync as jest.Mock).mockImplementation(() => {});

			const wallet = new Wallet(testPath);

			expect(fs.unlinkSync).not.toHaveBeenCalled();
		});
	});

	describe('importWallet', () => {
		it('should reject import when public key does not match private key', () => {
			const keyPair1 = generateKeyPair();
			const keyPair2 = generateKeyPair();

			(fs.readFileSync as jest.Mock).mockReturnValue(
				Buffer.from(JSON.stringify({
					privateKey: Array.from(keyPair1.privateKey),
					publicKey: Array.from(keyPair2.publicKey),
					address: '1Mismatch',
					transactions: [],
					utxos: [],
				}))
			);

			expect(() => {
				Wallet.importWallet('/tmp/import.dat', testPath);
			}).toThrow('public key does not match private key');
		});

		it('should reject import when file is not valid', () => {
			(fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('not valid'));

			expect(() => {
				Wallet.importWallet('/tmp/import.dat', testPath);
			}).toThrow('failed to read or parse import file');
		});

		it('should reject import when required fields are missing', () => {
			(fs.readFileSync as jest.Mock).mockReturnValue(
				Buffer.from(JSON.stringify({ privateKey: Array.from(Buffer.from('abc')) }))
			);

			expect(() => {
				Wallet.importWallet('/tmp/import.dat', testPath);
			}).toThrow('missing required fields');
		});

		it('should reject import with invalid private key', () => {
			(fs.readFileSync as jest.Mock).mockReturnValue(
				Buffer.from(JSON.stringify({
					privateKey: Array.from(Buffer.alloc(32, 0)),
					publicKey: Array.from(Buffer.alloc(33, 0xff)),
					address: '1Bad',
					transactions: [],
					utxos: [],
				}))
			);

			expect(() => {
				Wallet.importWallet('/tmp/import.dat', testPath);
			}).toThrow('invalid private key');
		});

		it('should accept import with valid matching keys', () => {
			const keyPair = generateKeyPair();
			const walletBuffer = createWalletBuffer(keyPair);

			// First readFileSync: import validation read
			// Second readFileSync: Wallet constructor loadWallet
			(fs.readFileSync as jest.Mock).mockReturnValue(walletBuffer);
			(fs.existsSync as jest.Mock).mockReturnValue(true);
			(fs.copyFileSync as jest.Mock).mockImplementation(() => {});
			(fs.readdirSync as jest.Mock).mockReturnValue([]);

			const wallet = Wallet.importWallet('/tmp/import.dat', testPath);
			expect(wallet.publicKey.equals(keyPair.publicKey)).toBe(true);
		});
	});
});
