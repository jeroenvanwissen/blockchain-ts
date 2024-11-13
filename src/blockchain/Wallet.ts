import * as crypto from 'crypto';
import * as secp256k1 from 'secp256k1';
import * as fs from 'fs';
import * as path from 'path';
import { RIPEMD160 } from 'crypto-js';
import { Transaction } from './Transaction';

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

		// Generate address (Bitcoin-style)
		const sha256Hash = Buffer.from(
			crypto.createHash('sha256').update(this.publicKey).digest()
		);
		const ripemdHash = RIPEMD160(sha256Hash.toString('hex')).toString();
		// Ensure ripemdHash is a valid hex string before creating Buffer
		const ripemdBuffer = Buffer.from(ripemdHash.replace('0x', ''), 'hex');
		this.address = this.encodeAddress(ripemdBuffer);

		this.saveWallet();
	}

	private loadWallet(): void {
		const data: WalletData = JSON.parse(
			fs.readFileSync(this.walletPath, 'utf8')
		);
		this.privateKey = Buffer.from(data.privateKey, 'hex');
		this.publicKey = Buffer.from(data.publicKey, 'hex');
		this.address = data.address;
		this.transactions = data.transactions;
		this.utxos = data.utxos || [];
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
		}

		fs.writeFileSync(this.walletPath, JSON.stringify(data, null, 2));
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
							(sum, out) =>
								out.address !== this.address ? sum + out.amount : sum,
							0
						)
					: tx.outputs.reduce(
							(sum, out) =>
								out.address === this.address ? sum + out.amount : sum,
							0
						),
			otherParty,
		});

		const txHash = tx.calculateHash();

		// Update UTXOs
		if (type === 'sent') {
			// Remove spent UTXOs
			const spentUtxos = new Set(tx.inputs.map((input) => input.previousTx));
			this.utxos = this.utxos.filter((utxo) => !spentUtxos.has(utxo.txHash));

			// Add change output if any
			tx.outputs.forEach((output, index) => {
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
			tx.outputs.forEach((output, index) => {
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
	}

	static importWallet(importPath: string, targetPath?: string): Wallet {
		const wallet = new Wallet(targetPath);
		const importedData = JSON.parse(fs.readFileSync(importPath, 'utf8'));

		// Validate imported data
		if (
			!importedData.privateKey ||
			!importedData.publicKey ||
			!importedData.address
		) {
			throw new Error('Invalid wallet file');
		}

		fs.copyFileSync(importPath, wallet.walletPath);
		wallet.loadWallet();
		return wallet;
	}

	private encodeAddress(hash: Buffer): string {
		// Add version byte (0x00 for mainnet)
		const versionHash = Buffer.concat([Buffer.from([0x00]), hash]);

		// Add checksum
		const checksum = Buffer.from(
			crypto.createHash('sha256').update(versionHash).digest()
		);

		// Encode in base58
		return this.base58Encode(Buffer.concat([versionHash, checksum]));
	}

	signTransaction(tx: Transaction): void {
		tx.inputs.forEach((input) => {
			const msgHash = Buffer.from(
				crypto.createHash('sha256').update(tx.calculateHash()).digest()
			);

			const signature = secp256k1.ecdsaSign(msgHash, this.privateKey);
			input.signature = Buffer.from(signature.signature).toString('hex');
			// Removed input.publicKey = this.publicKey.toString('hex'); // Ensure public key is set
		});
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
