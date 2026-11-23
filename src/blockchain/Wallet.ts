import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import protobuf from 'protobufjs';
import { Transaction, type TxInput, type TxOutput } from './Transaction.js';
import { addressFromPublicKey } from './address.js';
import { WALLET_SCHEMA } from './protoSchemas.js';
import { secp256k1 } from './secp256k1.js';
import { DATA_DIR, MAX_WALLET_BACKUPS, WALLET_DATA_FILENAME } from '../config.js';

interface WalletTransaction {
	hash: string;
	timestamp: number;
	type: 'sent' | 'received';
	amount: bigint;
	otherParty: string;
}

interface UTXO {
	txHash: string;
	outputIndex: number;
	amount: bigint;
}

/** Decoded protobuf form: 64-bit fields arrive as decimal strings (longs: String). */
interface StoredWalletData {
	privateKey: Uint8Array;
	publicKey: Uint8Array;
	address: string;
	transactions: (Omit<WalletTransaction, 'amount' | 'timestamp'> & {
		amount: string;
		timestamp: string;
	})[];
	utxos: (Omit<UTXO, 'amount'> & { amount: string })[];
}

function decodeWalletData(buffer: Buffer): StoredWalletData {
	const WalletDataType = getWalletProto();
	const decoded = WalletDataType.decode(buffer as Uint8Array);
	return WalletDataType.toObject(decoded, { longs: String, arrays: true }) as StoredWalletData;
}

let _walletProtoRoot: protobuf.Root | null = null;
function getWalletProto(): protobuf.Type {
	if (!_walletProtoRoot) {
		_walletProtoRoot = protobuf.parse(WALLET_SCHEMA).root;
	}
	return _walletProtoRoot.lookupType('WalletData');
}

export class Wallet {
	private privateKey!: Buffer;
	public publicKey!: Buffer;
	public address!: string;

	private readonly walletPath: string;
	private transactions: WalletTransaction[] = [];
	private utxos: UTXO[] = [];

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

			this.transactions = (data.transactions || []).map((tx) => ({
				...tx,
				timestamp: Number(tx.timestamp),
				amount: BigInt(tx.amount),
			}));
			this.utxos = (data.utxos || []).map((utxo) => ({ ...utxo, amount: BigInt(utxo.amount) }));

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
		// 64-bit fields go in as decimal strings; fromObject converts them without precision loss
		const message = WalletDataType.fromObject({
			privateKey: this.privateKey,
			publicKey: this.publicKey,
			address: this.address,
			transactions: this.transactions.map((tx) => ({
				hash: tx.hash,
				timestamp: String(tx.timestamp),
				type: tx.type,
				amount: tx.amount.toString(),
				otherParty: tx.otherParty,
			})),
			utxos: this.utxos.map((utxo) => ({
				txHash: utxo.txHash,
				outputIndex: utxo.outputIndex,
				amount: utxo.amount.toString(),
			})),
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

	addTransaction(
		tx: Transaction,
		type: 'sent' | 'received',
		otherParty: string
	): void {
		// Add to transaction history
		this.transactions.push({
			hash: tx.calculateHash(),
			timestamp: tx.timestamp,
			type,
			amount:
				type === 'sent'
					? tx.outputs.reduce(
							(sum: bigint, out: TxOutput) =>
								out.address !== this.address ? sum + out.amount : sum,
							0n,
						)
					: tx.outputs.reduce(
							(sum: bigint, out: TxOutput) =>
								out.address === this.address ? sum + out.amount : sum,
							0n,
						),
			otherParty,
		});

		const txHash = tx.calculateHash();

		// Update UTXOs
		if (type === 'sent') {
			// Remove spent UTXOs
			const spentUtxos = new Set(
				tx.inputs.map((input: TxInput) => input.previousTx)
			);
			this.utxos = this.utxos.filter((utxo) => !spentUtxos.has(utxo.txHash));

			// Add change output if any
			tx.outputs.forEach((output: TxOutput, index: number) => {
				if (output.address === this.address) {
					this.utxos.push({
						txHash,
						outputIndex: index,
						amount: output.amount,
					});
				}
			});
		} else {
			// Add new UTXOs for received amounts
			tx.outputs.forEach((output: TxOutput, index: number) => {
				if (output.address === this.address) {
					this.utxos.push({
						txHash,
						outputIndex: index,
						amount: output.amount,
					});
				}
			});
		}

		this.saveWallet();
	}

	getBalance(): bigint {
		return this.utxos.reduce((sum, utxo) => sum + utxo.amount, 0n);
	}

	getAddress(): string {
		return this.address;
	}

	getSpendableOutputs(amount: bigint): { outputs: UTXO[]; total: bigint } {
		let total = 0n;
		const outputs: UTXO[] = [];

		// Sort UTXOs by amount (largest first) for efficient selection
		const sortedUtxos = [...this.utxos].sort((a, b) =>
			b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0,
		);

		for (const utxo of sortedUtxos) {
			total += utxo.amount;
			outputs.push(utxo);

			if (total >= amount) {
				break;
			}
		}

		if (total < amount) {
			throw new Error('Insufficient funds');
		}

		return { outputs, total };
	}

	getTransactionHistory(): WalletTransaction[] {
		return [...this.transactions].sort((a, b) => b.timestamp - a.timestamp);
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
