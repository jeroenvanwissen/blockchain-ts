import * as crypto from 'crypto';
import * as secp256k1 from 'secp256k1';
import * as fs from 'fs';
import * as path from 'path';
import CryptoJS from 'crypto-js';
import { Transaction, type TxInput, type TxOutput } from './Transaction.js';
import { MAX_WALLET_BACKUPS } from '../config.js';

interface WalletData {
	privateKey: string;
	publicKey: string;
	address: string;
	transactions: {
		hash: string;
		timestamp: number;
		type: 'sent' | 'received';
		amount: number;
		otherParty: string;
	}[];
	utxos: {
		txHash: string;
		outputIndex: number;
		amount: number;
	}[];
}

interface UTXO {
	txHash: string;
	outputIndex: number;
	amount: number;
}

export class Wallet {
	private privateKey!: Buffer;
	public publicKey!: Buffer;
	public address!: string;

	private readonly walletPath: string;
	private transactions: WalletData['transactions'] = [];
	private utxos: UTXO[] = [];

	constructor(walletPath?: string) {
		// Default to data/wallet.json if no path provided
		if (!walletPath) {
			const dataDir = path.join(process.cwd(), 'data');
			// Create data directory if it doesn't exist
			if (!fs.existsSync(dataDir)) {
				fs.mkdirSync(dataDir, { recursive: true });
			}
			walletPath = path.join(dataDir, 'wallet.json');
		}
		this.walletPath = walletPath;

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

		// Generate public key
		this.publicKey = Buffer.from(secp256k1.publicKeyCreate(this.privateKey));

		// Rest of the method remains the same
		const sha256Hash = Buffer.from(
			crypto.createHash('sha256').update(this.publicKey).digest()
		);
		const ripemdHash = CryptoJS.RIPEMD160(
			sha256Hash.toString('hex')
		).toString();
		const ripemdBuffer = Buffer.from(ripemdHash.replace('0x', ''), 'hex');
		this.address = this.encodeAddress(ripemdBuffer);

		this.saveWallet();
	}

	signTransaction(tx: Transaction): void {
		tx.signTransaction(this.privateKey);
	}

	private loadWallet(): void {
		let rawData: string;
		try {
			rawData = fs.readFileSync(this.walletPath, 'utf8');
		} catch (error) {
			console.error('[Wallet] failed to read wallet file:', error);
			console.log('[Wallet] generating new wallet');
			this.generateNewWallet();
			return;
		}

		let data: WalletData;
		try {
			data = JSON.parse(rawData);
		} catch (error) {
			console.error('[Wallet] wallet file is corrupted (invalid JSON):', error);
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
			this.privateKey = Buffer.from(data.privateKey, 'hex');
			this.publicKey = Buffer.from(data.publicKey, 'hex');

			// Validate that private key produces the stored public key
			if (!secp256k1.privateKeyVerify(this.privateKey)) {
				throw new Error('invalid private key');
			}
			const derivedPublicKey = Buffer.from(
				secp256k1.publicKeyCreate(this.privateKey)
			);
			if (!derivedPublicKey.equals(this.publicKey)) {
				throw new Error('public key does not match private key');
			}

			this.address = data.address;
			this.transactions = data.transactions || [];
			this.utxos = data.utxos || [];
		} catch (error) {
			console.error('[Wallet] wallet file contains invalid key data:', error);
			console.log('[Wallet] generating new wallet');
			this.generateNewWallet();
		}
	}

	private saveWallet(): void {
		const data: WalletData = {
			privateKey: this.privateKey.toString('hex'),
			publicKey: this.publicKey.toString('hex'),
			address: this.address,
			transactions: this.transactions,
			utxos: this.utxos,
		};

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

		fs.writeFileSync(this.walletPath, JSON.stringify(data, null, 2));
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
							(sum: number, out: TxOutput) =>
								out.address !== this.address ? sum + out.amount : sum,
							0
						)
					: tx.outputs.reduce(
							(sum: number, out: TxOutput) =>
								out.address === this.address ? sum + out.amount : sum,
							0
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

	getBalance(): number {
		return this.utxos.reduce((sum, utxo) => sum + utxo.amount, 0);
	}

	getAddress(): string {
		return this.address;
	}

	getSpendableOutputs(amount: number): { outputs: UTXO[]; total: number } {
		let total = 0;
		const outputs: UTXO[] = [];

		// Sort UTXOs by amount (largest first) for efficient selection
		const sortedUtxos = [...this.utxos].sort((a, b) => b.amount - a.amount);

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

	getTransactionHistory(): WalletData['transactions'] {
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
		let importedData: WalletData;
		try {
			importedData = JSON.parse(fs.readFileSync(importPath, 'utf8'));
		} catch (error) {
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
		const privateKeyBuf = Buffer.from(importedData.privateKey, 'hex');
		if (!secp256k1.privateKeyVerify(privateKeyBuf)) {
			throw new Error('invalid wallet file: invalid private key');
		}
		const derivedPublicKey = Buffer.from(
			secp256k1.publicKeyCreate(privateKeyBuf)
		);
		const storedPublicKey = Buffer.from(importedData.publicKey, 'hex');
		if (!derivedPublicKey.equals(storedPublicKey)) {
			throw new Error('invalid wallet file: public key does not match private key');
		}

		fs.copyFileSync(importPath, targetPath || path.join(process.cwd(), 'data', 'wallet.json'));
		const wallet = new Wallet(targetPath);
		return wallet;
	}

	private encodeAddress(hash: Buffer): string {
		// Add version byte (0x00 for mainnet)
		const versionHash = Buffer.concat([Buffer.from([0x00]), hash]);

		// Add checksum (double-SHA256, first 4 bytes)
		const first = crypto.createHash('sha256').update(versionHash).digest();
		const second = crypto.createHash('sha256').update(first).digest();
		const checksum = second.subarray(0, 4);

		// Encode in base58
		return this.base58Encode(Buffer.concat([versionHash, checksum]));
	}

	// Add base58 encoding (simplified version)
	private base58Encode(buffer: Buffer): string {
		const ALPHABET =
			'123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
		let num = BigInt('0x' + buffer.toString('hex'));
		const base = BigInt(58);
		let result = '';

		while (num > 0) {
			const mod = Number(num % base);
			result = ALPHABET[mod] + result;
			num = num / base;
		}

		// Add leading zeros
		for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
			result = ALPHABET[0] + result;
		}

		return result;
	}
}
