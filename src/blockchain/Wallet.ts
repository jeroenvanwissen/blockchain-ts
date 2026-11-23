import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import protobuf from 'protobufjs';
import type { Transaction } from './Transaction.js';
import { addressFromPublicKey } from './address.js';
import { WALLET_SCHEMA } from './protoSchemas.js';
import { secp256k1 } from './secp256k1.js';
import {
	DATA_DIR,
	MAX_WALLET_BACKUPS,
	MIN_PASSPHRASE_LENGTH,
	WALLET_DATA_FILENAME,
	WALLET_SCRYPT,
} from '../config.js';
import { logger } from '../logger.js';

const log = logger('Wallet');

/** The private key encrypted with a passphrase (see EncryptedKey in protoSchemas.ts). */
interface EncryptedKey {
	salt: Uint8Array;
	nonce: Uint8Array;
	ciphertext: Uint8Array;
	authTag: Uint8Array;
	scryptLogN: number;
	scryptR: number;
	scryptP: number;
}

/** Decoded protobuf form. Fields 4 and 5 (old history and UTXO lists) are skipped on load. */
interface StoredWalletData {
	privateKey?: Uint8Array; // absent when encrypted
	publicKey?: Uint8Array;
	address?: string;
	encryptedKey?: EncryptedKey;
}

export type WalletErrorCode =
	| 'locked'
	| 'staking-only'
	| 'not-encrypted'
	| 'already-encrypted'
	| 'wrong-passphrase'
	| 'weak-passphrase';

/** Wallet state errors, with a code callers (the API) can map to a response. */
export class WalletError extends Error {
	constructor(
		readonly code: WalletErrorCode,
		message: string,
	) {
		super(message);
	}
}

export interface UnlockOptions {
	timeoutMs?: number; // lock again after this long; 0 or absent: until lock() or a restart
	stakingOnly?: boolean; // the key may sign stake blocks but not payments
}

function decodeWalletData(buffer: Buffer): StoredWalletData {
	const WalletDataType = getWalletProto();
	const decoded = WalletDataType.decode(buffer as Uint8Array);
	return WalletDataType.toObject(decoded) as StoredWalletData;
}

let _walletProtoRoot: protobuf.Root | null = null;
function getWalletProto(): protobuf.Type {
	if (!_walletProtoRoot) {
		_walletProtoRoot = protobuf.parse(WALLET_SCHEMA).root;
	}
	return _walletProtoRoot.lookupType('WalletData');
}

/** Field sizes and scrypt bounds; the parameters come from the file, so they are capped. */
function isWellFormed(e: EncryptedKey | undefined): e is EncryptedKey {
	return (
		!!e &&
		e.salt?.length === 16 &&
		e.nonce?.length === 12 &&
		e.ciphertext?.length === 32 &&
		e.authTag?.length === 16 &&
		Number.isInteger(e.scryptLogN) &&
		e.scryptLogN >= 10 &&
		e.scryptLogN <= 20 &&
		Number.isInteger(e.scryptR) &&
		e.scryptR >= 1 &&
		e.scryptR <= 32 &&
		Number.isInteger(e.scryptP) &&
		e.scryptP >= 1 &&
		e.scryptP <= 16
	);
}

function deriveKey(passphrase: string, e: Pick<EncryptedKey, 'salt' | 'scryptLogN' | 'scryptR' | 'scryptP'>): Buffer {
	const N = 2 ** e.scryptLogN;
	return crypto.scryptSync(passphrase.normalize('NFKC'), e.salt, 32, {
		N,
		r: e.scryptR,
		p: e.scryptP,
		maxmem: 256 * N * e.scryptR, // scrypt needs about 128·N·r bytes
	});
}

