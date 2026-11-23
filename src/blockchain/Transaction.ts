import * as crypto from 'crypto';
import { MAX_TRANSACTION_INPUTS, MAX_TRANSACTION_OUTPUTS } from '../config.js';
import { secp256k1 } from './secp256k1.js';

export interface TxInput {
	previousTx: string; // txid of the transaction being spent (64 hex chars)
	outputIndex: number; // index of the spent output; block height for a coinbase input
	publicKey: string; // compressed secp256k1 public key (66 hex chars), empty for coinbase
	signature: string; // compact ECDSA signature r||s (128 hex chars), empty for coinbase
}

export interface TxOutput {
	address: string; // recipient address
	amount: bigint; // base units (see COIN in config.ts)
}

/** JSON wire form: amounts are decimal strings because JSON has no bigint. */
export interface SerializedTransaction {
	version: number;
	timestamp: number;
	inputs: TxInput[];
	outputs: { address: string; amount: string }[];
}

export const TX_VERSION = 1;
export const NULL_HASH = '0'.repeat(64);

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const HEX_PATTERN = /^(?:[0-9a-f]{2})*$/;
const AMOUNT_PATTERN = /^\d{1,20}$/;
const MAX_UINT32 = 0xffffffff;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_ADDRESS_LENGTH = 128;

function sha256d(data: Buffer): Buffer {
	const first = crypto.createHash('sha256').update(data).digest();
	return crypto.createHash('sha256').update(first).digest();
}

/** Minimal little-endian writer for the canonical transaction encoding. */
class ByteWriter {
	private readonly _parts: Buffer[] = [];

	u8(value: number): void {
		this._parts.push(Buffer.from([value]));
	}

	u16(value: number): void {
		const b = Buffer.alloc(2);
		b.writeUInt16LE(value);
		this._parts.push(b);
	}

	u32(value: number): void {
		const b = Buffer.alloc(4);
		b.writeUInt32LE(value);
		this._parts.push(b);
	}

	u64(value: bigint): void {
		const b = Buffer.alloc(8);
		b.writeBigUInt64LE(value);
		this._parts.push(b);
	}

	bytes(value: Buffer): void {
		this._parts.push(value);
	}

	toBuffer(): Buffer {
		return Buffer.concat(this._parts);
	}
}

export class Transaction {
	public version: number;
	public inputs: TxInput[];
	public outputs: TxOutput[];
	public timestamp: number;

	constructor(
		inputs: TxInput[],
		outputs: TxOutput[],
		timestamp: number = Date.now(),
		version: number = TX_VERSION,
	) {
		this.inputs = inputs;
		this.outputs = outputs;
		this.timestamp = timestamp;
		this.version = version;
	}

	/**
	 * Coinbase: one null input whose outputIndex carries the block height, which keeps
	 * coinbase txids unique across blocks.
	 */
	static coinbase(address: string, amount: bigint, height: number, timestamp = Date.now()): Transaction {
		return new Transaction(
			[{ previousTx: NULL_HASH, outputIndex: height, publicKey: '', signature: '' }],
			[{ address, amount }],
			timestamp,
		);
	}

	/** Serialized size in bytes, witness included (what fees are charged on). */
	size(): number {
		return this.serialize(true).length;
	}

	/**
	 * Canonical encoding. Without witness data (public keys and signatures) it defines the
	 * txid, so signing never changes a transaction's id. Throws on values that can't be encoded.
	 */
	serialize(includeWitness = true): Buffer {
		const w = new ByteWriter();
		w.u32(this.version);
		w.u64(BigInt(this.timestamp));
		w.u32(this.inputs.length);
		for (const input of this.inputs) {
			if (!HASH_PATTERN.test(input.previousTx)) {
				throw new Error('invalid previous transaction hash');
			}
			w.bytes(Buffer.from(input.previousTx, 'hex'));
			w.u32(input.outputIndex);
		}
		w.u32(this.outputs.length);
		for (const output of this.outputs) {
			if (output.amount < 0n || output.amount > MAX_UINT64) {
				throw new Error('output amount out of range');
			}
			const address = Buffer.from(output.address, 'utf8');
			w.u64(output.amount);
			w.u16(address.length);
			w.bytes(address);
		}
		if (includeWitness) {
			for (const input of this.inputs) {
				for (const field of [input.publicKey, input.signature]) {
					if (!HEX_PATTERN.test(field) || field.length > 510) {
						throw new Error('invalid witness encoding');
					}
					const bytes = Buffer.from(field, 'hex');
					w.u8(bytes.length);
					w.bytes(bytes);
				}
			}
		}
		return w.toBuffer();
	}

