import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import protobuf from 'protobufjs';
import type { Transaction } from './Transaction.js';
import { addressFromPublicKey } from './address.js';
import { WALLET_SCHEMA } from './protoSchemas.js';
import { secp256k1 } from './secp256k1.js';
import { DATA_DIR, MAX_WALLET_BACKUPS, WALLET_DATA_FILENAME } from '../config.js';

/** Decoded protobuf form. Fields 4 and 5 (old history and UTXO lists) are skipped on load. */
interface StoredWalletData {
	privateKey: Uint8Array;
	publicKey: Uint8Array;
	address: string;
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

/**
 * The node's key pair, persisted as protobuf at `<data dir>/wallet.dat` (0600). Holds keys only:
 * balances and spendable outputs come from the chain's UTXO set (`Blockchain.getUTXOs`).
 */
export class Wallet {
	private privateKey!: Buffer;
	public publicKey!: Buffer;
	public address!: string;

	private readonly walletPath: string;

	constructor(walletPath?: string) {
		// saveWallet() creates the directory when needed
		this.walletPath = walletPath ?? path.join(DATA_DIR, WALLET_DATA_FILENAME);

		if (fs.existsSync(this.walletPath)) {
			this.loadWallet();
		} else {
			this.generateNewWallet();
		}
	}

	private generateNewWallet(): void {
		// Generate private key
		do {
			this.privateKey = crypto.randomBytes(32);
		} while (!secp256k1.privateKeyVerify(this.privateKey));

		this.publicKey = Buffer.from(secp256k1.publicKeyCreate(this.privateKey, true));
		this.address = addressFromPublicKey(this.publicKey);

		this.saveWallet();
	}

	signTransaction(tx: Transaction): void {
		tx.signTransaction(this.privateKey);
	}

	/** Compact low-S ECDSA signature (hex) over a 32-byte digest, e.g. a PoS block hash. */
	signDigest(digest: Buffer): string {
		return Buffer.from(secp256k1.ecdsaSign(digest, this.privateKey).signature).toString('hex');
	}

	private loadWallet(): void {
		let fileBuffer: Buffer;
		try {
			fileBuffer = fs.readFileSync(this.walletPath) as Buffer;
		} catch (error) {
			console.error('[Wallet] failed to read wallet file:', error);
			console.log('[Wallet] generating new wallet');
			this.generateNewWallet();
			return;
		}

		let data: StoredWalletData;
		try {
			data = decodeWalletData(fileBuffer);
		} catch (error) {
			console.error('[Wallet] wallet file is corrupted (invalid protobuf):', error);
			console.log('[Wallet] generating new wallet');
			this.generateNewWallet();
			return;
		}

		if (!data.privateKey || !data.publicKey || !data.address) {
			console.error('[Wallet] wallet file is missing required fields');
			console.log('[Wallet] generating new wallet');
			this.generateNewWallet();
			return;
		}

		try {
			this.privateKey = Buffer.from(data.privateKey);
			this.publicKey = Buffer.from(data.publicKey);

			// Validate that private key produces the stored public key
			if (!secp256k1.privateKeyVerify(this.privateKey)) {
				throw new Error('invalid private key');
			}
			const derivedPublicKey = Buffer.from(
				secp256k1.publicKeyCreate(this.privateKey, true)
			);
			if (!derivedPublicKey.equals(this.publicKey)) {
				throw new Error('public key does not match private key');
			}

			// The address is always derived from the key; re-save wallets written with an older
			// derivation so the file matches what the node uses
			this.address = addressFromPublicKey(this.publicKey);
			if (data.address !== this.address) {
				console.log('[Wallet] address re-derived from public key');
				this.saveWallet();
			}
		} catch (error) {
			console.error('[Wallet] wallet file contains invalid key data:', error);
			console.log('[Wallet] generating new wallet');
			this.generateNewWallet();
		}
	}

	private saveWallet(): void {
		const WalletDataType = getWalletProto();
		const message = WalletDataType.fromObject({
			privateKey: this.privateKey,
			publicKey: this.publicKey,
			address: this.address,
		});
		const buffer = WalletDataType.encode(message).finish();

		// Ensure the directory exists
		const dir = path.dirname(this.walletPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		// Create backup of existing file if it exists
		if (fs.existsSync(this.walletPath)) {
			const backup = `${this.walletPath}.${Date.now()}.backup`;
			fs.copyFileSync(this.walletPath, backup);
			this.pruneBackups();
		}

		fs.writeFileSync(this.walletPath, buffer);
		try {
			fs.chmodSync(this.walletPath, 0o600);
		} catch (error) {
			console.error('[Wallet] failed to set file permissions:', error);
		}
	}

	private pruneBackups(): void {
		const dir = path.dirname(this.walletPath);
		const baseName = path.basename(this.walletPath);
		try {
			const backups = fs.readdirSync(dir)
				.filter((f) => f.startsWith(baseName + '.') && f.endsWith('.backup'))
				.sort();

			while (backups.length > MAX_WALLET_BACKUPS) {
				const oldest = backups.shift()!;
				fs.unlinkSync(path.join(dir, oldest));
			}
		} catch (error) {
			console.error('[Wallet] failed to prune backups:', error);
		}
	}

	getAddress(): string {
		return this.address;
	}

	exportWallet(exportPath: string): void {
		fs.copyFileSync(this.walletPath, exportPath);
		try {
			fs.chmodSync(exportPath, 0o600);
		} catch (error) {
			console.error('[Wallet] failed to set export file permissions:', error);
		}
	}

	static importWallet(importPath: string, targetPath?: string): Wallet {
		let importedData: StoredWalletData;
		try {
			importedData = decodeWalletData(fs.readFileSync(importPath) as Buffer);
		} catch {
			throw new Error('failed to read or parse import file');
		}

		// Validate required fields
		if (
			!importedData.privateKey ||
			!importedData.publicKey ||
			!importedData.address
		) {
			throw new Error('invalid wallet file: missing required fields');
		}

		// Cryptographically validate that public key matches private key
		const privateKeyBuf = Buffer.from(importedData.privateKey);
		if (!secp256k1.privateKeyVerify(privateKeyBuf)) {
			throw new Error('invalid wallet file: invalid private key');
		}
		const derivedPublicKey = Buffer.from(
			secp256k1.publicKeyCreate(privateKeyBuf, true)
		);
		const storedPublicKey = Buffer.from(importedData.publicKey);
		if (!derivedPublicKey.equals(storedPublicKey)) {
			throw new Error('invalid wallet file: public key does not match private key');
		}

		const destination = targetPath ?? path.join(DATA_DIR, WALLET_DATA_FILENAME);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(importPath, destination);
		return new Wallet(destination);
	}
}