/** Decrypt and authenticate the private key; a wrong passphrase fails the GCM tag check. */
function decryptKey(passphrase: string, e: EncryptedKey, publicKey: Buffer): Buffer {
	const key = deriveKey(passphrase, e);
	try {
		const decipher = crypto.createDecipheriv('aes-256-gcm', key, e.nonce);
		decipher.setAAD(publicKey);
		decipher.setAuthTag(e.authTag);
		return Buffer.concat([decipher.update(e.ciphertext), decipher.final()]);
	} catch {
		throw new WalletError('wrong-passphrase', 'wrong passphrase');
	} finally {
		key.fill(0);
	}
}

/**
 * The node's key pair, persisted as protobuf at `<data dir>/wallet.dat` (0600). Holds keys only:
 * balances and spendable outputs come from the chain's UTXO set (`Blockchain.getUTXOs`).
 *
 * An encrypted wallet (encrypt()) stores the private key only encrypted and starts locked:
 * nothing can be signed until unlock(). It can be unlocked for a limited time and for staking
 * only (stake blocks, not payments). lock() wipes the key from memory.
 */
export class Wallet {
	private privateKey: Buffer | null = null; // null while locked
	public publicKey!: Buffer;
	public address!: string;

	private readonly walletPath: string;
	private encryptedKey: EncryptedKey | null = null;
	private stakingOnly = false;
	private unlockedUntilMs: number | null = null;
	private relockTimer: NodeJS.Timeout | null = null;

	constructor(walletPath?: string) {
		// saveWallet() creates the directory when needed
		this.walletPath = walletPath ?? path.join(DATA_DIR, WALLET_DATA_FILENAME);

		if (fs.existsSync(this.walletPath)) {
			this.loadWallet();
		} else {
			this.generateNewWallet();
		}
	}

	isEncrypted(): boolean {
		return this.encryptedKey !== null;
	}

	/** Encrypted and not unlocked: nothing can be signed. */
	isLocked(): boolean {
		return this.privateKey === null;
	}

	isStakingOnly(): boolean {
		return !this.isLocked() && this.stakingOnly;
	}

	/** When a timed unlock ends (ms), or null. */
	unlockedUntil(): number | null {
		return this.isLocked() ? null : this.unlockedUntilMs;
	}

	/** Sign a payment ('spend') or a coinstake ('stake'). Throws a WalletError when not allowed. */
	signTransaction(tx: Transaction, purpose: 'spend' | 'stake' = 'spend'): void {
		tx.signTransaction(this.key(purpose));
	}

	/** Compact low-S ECDSA signature (hex) over a 32-byte digest: a PoS block hash. */
	signDigest(digest: Buffer): string {
		return Buffer.from(secp256k1.ecdsaSign(digest, this.key('stake')).signature).toString('hex');
	}