	/** txid: double SHA-256 of the transaction without public keys and signatures. */
	calculateHash(): string {
		return sha256d(this.serialize(false)).toString('hex');
	}

	/** Hash of the full transaction including witness data; blocks commit to this. */
	witnessHash(): string {
		return sha256d(this.serialize(true)).toString('hex');
	}

	/**
	 * Message signed for one input: commits to the txid and the input's position.
	 * Pass a precomputed `txid` when handling several inputs of one transaction.
	 */
	sighash(inputIndex: number, txid: string = this.calculateHash()): Buffer {
		const index = Buffer.alloc(4);
		index.writeUInt32LE(inputIndex);
		return sha256d(Buffer.concat([Buffer.from(txid, 'hex'), index]));
	}

	/** Sign every input with one key (single-key wallet). */
	signTransaction(privateKey: Buffer): void {
		const publicKey = Buffer.from(secp256k1.publicKeyCreate(privateKey, true)).toString('hex');
		const txid = this.calculateHash(); // signatures aren't part of the txid
		this.inputs.forEach((input, i) => {
			const { signature } = secp256k1.ecdsaSign(this.sighash(i, txid), privateKey);
			input.publicKey = publicKey;
			input.signature = Buffer.from(signature).toString('hex');
		});
	}

	/**
	 * Context-free check that input `i` carries a valid low-S signature by its own public key.
	 * Whether that key owns the spent output is checked against the UTXO set by the chain.
	 */
	verifyInputSignature(i: number, txid?: string): boolean {
		const input = this.inputs[i];
		if (!input || !/^[0-9a-f]{66}$/.test(input.publicKey) || !/^[0-9a-f]{128}$/.test(input.signature)) {
			return false;
		}
		try {
			return secp256k1.ecdsaVerify(
				Buffer.from(input.signature, 'hex'),
				this.sighash(i, txid ?? this.calculateHash()),
				Buffer.from(input.publicKey, 'hex'),
			);
		} catch {
			return false;
		}
	}

	isCoinbase(): boolean {
		return (
			this.inputs.length === 1 &&
			this.inputs[0].previousTx === NULL_HASH &&
			this.outputs.length === 1
		);
	}

	isCoinStake(): boolean {
		return (
			!this.isCoinbase() &&
			this.inputs.length > 0 &&
			this.outputs.length >= 2 &&
			this.outputs[0].amount === 0n
		);
	}

	/** Context-free validity: coinbase shape, or every input signed correctly. */
	isValid(): boolean {
		if (this.isCoinbase()) return true;
		if (this.inputs.length === 0) return false;
		let txid: string;
		try {
			txid = this.calculateHash();
		} catch {
			return false; // not canonically encodable
		}
		return this.inputs.every((_, i) => this.verifyInputSignature(i, txid));
	}

