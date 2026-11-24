import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import protobuf from 'protobufjs';
import type { Transaction } from './Transaction.js';
import { addressFromPublicKey } from './address.js';
import { entropyToMnemonic, MnemonicError, mnemonicToEntropy, mnemonicToSeed, mnemonicWords } from './bip39.js';
import {
	HARDENED,
	derivePath,
	derivePrivate,
	derivePublic,
	masterKey,
	neuter,
	type ExtendedPrivateKey,
	type ExtendedPublicKey,
} from './hd.js';
import { WALLET_SCHEMA } from './protoSchemas.js';
import { secp256k1 } from './secp256k1.js';
import {
	DATA_DIR,
	MAX_WALLET_ADDRESSES,
	MAX_WALLET_BACKUPS,
	MIN_PASSPHRASE_LENGTH,
	WALLET_ADDRESS_LOOKAHEAD,
	WALLET_DISCOVERY_GAP,
	WALLET_DATA_FILENAME,
	WALLET_SCRYPT,
} from '../config.js';
import { logger } from '../logger.js';

const log = logger('Wallet');

const SECRET_SIZE = 32; // the seed and a private key are 32 bytes each
const SEED_PHRASE_WORDS = 24; // 32 bytes of BIP39 entropy

/**
 * How the stored 32-byte seed becomes the BIP32 seed: 'bip39' entropy goes through its 24-word
 * phrase (PBKDF2, see bip39.ts); a 'raw' seed (wallets before TASK-0049) is used as it is.
 */
type SeedFormat = 'raw' | 'bip39';
const SEED_FORMAT_BIP39 = 1; // WalletData.seed_format

/** The wallet's secrets encrypted with a passphrase (see EncryptedKey in protoSchemas.ts). */
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
	privateKey?: Uint8Array; // single key of an older wallet; absent when encrypted
	publicKey?: Uint8Array;
	address?: string;
	encryptedKey?: EncryptedKey;
	seed?: Uint8Array; // absent when encrypted
	accountPublicKey?: Uint8Array;
	accountChainCode?: Uint8Array;
	receiveCount?: number;
	seedFormat?: number;
}

export type WalletErrorCode =
	| 'locked'
	| 'staking-only'
	| 'not-encrypted'
	| 'already-encrypted'
	| 'wrong-passphrase'
	| 'weak-passphrase'
	| 'no-seed-phrase';

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
	stakingOnly?: boolean; // the keys may sign stake blocks but not payments
}

/** An address the wallet holds the key for. */
export interface WalletAddress {
	address: string;
	index: number | null; // receiving index (m/0'/0/index); null for an older wallet's single key
	issued: boolean; // handed out (the primary address or newAddress); false: watched lookahead
}

/** Secrets in memory: always for an unencrypted wallet, only while unlocked for an encrypted one. */
interface Secrets {
	seed: Buffer;
	legacyKey: Buffer | null; // an older wallet's single key
	receiveChain: ExtendedPrivateKey; // m/0'/0
}

/** Validated wallet file contents. */
interface ParsedWallet {
	legacy: { publicKey: Buffer; privateKey: Buffer | null; storedAddress: string } | null;
	seed: Buffer | null; // unencrypted HD wallets
	account: ExtendedPublicKey | null; // null: an older wallet that has no seed yet
	encryptedKey: EncryptedKey | null;
	receiveCount: number;
	seedFormat: SeedFormat;
}

let _walletProtoRoot: protobuf.Root | null = null;
function getWalletProto(): protobuf.Type {
	if (!_walletProtoRoot) {
		_walletProtoRoot = protobuf.parse(WALLET_SCHEMA).root;
	}
	return _walletProtoRoot.lookupType('WalletData');
}

function decodeWalletData(buffer: Buffer): StoredWalletData {
	const WalletDataType = getWalletProto();
	return WalletDataType.toObject(WalletDataType.decode(buffer));
}

