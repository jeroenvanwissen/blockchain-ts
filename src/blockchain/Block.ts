import * as crypto from 'crypto';
import { NULL_HASH, Transaction, type SerializedTransaction } from './Transaction.js';
import { MAX_BLOCK_NONCE, MAX_BLOCK_TRANSACTIONS } from '../config.js';
import { bitsToTarget, blockWork, POW_LIMIT_BITS, targetHex } from './target.js';

export const BLOCK_VERSION = 1;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const HEADER_PREFIX_LENGTH = 4 + 32 + 32 + 8 + 4; // version, prev hash, merkle root, time, bits
const MAX_UINT32 = 0xffffffff;

function sha256d(data: Buffer): Buffer {
	const first = crypto.createHash('sha256').update(data).digest();
	return crypto.createHash('sha256').update(first).digest();
}

/** Merkle root over the transactions' witness hashes (odd levels duplicate the last node). */
export function merkleRoot(transactions: readonly Transaction[]): string {
	if (transactions.length === 0) return NULL_HASH;
	let level: Buffer[] = transactions.map((tx) => Buffer.from(tx.witnessHash(), 'hex'));
	while (level.length > 1) {
		const next: Buffer[] = [];
		for (let i = 0; i < level.length; i += 2) {
			next.push(sha256d(Buffer.concat([level[i], level[i + 1] ?? level[i]])));
		}
		level = next;
	}
	return level[0].toString('hex');
}

/** JSON wire form; the hash is checked against the recomputed header hash on receipt. */
export interface SerializedBlock {
	version: number;
	timestamp: number;
	previousHash: string;
	bits: number;
	nonce: number;
	index: number;
	hash: string;
	signature: string; // PoS: staker's signature over the hash; PoW: empty
	transactions: SerializedTransaction[];
}

export class Block {
	public hash: string;
	public nonce: number;
	public bits: number; // compact target (see target.ts)
	public index: number; // height; committed through the coinbase, not the header
	public version: number;
	/** PoS only: compact signature over `hash` by the coinstake owner's key (not hashed). */
	public signature = '';
	public cumulativeWeight = 0n; // chain work up to and including this block

	constructor(
		public timestamp: number,
		public transactions: Transaction[],
		public previousHash: string,
		nonce = 0,
		bits = POW_LIMIT_BITS,
		index = 0,
		version = BLOCK_VERSION,
	) {
		this.nonce = nonce;
		this.bits = bits;
		this.index = index;
		this.version = version;
		this.hash = this.calculateHash();
	}

	/**
	 * Header bytes before the nonce: version (u32), previous hash, merkle root, timestamp
	 * (u64 ms), bits (u32), all little-endian. The block hash is sha256d(prefix ‖ nonce u32),
	 * so a miner varies only the last four bytes.
	 */
	headerPrefix(): Buffer {
		if (!HASH_PATTERN.test(this.previousHash)) {
			throw new Error('invalid previous block hash');
		}
		const header = Buffer.alloc(HEADER_PREFIX_LENGTH);
		header.writeUInt32LE(this.version, 0);
		Buffer.from(this.previousHash, 'hex').copy(header, 4);
		Buffer.from(merkleRoot(this.transactions), 'hex').copy(header, 36);
		header.writeBigUInt64LE(BigInt(this.timestamp), 68);
		header.writeUInt32LE(this.bits >>> 0, 76);
		return header;
	}

	static hashHeader(prefix: Buffer, nonce: number): string {
		const nonceBytes = Buffer.alloc(4);
		nonceBytes.writeUInt32LE(nonce);
		return sha256d(Buffer.concat([prefix, nonceBytes])).toString('hex');
	}

	calculateHash(): string {
		return Block.hashHeader(this.headerPrefix(), this.nonce);
	}

	/** Serialized size in bytes: header, PoS signature and transactions (MAX_BLOCK_SIZE applies). */
	size(): number {
		const header = this.headerPrefix().length + 4; // + nonce
		return header + this.signature.length / 2 + this.transactions.reduce((sum, tx) => sum + tx.size(), 0);
	}

	target(): bigint {
		return bitsToTarget(this.bits);
	}

	/** Expected hashes to produce this block; chain work sums this. */
	work(): bigint {
		return blockWork(this.bits);
	}

	meetsTarget(): boolean {
		return BigInt('0x' + this.hash) <= this.target();
	}

	/**
	 * Find a nonce in-process that meets the target (tests and in-process mining; the
	 * node's Miner uses a worker thread). Computes the header prefix once.
	 */
	solve(): void {
		const prefix = this.headerPrefix();
		const header = Buffer.alloc(prefix.length + 4);
		prefix.copy(header);
		const target = targetHex(this.bits);
		for (let nonce = 0; nonce <= MAX_BLOCK_NONCE; nonce++) {
			header.writeUInt32LE(nonce, prefix.length); // same bytes as hashHeader(prefix, nonce)
			const hash = sha256d(header).toString('hex');
			if (hash <= target) {
				this.nonce = nonce;
				this.hash = hash;
				return;
			}
		}
		throw new Error('nonce space exhausted');
	}

	/** PoW: the stored hash is the header hash and meets the target. PoS: checked by the chain. */
	isValid(): boolean {
		if (this.isProofOfStake()) return true;
		return this.hash === this.calculateHash() && this.meetsTarget();
	}

	isProofOfStake(): boolean {
		return this.transactions.length > 1 && this.transactions[1].isCoinStake();
	}

	isProofOfWork(): boolean {
		return !this.isProofOfStake();
	}

	toJSON(): SerializedBlock {
		return {
			version: this.version,
			timestamp: this.timestamp,
			previousHash: this.previousHash,
			bits: this.bits,
			nonce: this.nonce,
			index: this.index,
			hash: this.hash,
			signature: this.signature,
			transactions: this.transactions.map((tx) => tx.toJSON()),
		};
	}

	/** Parse and strictly validate the JSON wire form. Throws on anything malformed. */
	static fromJSON(data: unknown): Block {
		const fail = (what: string): never => {
			throw new Error(`malformed block: ${what}`);
		};
		const isUint32 = (v: unknown): boolean =>
			Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_UINT32;
		if (typeof data !== 'object' || data === null) fail('not an object');
		const obj = data as Record<string, unknown>;
		if (!isUint32(obj.version)) fail('version');
		if (!Number.isSafeInteger(obj.timestamp) || (obj.timestamp as number) < 0) fail('timestamp');
		if (typeof obj.previousHash !== 'string' || !HASH_PATTERN.test(obj.previousHash)) {
			fail('previous hash');
		}
		if (!isUint32(obj.bits)) fail('bits');
		if (!isUint32(obj.nonce)) fail('nonce');
		if (!Number.isSafeInteger(obj.index) || (obj.index as number) < 0) fail('index');
		if (typeof obj.hash !== 'string' || !HASH_PATTERN.test(obj.hash)) fail('hash');
		if (typeof obj.signature !== 'string' || !/^(?:[0-9a-f]{128})?$/.test(obj.signature)) {
			fail('signature');
		}
		if (!Array.isArray(obj.transactions) || obj.transactions.length > MAX_BLOCK_TRANSACTIONS) {
			fail('transactions');
		}

		const block = new Block(
			obj.timestamp as number,
			(obj.transactions as unknown[]).map((tx) => Transaction.fromJSON(tx)),
			obj.previousHash as string,
			obj.nonce as number,
			obj.bits as number,
			obj.index as number,
			obj.version as number,
		);
		if (block.hash !== obj.hash) fail('hash does not match header');
		block.signature = obj.signature as string;
		return block;
	}
}