	/**
	 * Encrypt the private key with `passphrase`, rewrite the wallet file, delete the backups
	 * (they hold the unencrypted key) and lock. Unlock to stake or send again.
	 */
	encrypt(passphrase: string): void {
		if (this.encryptedKey) throw new WalletError('already-encrypted', 'wallet is already encrypted');
		if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
			throw new WalletError('weak-passphrase', `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
		}
		const privateKey = this.key('spend');
		const params = {
			salt: crypto.randomBytes(16),
			scryptLogN: WALLET_SCRYPT.logN,
			scryptR: WALLET_SCRYPT.r,
			scryptP: WALLET_SCRYPT.p,
		};
		const key = deriveKey(passphrase, params);
		const nonce = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
		cipher.setAAD(this.publicKey);
		const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
		key.fill(0);
		const encrypted: EncryptedKey = { ...params, nonce, ciphertext, authTag: cipher.getAuthTag() };
		// Prove the passphrase opens it before the unencrypted key leaves the disk
		if (!decryptKey(passphrase, encrypted, this.publicKey).equals(privateKey)) {
			throw new Error('wallet encryption check failed');
		}

		this.encryptedKey = encrypted;
		this.saveWallet({ backup: false });
		const removed = this.removeBackups();
		log.info(`wallet encrypted; removed ${removed} unencrypted backup(s)`);
		this.lock();
	}

	/** Decrypt the key into memory. Throws 'wrong-passphrase' or 'not-encrypted'. */
	unlock(passphrase: string, options: UnlockOptions = {}): void {
		if (!this.encryptedKey) throw new WalletError('not-encrypted', 'wallet is not encrypted');
		const privateKey = decryptKey(passphrase, this.encryptedKey, this.publicKey);
		this.lock();
		this.privateKey = privateKey;
		this.stakingOnly = options.stakingOnly === true;
		if (options.timeoutMs && options.timeoutMs > 0) {
			this.unlockedUntilMs = Date.now() + options.timeoutMs;
			this.relockTimer = setTimeout(() => this.lock(), options.timeoutMs);
			this.relockTimer.unref?.();
		}
	}

	/** Wipe the key from memory (encrypted wallets only). */
	lock(): void {
		if (!this.encryptedKey) throw new WalletError('not-encrypted', 'wallet is not encrypted');
		if (this.relockTimer) clearTimeout(this.relockTimer);
		this.relockTimer = null;
		this.privateKey?.fill(0);
		this.privateKey = null;
		this.stakingOnly = false;
		this.unlockedUntilMs = null;
	}

	private key(purpose: 'spend' | 'stake'): Buffer {
		if (!this.privateKey) throw new WalletError('locked', 'wallet is locked');
		if (purpose === 'spend' && this.stakingOnly) {
			throw new WalletError('staking-only', 'wallet is unlocked for staking only');
		}
		return this.privateKey;
	}

	private generateNewWallet(): void {
		let privateKey: Buffer;
		do {
			privateKey = crypto.randomBytes(32);
		} while (!secp256k1.privateKeyVerify(privateKey));

		this.privateKey = privateKey;
		this.encryptedKey = null;
		this.publicKey = Buffer.from(secp256k1.publicKeyCreate(privateKey, true));
		this.address = addressFromPublicKey(this.publicKey);

		this.saveWallet();
	}

	private loadWallet(): void {
		let fileBuffer: Buffer;
		try {
			fileBuffer = fs.readFileSync(this.walletPath) as Buffer;
		} catch (error) {
			log.error('failed to read wallet file:', error);
			log.warn('generating new wallet');
			this.generateNewWallet();
			return;
		}

		let data: StoredWalletData;
		try {
			data = decodeWalletData(fileBuffer);
		} catch (error) {
			log.error('wallet file is corrupted (invalid protobuf):', error);
			log.warn('generating new wallet');
			this.generateNewWallet();
			return;
		}

		const isEncrypted = !!data.encryptedKey;
		if (!data.publicKey || !data.address || (isEncrypted ? data.privateKey?.length : !data.privateKey)) {
			log.error('wallet file has missing or conflicting fields');
			log.warn('generating new wallet');
			this.generateNewWallet();
			return;
		}

		try {
			this.publicKey = Buffer.from(data.publicKey);
			if (!secp256k1.publicKeyVerify(this.publicKey)) throw new Error('invalid public key');
			if (isEncrypted) {
				if (!isWellFormed(data.encryptedKey)) throw new Error('malformed encrypted key');
				this.encryptedKey = data.encryptedKey;
				this.privateKey = null; // locked until unlock()
			} else {
				const privateKey = Buffer.from(data.privateKey!);
				// Validate that the private key produces the stored public key
				if (!secp256k1.privateKeyVerify(privateKey)) {
					throw new Error('invalid private key');
				}
				const derivedPublicKey = Buffer.from(secp256k1.publicKeyCreate(privateKey, true));
				if (!derivedPublicKey.equals(this.publicKey)) {
					throw new Error('public key does not match private key');
				}
				this.privateKey = privateKey;
			}

			// The address is always derived from the key; re-save wallets written with an older
			// derivation so the file matches what the node uses
			this.address = addressFromPublicKey(this.publicKey);
			if (data.address !== this.address) {
				log.info('address re-derived from public key');
				this.saveWallet();
			}
		} catch (error) {
			log.error('wallet file contains invalid key data:', error);
			log.warn('generating new wallet');
			this.generateNewWallet();
		}
	}

	/** Write the wallet file (0600) atomically; by default the previous file is kept as a backup. */
	private saveWallet(options: { backup?: boolean } = {}): void {
		const WalletDataType = getWalletProto();
		const message = WalletDataType.fromObject({
			// An encrypted wallet never writes the key unencrypted, even while unlocked
			privateKey: this.encryptedKey ? undefined : this.privateKey,
			publicKey: this.publicKey,
			address: this.address,
			encryptedKey: this.encryptedKey ?? undefined,
		});
		const buffer = WalletDataType.encode(message).finish();

		// Ensure the directory exists
		const dir = path.dirname(this.walletPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		// Create backup of existing file if it exists
		if (fs.existsSync(this.walletPath) && options.backup !== false) {
			const backup = `${this.walletPath}.${Date.now()}.backup`;
			fs.copyFileSync(this.walletPath, backup);
			this.pruneBackups();
		}

		const temp = `${this.walletPath}.tmp`;
		fs.writeFileSync(temp, buffer, { mode: 0o600 });
		fs.renameSync(temp, this.walletPath);
		try {
			fs.chmodSync(this.walletPath, 0o600);
		} catch (error) {
			log.warn('failed to set file permissions:', error);
		}
	}

	private backupFiles(): string[] {
		const dir = path.dirname(this.walletPath);
		const baseName = path.basename(this.walletPath);
		return fs
			.readdirSync(dir)
			.filter((f) => f.startsWith(baseName + '.') && f.endsWith('.backup'))
			.sort()
			.map((f) => path.join(dir, f));
	}

	private pruneBackups(): void {
		try {
			const backups = this.backupFiles();
			while (backups.length > MAX_WALLET_BACKUPS) {
				fs.unlinkSync(backups.shift()!);
			}
		} catch (error) {
			log.warn('failed to prune backups:', error);
		}
	}

	/** Delete every backup; returns how many were removed. */
	private removeBackups(): number {
		const backups = this.backupFiles();
		for (const file of backups) fs.unlinkSync(file);
		return backups.length;
	}

	getAddress(): string {
		return this.address;
	}

	exportWallet(exportPath: string): void {
		fs.copyFileSync(this.walletPath, exportPath);
		try {
			fs.chmodSync(exportPath, 0o600);
		} catch (error) {
			log.warn('failed to set export file permissions:', error);
		}
	}

	static importWallet(importPath: string, targetPath?: string): Wallet {
		let importedData: StoredWalletData;
		try {
			importedData = decodeWalletData(fs.readFileSync(importPath) as Buffer);
		} catch {
			throw new Error('failed to read or parse import file');
		}

		const isEncrypted = !!importedData.encryptedKey;
		if (!importedData.publicKey || !importedData.address || (!isEncrypted && !importedData.privateKey)) {
			throw new Error('invalid wallet file: missing required fields');
		}

		if (isEncrypted) {
			// The key can't be checked without the passphrase; check the structure
			if (!isWellFormed(importedData.encryptedKey) || !secp256k1.publicKeyVerify(Buffer.from(importedData.publicKey))) {
				throw new Error('invalid wallet file: malformed encrypted key');
			}
		} else {
			// Cryptographically validate that public key matches private key
			const privateKeyBuf = Buffer.from(importedData.privateKey!);
			if (!secp256k1.privateKeyVerify(privateKeyBuf)) {
				throw new Error('invalid wallet file: invalid private key');
			}
			const derivedPublicKey = Buffer.from(secp256k1.publicKeyCreate(privateKeyBuf, true));
			const storedPublicKey = Buffer.from(importedData.publicKey);
			if (!derivedPublicKey.equals(storedPublicKey)) {
				throw new Error('invalid wallet file: public key does not match private key');
			}
		}

		const destination = targetPath ?? path.join(DATA_DIR, WALLET_DATA_FILENAME);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(importPath, destination);
		return new Wallet(destination);
	}
}