/** The account key m/0' and its receiving chain m/0'/0 for `seed`. */
function deriveAccount(seed: Buffer): { account: ExtendedPublicKey; receiveChain: ExtendedPrivateKey } {
	const master = masterKey(seed);
	const account = derivePath(master, [HARDENED]);
	const receiveChain = derivePath(account, [0]);
	const publicAccount = neuter(account);
	master.privateKey.fill(0);
	account.privateKey.fill(0);
	return { account: publicAccount, receiveChain };
}

/** The account and receiving chain for a stored seed in `format`. */
function deriveStored(stored: Buffer, format: SeedFormat): { account: ExtendedPublicKey; receiveChain: ExtendedPrivateKey } {
	if (format === 'raw') return deriveAccount(stored);
	const seed = mnemonicToSeed(entropyToMnemonic(stored));
	try {
		return deriveAccount(seed);
	} finally {
		seed.fill(0);
	}
}

/** Fresh BIP39 entropy whose account and receiving chain exist (all but ~2^-125 do). */
function newSeed(): Buffer {
	for (let attempt = 0; attempt < 8; attempt++) {
		const seed = crypto.randomBytes(SECRET_SIZE);
		try {
			deriveStored(seed, 'bip39').receiveChain.privateKey.fill(0);
			return seed;
		} catch {
			seed.fill(0);
		}
	}
	throw new Error('could not derive keys from a new seed'); // a bug, not bad luck
}