	/**
	 * Structure, then every input signature. `skipSignatures` is for callers that already
	 * verified the signatures of these exact bytes (the chain's signature cache).
	 */
	validate(skipSignatures = false): void {
		// Coinbase transactions are validated with their block
		if (this.isCoinbase()) return;

		if (this.inputs.length === 0) {
			throw new Error('transaction must have inputs');
		}
		if (this.outputs.length === 0) {
			throw new Error('transaction must have outputs');
		}
		if (this.inputs.length > MAX_TRANSACTION_INPUTS) {
			throw new Error('transaction exceeds maximum input count');
		}
		if (this.outputs.length > MAX_TRANSACTION_OUTPUTS) {
			throw new Error('transaction exceeds maximum output count');
		}

		for (const input of this.inputs) {
			if (!input.signature || !input.publicKey) {
				throw new Error('input missing signature');
			}
		}

		const inputKeys = new Set<string>();
		for (const input of this.inputs) {
			if (!HASH_PATTERN.test(input.previousTx)) {
				throw new Error('invalid previous transaction hash');
			}
			if (input.previousTx === NULL_HASH) {
				throw new Error('only a coinbase may spend the null outpoint');
			}
			const key = `${input.previousTx}:${input.outputIndex}`;
			if (inputKeys.has(key)) {
				throw new Error('duplicate input in transaction');
			}
			inputKeys.add(key);
		}

		// All output amounts must be positive, except the coinstake marker (first output, 0)
		const isCoinstake = this.isCoinStake();
		this.outputs.forEach((output, i) => {
			if (output.amount < 0n) {
				throw new Error('output has negative amount');
			}
			if (output.amount === 0n && !(isCoinstake && i === 0)) {
				throw new Error('output has zero amount');
			}
		});

		if (!skipSignatures) this.verifySignatures();
	}

	/** Every input's signature over its sighash, by the key it carries. */
	verifySignatures(): void {
		const txid = this.calculateHash();
		this.inputs.forEach((_, i) => {
			if (!this.verifyInputSignature(i, txid)) {
				throw new Error('invalid input signature');
			}
		});
	}

	toJSON(): SerializedTransaction {
		return {
			version: this.version,
			timestamp: this.timestamp,
			inputs: this.inputs.map((input) => ({ ...input })),
			outputs: this.outputs.map((o) => ({ address: o.address, amount: o.amount.toString() })),
		};
	}

	/** Parse and strictly validate the JSON wire form. Throws on anything malformed. */
	static fromJSON(data: unknown): Transaction {
		const fail = (what: string): never => {
			throw new Error(`malformed transaction: ${what}`);
		};
		if (typeof data !== 'object' || data === null) fail('not an object');
		const obj = data as Record<string, unknown>;
		if (!Number.isInteger(obj.version) || (obj.version as number) < 0) fail('version');
		if (!Number.isSafeInteger(obj.timestamp) || (obj.timestamp as number) < 0) fail('timestamp');
		if (!Array.isArray(obj.inputs) || obj.inputs.length > MAX_TRANSACTION_INPUTS) fail('inputs');
		if (!Array.isArray(obj.outputs) || obj.outputs.length > MAX_TRANSACTION_OUTPUTS) fail('outputs');

		const inputs = (obj.inputs as unknown[]).map((raw): TxInput => {
			const input = (typeof raw === 'object' && raw !== null ? raw : fail('input')) as Record<
				string,
				unknown
			>;
			const { previousTx, outputIndex, publicKey, signature } = input;
			if (typeof previousTx !== 'string' || !HASH_PATTERN.test(previousTx)) fail('input hash');
			if (
				!Number.isInteger(outputIndex) ||
				(outputIndex as number) < 0 ||
				(outputIndex as number) > MAX_UINT32
			) {
				fail('input index');
			}
			if (typeof publicKey !== 'string' || !/^(?:[0-9a-f]{66})?$/.test(publicKey)) fail('public key');
			if (typeof signature !== 'string' || !/^(?:[0-9a-f]{128})?$/.test(signature)) fail('signature');
			return {
				previousTx: previousTx as string,
				outputIndex: outputIndex as number,
				publicKey: publicKey as string,
				signature: signature as string,
			};
		});

		const outputs = (obj.outputs as unknown[]).map((raw): TxOutput => {
			const output = (typeof raw === 'object' && raw !== null ? raw : fail('output')) as Record<
				string,
				unknown
			>;
			const { address, amount } = output;
			if (typeof address !== 'string' || address.length === 0 || address.length > MAX_ADDRESS_LENGTH) {
				fail('address');
			}
			if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) fail('amount');
			const value = BigInt(amount as string);
			if (value > MAX_UINT64) fail('amount');
			return { address: address as string, amount: value };
		});

		return new Transaction(inputs, outputs, obj.timestamp as number, obj.version as number);
	}
}