/** Field sizes and scrypt bounds; the parameters come from the file, so they are capped. */
function isWellFormed(e: EncryptedKey | undefined, ciphertextLength: number): e is EncryptedKey {
	return (
		!!e &&
		e.salt?.length === 16 &&
		e.nonce?.length === 12 &&
		e.ciphertext?.length === ciphertextLength &&
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

/** Decrypt and authenticate the secrets; a wrong passphrase fails the GCM tag check. */
function decryptSecrets(passphrase: string, e: EncryptedKey, aad: Buffer): Buffer {
	const key = deriveKey(passphrase, e);
	try {
		const decipher = crypto.createDecipheriv('aes-256-gcm', key, e.nonce);
		decipher.setAAD(aad);
		decipher.setAuthTag(e.authTag);
		return Buffer.concat([decipher.update(e.ciphertext), decipher.final()]);
	} catch {
		throw new WalletError('wrong-passphrase', 'wrong passphrase');
	} finally {
		key.fill(0);
	}
}

function bytes(value: Uint8Array | undefined): Buffer | null {
	return value && value.length > 0 ? Buffer.from(value) : null;
}

/** Check decoded wallet data; throws with the reason. Keys are checked, not just present. */
function parseWalletData(data: StoredWalletData): ParsedWallet {
	const encryptedKey = data.encryptedKey ?? null;
	const legacyPublicKey = bytes(data.publicKey);
	const accountPublicKey = bytes(data.accountPublicKey);
	if (!legacyPublicKey && !accountPublicKey) throw new Error('missing required fields');

	let legacy: ParsedWallet['legacy'] = null;
	if (legacyPublicKey) {
		const privateKey = bytes(data.privateKey);
		if (!data.address || (encryptedKey ? privateKey : !privateKey)) throw new Error('missing or conflicting fields');
		if (privateKey) {
			if (!secp256k1.privateKeyVerify(privateKey)) throw new Error('invalid private key');
			if (!Buffer.from(secp256k1.publicKeyCreate(privateKey, true)).equals(legacyPublicKey)) {
				throw new Error('public key does not match private key');
			}
		} else if (!secp256k1.publicKeyVerify(legacyPublicKey)) {
			throw new Error('invalid public key');
		}
		legacy = { publicKey: legacyPublicKey, privateKey, storedAddress: data.address };
	}

	let account: ExtendedPublicKey | null = null;
	const seed = bytes(data.seed);
	const formatCode = data.seedFormat ?? 0;
	if (formatCode !== 0 && formatCode !== SEED_FORMAT_BIP39) throw new Error('unknown seed format');
	const seedFormat: SeedFormat = formatCode === SEED_FORMAT_BIP39 ? 'bip39' : 'raw';
	if (seedFormat === 'bip39' && !accountPublicKey) throw new Error('seed format without an account key');
	if (accountPublicKey) {
		const chainCode = bytes(data.accountChainCode);
		if (!secp256k1.publicKeyVerify(accountPublicKey) || chainCode?.length !== 32) throw new Error('invalid account key');
		account = { publicKey: accountPublicKey, chainCode };
		if (encryptedKey ? seed : seed?.length !== SECRET_SIZE) throw new Error('missing or conflicting seed');
		if (seed) {
			const derived = deriveStored(seed, seedFormat);
			derived.receiveChain.privateKey.fill(0);
			if (!derived.account.publicKey.equals(accountPublicKey) || !derived.account.chainCode.equals(chainCode)) {
				throw new Error('seed does not match the account key');
			}
		}
	} else if (seed) {
		throw new Error('seed without an account key');
	}

	const receiveCount = data.receiveCount ?? 0;
	if (!Number.isInteger(receiveCount) || receiveCount < 0 || receiveCount > MAX_WALLET_ADDRESSES) throw new Error('invalid address count');
	if (encryptedKey) {
		const secrets = (account ? 1 : 0) + (legacy ? 1 : 0);
		if (!isWellFormed(encryptedKey, secrets * SECRET_SIZE)) throw new Error('malformed encrypted key');
	}
	return { legacy, seed: account ? seed : null, account, encryptedKey, receiveCount, seedFormat };
}

/**
 * The node's keys, persisted as protobuf at `<data dir>/wallet.dat` (0600). Holds keys only:
 * balances and spendable outputs come from the chain's UTXO set.
 *
 * An HD wallet (BIP32): receiving addresses are m/0'/0/i from one seed, so a backup covers
 * addresses created after it. The account's public key is stored, so new addresses can be
 * created while the wallet is locked. The wallet watches WALLET_ADDRESS_LOOKAHEAD addresses
 * past the ones it handed out; coins sent to them (say, after restoring an older backup) still
 * count. A wallet made before HD wallets keeps its single key as the primary address.
 *
 * An encrypted wallet (encrypt()) stores its secrets only encrypted and starts locked: nothing
 * can be signed until unlock(). It can be unlocked for a limited time and for staking only
 * (stake blocks, not payments). lock() wipes the secrets from memory.
 */
export class Wallet {
	/** The primary address: mining rewards and payment change go here. */
	public address!: string;
	public publicKey!: Buffer;

	private readonly walletPath: string;
	private _legacyPublicKey: Buffer | null = null;
	private _account: ExtendedPublicKey | null = null; // m/0'; null until an older wallet is upgraded
	private _seedFormat: SeedFormat = 'raw';
	private _receiveChain: ExtendedPublicKey | null = null; // m/0'/0
	private _receiveCount = 0; // receiving addresses handed out
	private _receive: (string | null)[] = []; // derived receiving addresses by index; null: skipped index
	private readonly _addresses = new Map<string, WalletAddress>();
	private readonly _scanned = new Map<number, string | null>(); // receiving addresses past the lookahead, by index
	private _secrets: Secrets | null = null; // null while locked
	private encryptedKey: EncryptedKey | null = null;
	private stakingOnly = false;
	private unlockedUntilMs: number | null = null;
	private relockTimer: NodeJS.Timeout | null = null;

	/** Load the wallet file, or create a new wallet there (from `restore`: Wallet.restore). */
	constructor(walletPath?: string, restore?: { entropy: Buffer; passphrase?: string }) {
		// saveWallet() creates the directory when needed
		this.walletPath = walletPath ?? path.join(DATA_DIR, WALLET_DATA_FILENAME);

		if (restore) {
			if (fs.existsSync(this.walletPath)) throw new Error(`${this.walletPath} already exists`);
			this.generateNewWallet(restore.entropy, restore.passphrase);
		} else if (fs.existsSync(this.walletPath)) {
			this.loadWallet();
		} else {
			this.generateNewWallet();
		}
	}

	/**
	 * Create a wallet file from a 24-word seed phrase (the node must be stopped). Never replaces
	 * an existing file. With a passphrase the wallet is encrypted before anything is written, and
	 * starts locked. Throws a MnemonicError for words that aren't a valid phrase.
	 */
	static restore(phrase: string, walletPath = path.join(DATA_DIR, WALLET_DATA_FILENAME), passphrase?: string): Wallet {
		const words = mnemonicWords(phrase);
		if (words.length !== SEED_PHRASE_WORDS) throw new MnemonicError(`expected ${SEED_PHRASE_WORDS} words, got ${words.length}`);
		if (fs.existsSync(walletPath)) {
			throw new Error(`${walletPath} already exists: move it away first (it may hold the keys to coins)`);
		}
		const entropy = mnemonicToEntropy(words.join(' '));
		try {
			return new Wallet(walletPath, { entropy, passphrase });
		} finally {
			entropy.fill(0);
		}
	}

	/** Whether a seed phrase restores this wallet: one created with BIP39 and without an older single key. */
	hasSeedPhrase(): boolean {
		return this._account !== null && this._seedFormat === 'bip39' && this._legacyPublicKey === null;
	}

	/**
	 * The 24-word seed phrase. An encrypted wallet needs its passphrase every time, also while
	 * unlocked, and stays locked or unlocked as it was.
	 */
	seedPhrase(passphrase?: string): string {
		if (!this.hasSeedPhrase()) {
			const reason = this._legacyPublicKey ? 'its primary address is an older single key' : 'it was created before seed phrases';
			throw new WalletError('no-seed-phrase', `this wallet has no seed phrase (${reason}): back up wallet.dat instead`);
		}
		if (!this.encryptedKey) return entropyToMnemonic(this._secrets!.seed);
		if (passphrase === undefined) throw new WalletError('wrong-passphrase', 'the wallet is encrypted: its passphrase is needed');
		const secrets = this.decrypt(passphrase);
		try {
			return entropyToMnemonic(secrets.seed);
		} finally {
			wipe(secrets);
		}
	}

	/**
	 * Look for receiving addresses with transactions past the ones handed out, up to `gap` unused
	 * ones in a row (further than the watched lookahead), and treat every address up to the last
	 * one found as handed out. A restored wallet (or one from an older backup) finds its
	 * addresses this way as the chain arrives. Returns how many addresses were added.
	 */
	discoverUsedAddresses(isUsed: (address: string) => boolean, gap = WALLET_DISCOVERY_GAP): number {
		if (!this._receiveChain) return 0;
		let last = -1;
		for (let index = this._receiveCount, unused = 0; unused < gap && index < MAX_WALLET_ADDRESSES; index++) {
			const address = this._receiveAddress(index);
			if (address && isUsed(address)) {
				last = index;
				unused = 0;
			} else {
				unused++;
			}
		}
		if (last < 0) return 0;
		const added = last + 1 - this._receiveCount;
		this._receiveCount = last + 1;
		this.extendAddresses();
		this.saveWallet({ backup: false }); // only the address count changed
		return added;
	}

	/** Receiving address `index`, also past the lookahead (cached; null where BIP32 skips). */
	private _receiveAddress(index: number): string | null {
		if (index < this._receive.length) return this._receive[index];
		let address = this._scanned.get(index);
		if (address === undefined) {
			const child = derivePublic(this._receiveChain!, index);
			address = child && addressFromPublicKey(child.publicKey);
			this._scanned.set(index, address);
		}
		return address;
	}

	isEncrypted(): boolean {
		return this.encryptedKey !== null;
	}

	/** Encrypted and not unlocked: nothing can be signed. */
	isLocked(): boolean {
		return this._secrets === null;
	}

	isStakingOnly(): boolean {
		return !this.isLocked() && this.stakingOnly;
	}

	/** When a timed unlock ends (ms), or null. */
	unlockedUntil(): number | null {
		return this.isLocked() ? null : this.unlockedUntilMs;
	}

	/** Every address the wallet holds a key for, including the watched lookahead. */
	addresses(): string[] {
		return [...this._addresses.keys()];
	}

	/** The addresses with their receiving index and whether they were handed out. */
	listAddresses(): WalletAddress[] {
		return [...this._addresses.values()].map((entry) => ({ ...entry }));
	}

	owns(address: string): boolean {
		return this._addresses.has(address);
	}

	/** Addresses handed out (the primary address and those from newAddress). */
	issuedCount(): number {
		return (this._legacyPublicKey ? 1 : 0) + this._receiveCount;
	}

	/**
	 * Hand out the next receiving address. Needs no passphrase: it comes from the stored account
	 * public key. An older encrypted wallet must be unlocked once first, to add a seed.
	 */
	newAddress(): string {
		if (!this._receiveChain) {
			throw new WalletError('locked', 'unlock the wallet once first: it was made by an older version and needs a seed');
		}
		if (this._receiveCount >= MAX_WALLET_ADDRESSES) throw new Error(`the wallet has ${MAX_WALLET_ADDRESSES} addresses already`);
		const address = this._issue();
		this.saveWallet({ backup: false }); // only the address count changed
		return address;
	}

	/**
	 * Sign each input of a payment ('spend') or coinstake ('stake') with the key of the address
	 * that owns the output it spends: `owners[i]` (default: the primary address). Throws a
	 * WalletError when signing isn't allowed.
	 */
	signTransaction(tx: Transaction, purpose: 'spend' | 'stake' = 'spend', owners: readonly string[] = []): void {
		const txid = tx.calculateHash();
		tx.inputs.forEach((_, i) => {
			const key = this._privateKey(owners[i] ?? this.address, purpose);
			try {
				tx.signInput(i, key, txid);
			} finally {
				key.fill(0);
			}
		});
	}

	/** Compact low-S ECDSA signature (hex) by `owner`'s key over a 32-byte digest: a PoS block hash. */
	signDigest(digest: Buffer, owner: string = this.address): string {
		const key = this._privateKey(owner, 'stake');
		try {
			return Buffer.from(secp256k1.ecdsaSign(digest, key).signature).toString('hex');
		} finally {
			key.fill(0);
		}
	}

	/**
	 * Encrypt the secrets with `passphrase`, rewrite the wallet file, delete the backups (they
	 * hold the secrets unencrypted) and lock. Unlock to stake or send again.
	 */
	encrypt(passphrase: string): void {
		if (this.encryptedKey) throw new WalletError('already-encrypted', 'wallet is already encrypted');
		this.encryptedKey = this.encryptSecrets(this.secrets('spend'), passphrase);
		this.saveWallet({ backup: false });
		const removed = this.removeBackups();
		log.info(`wallet encrypted; removed ${removed} unencrypted backup(s)`);
		this.lock();
	}

	/**
	 * Re-encrypt the secrets under a new passphrase (fresh salt and nonce). The lock state doesn't
	 * change. Backups are deleted: they would still open with the old passphrase.
	 */
	changePassphrase(passphrase: string, newPassphrase: string): void {
		if (!this.encryptedKey) throw new WalletError('not-encrypted', 'wallet is not encrypted');
		const secrets = this.decrypt(passphrase);
		try {
			this.encryptedKey = this.encryptSecrets(secrets, newPassphrase);
		} finally {
			wipe(secrets);
		}
		this.saveWallet({ backup: false });
		const removed = this.removeBackups();
		log.info(`wallet passphrase changed; removed ${removed} backup(s) under the old passphrase`);
	}

	/** Decrypt the secrets into memory. Throws 'wrong-passphrase' or 'not-encrypted'. */
	unlock(passphrase: string, options: UnlockOptions = {}): void {
		if (!this.encryptedKey) throw new WalletError('not-encrypted', 'wallet is not encrypted');
		const secrets = this.decrypt(passphrase);
		this.lock();
		this._secrets = secrets;
		this.stakingOnly = options.stakingOnly === true;
		if (options.timeoutMs && options.timeoutMs > 0) {
			this.unlockedUntilMs = Date.now() + options.timeoutMs;
			this.relockTimer = setTimeout(() => this.lock(), options.timeoutMs);
			this.relockTimer.unref?.();
		}
	}

	/** Wipe the secrets from memory (encrypted wallets only). */
	lock(): void {
		if (!this.encryptedKey) throw new WalletError('not-encrypted', 'wallet is not encrypted');
		if (this.relockTimer) clearTimeout(this.relockTimer);
		this.relockTimer = null;
		if (this._secrets) wipe(this._secrets);
		this._secrets = null;
		this.stakingOnly = false;
		this.unlockedUntilMs = null;
	}

	/**
	 * Decrypt with `passphrase`. An older wallet without a seed gets one now, encrypted under the
	 * same passphrase, so it can hand out more addresses.
	 */
	private decrypt(passphrase: string): Secrets {
		const payload = decryptSecrets(passphrase, this.encryptedKey!, this.aad());
		try {
			let offset = 0;
			const take = () => Buffer.from(payload.subarray(offset, (offset += SECRET_SIZE)));
			const seed = this._account ? take() : null;
			const legacyKey = this._legacyPublicKey ? take() : null;
			if (legacyKey && !Buffer.from(secp256k1.publicKeyCreate(legacyKey, true)).equals(this._legacyPublicKey!)) {
				throw new Error('decrypted key does not match the wallet');
			}
			if (seed) {
				const { account, receiveChain } = deriveStored(seed, this._seedFormat);
				if (!account.publicKey.equals(this._account!.publicKey) || !account.chainCode.equals(this._account!.chainCode)) {
					throw new Error('decrypted seed does not match the wallet');
				}
				return { seed, legacyKey, receiveChain };
			}
			// Encrypt for the new account first: nothing changes if that fails
			const freshSeed = newSeed();
			const { account, receiveChain } = deriveStored(freshSeed, 'bip39');
			const secrets = { seed: freshSeed, legacyKey, receiveChain };
			const encryptedKey = this.encryptSecrets(secrets, passphrase, account);
			this._seedFormat = 'bip39';
			this.setAccount(account, 0);
			this.encryptedKey = encryptedKey;
			this.saveWallet({ backup: false });
			log.info('wallet upgraded: it can now hand out more addresses');
			return secrets;
		} finally {
			payload.fill(0);
		}
	}

	/** Give an older single-key wallet a seed; its key stays the primary address. */
	private addSeed(legacyKey: Buffer | null): Secrets {
		const seed = newSeed();
		const { account, receiveChain } = deriveStored(seed, 'bip39');
		this._seedFormat = 'bip39';
		this.setAccount(account, 0);
		return { seed, legacyKey, receiveChain };
	}

	/** Authenticated data for the encrypted secrets: the public keys they belong to. */
	private aad(account: ExtendedPublicKey | null = this._account): Buffer {
		return Buffer.concat([
			this._legacyPublicKey ?? Buffer.alloc(0),
			account?.publicKey ?? Buffer.alloc(0),
			account?.chainCode ?? Buffer.alloc(0),
		]);
	}

	/** Encrypt the secrets under `passphrase` (bound to `account`) and check that they decrypt. */
	private encryptSecrets(secrets: Secrets, passphrase: string, account = this._account): EncryptedKey {
		if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
			throw new WalletError('weak-passphrase', `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
		}
		const payload = Buffer.concat([secrets.seed, ...(secrets.legacyKey ? [secrets.legacyKey] : [])]);
		const params = {
			salt: crypto.randomBytes(16),
			scryptLogN: WALLET_SCRYPT.logN,
			scryptR: WALLET_SCRYPT.r,
			scryptP: WALLET_SCRYPT.p,
		};
		const key = deriveKey(passphrase, params);
		const nonce = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
		const aad = this.aad(account);
		cipher.setAAD(aad);
		const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
		key.fill(0);
		const encrypted: EncryptedKey = { ...params, nonce, ciphertext, authTag: cipher.getAuthTag() };
		// Prove the passphrase opens it before anything is written
		const check = decryptSecrets(passphrase, encrypted, aad);
		const matches = check.equals(payload);
		check.fill(0);
		payload.fill(0);
		if (!matches) throw new Error('wallet encryption check failed');
		return encrypted;
	}

	private secrets(purpose: 'spend' | 'stake'): Secrets {
		if (!this._secrets) throw new WalletError('locked', 'wallet is locked');
		if (purpose === 'spend' && this.stakingOnly) {
			throw new WalletError('staking-only', 'wallet is unlocked for staking only');
		}
		return this._secrets;
	}

	/** A copy of `address`'s private key; the caller wipes it. */
	private _privateKey(address: string, purpose: 'spend' | 'stake'): Buffer {
		const secrets = this.secrets(purpose);
		const entry = this._addresses.get(address);
		if (!entry) throw new Error(`the wallet has no key for ${address}`);
		if (entry.index === null) return Buffer.from(secrets.legacyKey!);
		return derivePrivate(secrets.receiveChain, entry.index)!.privateKey; // exists: its public key did
	}

	/** Set the account key and derive the receiving addresses for `receiveCount` plus the lookahead. */
	private setAccount(account: ExtendedPublicKey, receiveCount: number): void {
		const receiveChain = derivePublic(account, 0);
		if (!receiveChain) throw new Error('account has no receiving chain');
		this._account = account;
		this._receiveChain = receiveChain;
		this._receiveCount = receiveCount;
		this._receive = [];
		this.extendAddresses();
	}

	/** Derive receiving addresses up to the handed-out count plus the lookahead. */
	private extendAddresses(): void {
		const want = this._receiveCount + WALLET_ADDRESS_LOOKAHEAD;
		while (this._receive.length < want) {
			const index = this._receive.length;
			const child = derivePublic(this._receiveChain!, index);
			const address = child && addressFromPublicKey(child.publicKey);
			this._receive.push(address); // null: BIP32 skips this index
			if (address) this._addresses.set(address, { address, index, issued: index < this._receiveCount });
		}
		for (let index = 0; index < this._receiveCount; index++) {
			const address = this._receive[index];
			if (address) this._addresses.get(address)!.issued = true;
		}
	}

	/** Hand out the next receiving address (skipping indexes BIP32 skips). */
	private _issue(): string {
		for (;;) {
			const index = this._receiveCount++;
			this.extendAddresses();
			const address = this._receive[index];
			if (address) return address;
		}
	}

	/** The single key's address first (older wallets), otherwise the first receiving address. */
	private setPrimary(): void {
		if (this._legacyPublicKey) {
			this.publicKey = this._legacyPublicKey;
			this.address = addressFromPublicKey(this._legacyPublicKey);
			this._addresses.set(this.address, { address: this.address, index: null, issued: true });
			return;
		}
		if (this._receiveCount === 0) this._issue();
		const index = this._receive.findIndex((address, i) => address !== null && i < this._receiveCount);
		this.publicKey = derivePublic(this._receiveChain!, index)!.publicKey;
		this.address = this._receive[index]!;
	}

	/** A new wallet from fresh entropy or `entropy`; with `passphrase`, encrypted (and locked) before it is written. */
	private generateNewWallet(entropy?: Buffer, passphrase?: string): void {
		this.resetState();
		const seed = entropy ? Buffer.from(entropy) : newSeed();
		const { account, receiveChain } = deriveStored(seed, 'bip39');
		this._seedFormat = 'bip39';
		this._secrets = { seed, legacyKey: null, receiveChain };
		this.setAccount(account, 0);
		this.setPrimary();
		if (passphrase !== undefined) {
			this.encryptedKey = this.encryptSecrets(this._secrets, passphrase); // throws for a weak passphrase
			wipe(this._secrets);
			this._secrets = null;
		}
		this.saveWallet();
	}

	private resetState(): void {
		if (this._secrets) wipe(this._secrets);
		this._secrets = null;
		this.encryptedKey = null;
		this._legacyPublicKey = null;
		this._account = null;
		this._seedFormat = 'raw';
		this._receiveChain = null;
		this._receiveCount = 0;
		this._receive = [];
		this._addresses.clear();
		this._scanned.clear();
	}

	private loadWallet(): void {
		let parsed: ParsedWallet;
		try {
			parsed = parseWalletData(decodeWalletData(fs.readFileSync(this.walletPath)));
		} catch (error) {
			log.error('wallet file is unreadable or invalid:', error);
			log.warn('generating new wallet');
			this.generateNewWallet();
			return;
		}

		this.resetState();
		this.encryptedKey = parsed.encryptedKey;
		this._legacyPublicKey = parsed.legacy?.publicKey ?? null;
		this._seedFormat = parsed.seedFormat;
		// A new wallet always issues its first address; a count of 0 only means an older wallet
		if (parsed.account) this.setAccount(parsed.account, parsed.receiveCount);
		if (!parsed.encryptedKey) {
			const legacyKey = parsed.legacy?.privateKey ?? null;
			this._secrets = parsed.seed
				? { seed: parsed.seed, legacyKey, receiveChain: deriveStored(parsed.seed, parsed.seedFormat).receiveChain }
				: this.addSeed(legacyKey); // an older unencrypted wallet: upgraded now
		}
		this.setPrimary();

		// Re-save files that changed: an upgrade, or an address written by an older derivation
		const upgraded = !parsed.account && !parsed.encryptedKey;
		const issuedFirst = !this._legacyPublicKey && parsed.receiveCount === 0;
		if (upgraded) log.info('wallet upgraded: it can now hand out more addresses');
		if (parsed.legacy && parsed.legacy.storedAddress !== this.address) log.info('address re-derived from public key');
		if (upgraded || issuedFirst || (parsed.legacy && parsed.legacy.storedAddress !== this.address)) this.saveWallet();
	}

	/** Write the wallet file (0600) atomically; by default the previous file is kept as a backup. */
	private saveWallet(options: { backup?: boolean } = {}): void {
		const WalletDataType = getWalletProto();
		// An encrypted wallet never writes its secrets unencrypted, even while unlocked
		const plain = this.encryptedKey ? null : this._secrets;
		const message = WalletDataType.fromObject({
			privateKey: plain?.legacyKey ?? undefined,
			publicKey: this._legacyPublicKey ?? undefined,
			address: this._legacyPublicKey ? addressFromPublicKey(this._legacyPublicKey) : undefined,
			encryptedKey: this.encryptedKey ?? undefined,
			seed: plain?.seed,
			accountPublicKey: this._account?.publicKey,
			accountChainCode: this._account?.chainCode,
			receiveCount: this._receiveCount,
			seedFormat: this._account && this._seedFormat === 'bip39' ? SEED_FORMAT_BIP39 : undefined,
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

	/** Copy a wallet file into place after checking it (an encrypted one stays locked). */
	static importWallet(importPath: string, targetPath?: string): Wallet {
		let importedData: StoredWalletData;
		try {
			importedData = decodeWalletData(fs.readFileSync(importPath));
		} catch {
			throw new Error('failed to read or parse import file');
		}
		try {
			parseWalletData(importedData);
		} catch (error) {
			throw new Error(`invalid wallet file: ${(error as Error).message}`, { cause: error });
		}

		const destination = targetPath ?? path.join(DATA_DIR, WALLET_DATA_FILENAME);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(importPath, destination);
		return new Wallet(destination);
	}
}

function wipe(secrets: Secrets): void {
	secrets.seed.fill(0);
	secrets.legacyKey?.fill(0);
	secrets.receiveChain.privateKey.fill(0);
}
