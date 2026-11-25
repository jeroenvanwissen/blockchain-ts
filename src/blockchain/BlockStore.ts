import * as fs from 'fs';
import * as path from 'path';
import protobuf from 'protobufjs';
import { Block } from './Block.js';
import { Transaction } from './Transaction.js';
import { BLOCKCHAIN_SCHEMA } from './protoSchemas.js';
import { MAX_BLOCK_FILE_SIZE } from '../config.js';
import { logger } from '../logger.js';

const log = logger('BlockStore');

/**
 * Where a block is in the block files: in blk<file>.dat, its 4-byte length prefix (uint32 LE) at
 * byte `offset`, then `length` bytes of block data (protobuf). The chain database records it for
 * every known block (TASK-0055).
 */
export interface BlockPosition {
	file: number;
	offset: number;
	length: number;
}

export interface StoredBlock {
	block: Block;
	position: BlockPosition;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BLK_FILE_PATTERN = /^blk(\d{5})\.dat$/;
const SCAN_CHUNK = 8 * 1024 * 1024; // bytes read at a time when scanning a block file
const MAX_READERS = 8; // block files kept open for reading

let _blockProtoRoot: protobuf.Root | null = null;
function getBlockProto(): protobuf.Type {
	if (!_blockProtoRoot) {
		_blockProtoRoot = protobuf.parse(BLOCKCHAIN_SCHEMA).root;
	}
	return _blockProtoRoot.lookupType('SerializedBlock');
}

/**
 * The block files (`blk00000.dat`, ...): every stored block, appended as a length-prefixed
 * protobuf message. They are the source of truth; the chain database, which records where each
 * block is, can always be rebuilt from them (`scan`). The store keeps no per-block state in
 * memory (TASK-0055), only each file's size and a few open file descriptors (`close`).
 */
export class BlockStore {
	private readonly _dir: string;
	private readonly _sizes = new Map<number, number>(); // every block file's size, by file number
	private readonly _readers = new Map<number, number>(); // open for reading, least recently used first
	private _writer: { file: number; fd: number } | null = null;
	private _current = 0; // the file new blocks are appended to: the last one

	constructor(dir: string) {
		this._dir = dir;
		for (const file of this._fileNumbers()) {
			this._sizes.set(file, fs.statSync(this._path(file)).size);
			this._current = file;
		}
	}

	/**
	 * Append a block to the last block file, or to a new one when it would grow past
	 * MAX_BLOCK_FILE_SIZE, and return where it is. A failed write is cut off again, so the next
	 * block follows the last complete one.
	 */
	append(block: Block): BlockPosition {
		const data = this._serializeBlock(block);
		const frame = Buffer.allocUnsafe(4 + data.length);
		frame.writeUInt32LE(data.length, 0);
		frame.set(data, 4);
		let offset = this._sizes.get(this._current) ?? 0;
		if (offset > 0 && offset + frame.length > MAX_BLOCK_FILE_SIZE) {
			this._current++;
			offset = 0;
		}
		const fd = this._writerFor(this._current);
		try {
			for (let written = 0; written < frame.length; ) written += fs.writeSync(fd, frame, written);
		} catch (error) {
			try {
				fs.ftruncateSync(fd, offset);
			} catch {
				// the next start cuts the incomplete block off (scan)
			}
			throw error;
		}
		this._sizes.set(this._current, offset + frame.length);
		return { file: this._current, offset, length: data.length };
	}

	/** The block at `position`. Throws if the files don't hold a readable block there. */
	read(position: BlockPosition): Block {
		const data = Buffer.allocUnsafe(position.length);
		const read = fs.readSync(this._readerFor(position.file), data, 0, data.length, position.offset + 4);
		if (read !== data.length) throw new Error(`${this._name(position.file)} ends inside the block at byte ${position.offset}`);
		return this._deserializeBlock(data);
	}

	/** Whether the block files are long enough to hold a block at `position`. */
	contains(position: BlockPosition): boolean {
		return position.offset >= 0 && position.offset + 4 + position.length <= (this._sizes.get(position.file) ?? -1);
	}

	/**
	 * The stored blocks after the one at `after` (all of them without it), in the order they were
	 * stored, with their positions. An unreadable block is skipped. An incomplete block at the end
	 * of a file (a stop during a write) is cut off, so blocks appended later follow the last
	 * complete one: scan from the last known block before appending after a start.
	 */
	*scan(after?: BlockPosition): Generator<StoredBlock> {
		for (const file of [...this._sizes.keys()].sort((a, b) => a - b)) {
			if (after && file < after.file) continue;
			yield* this._scanFile(file, after && file === after.file ? after.offset + 4 + after.length : 0);
		}
	}

	/** Close the open block files. */
	close(): void {
		if (this._writer) fs.closeSync(this._writer.fd);
		this._writer = null;
		for (const fd of this._readers.values()) fs.closeSync(fd);
		this._readers.clear();
	}

	private _writerFor(file: number): number {
		if (this._writer?.file === file) return this._writer.fd;
		if (this._writer) fs.closeSync(this._writer.fd);
		this._writer = null;
		fs.mkdirSync(this._dir, { recursive: true });
		this._writer = { file, fd: fs.openSync(this._path(file), 'a') };
		return this._writer.fd;
	}

	private _readerFor(file: number): number {
		let fd = this._readers.get(file);
		if (fd === undefined) {
			fd = fs.openSync(this._path(file), 'r');
			if (this._readers.size >= MAX_READERS) {
				const [oldest, oldestFd] = this._readers.entries().next().value!;
				fs.closeSync(oldestFd);
				this._readers.delete(oldest);
			}
		} else {
			this._readers.delete(file); // to the end: most recently used
		}
		this._readers.set(file, fd);
		return fd;
	}

	private _path(file: number): string {
		return path.join(this._dir, this._name(file));
	}

	private _name(file: number): string {
		return `blk${file.toString().padStart(5, '0')}.dat`;
	}

	private _fileNumbers(): number[] {
		if (!fs.existsSync(this._dir)) return [];
		return fs
			.readdirSync(this._dir)
			.map((name) => BLK_FILE_PATTERN.exec(name))
			.filter((match) => match !== null)
			.map((match) => parseInt(match[1], 10))
			.sort((a, b) => a - b);
	}

	/** The blocks in one file from byte `from` on; an incomplete block at its end is cut off. */
	private *_scanFile(file: number, from: number): Generator<StoredBlock> {
		const size = this._sizes.get(file) ?? 0;
		if (from >= size) return;
		const fd = fs.openSync(this._path(file), 'r');
		let chunk = Buffer.alloc(0);
		let chunkStart = from;
		// Bytes [start, end) of the file, read SCAN_CHUNK bytes (or one block) at a time
		const bytes = (start: number, end: number): Buffer => {
			if (start < chunkStart || end > chunkStart + chunk.length) {
				chunk = Buffer.allocUnsafe(Math.min(Math.max(SCAN_CHUNK, end - start), size - start));
				if (fs.readSync(fd, chunk, 0, chunk.length, start) !== chunk.length) throw new Error(`${this._name(file)} changed during a scan`);
				chunkStart = start;
			}
			return chunk.subarray(start - chunkStart, end - chunkStart);
		};

		let offset = from;
		try {
			while (offset + 4 <= size) {
				const length = bytes(offset, offset + 4).readUInt32LE(0);
				if (length === 0 || offset + 4 + length > size) break; // incomplete (or zeroes)
				let block: Block | null = null;
				try {
					block = this._deserializeBlock(bytes(offset + 4, offset + 4 + length));
					if (!HASH_PATTERN.test(block.hash)) throw new Error('malformed hash');
				} catch (error) {
					log.warn(`skipping an unreadable block in ${this._name(file)} at byte ${offset}: ${(error as Error).message}`);
					block = null;
				}
				const position = { file, offset, length };
				offset += 4 + length;
				if (block) yield { block, position };
			}
		} finally {
			fs.closeSync(fd);
		}
		if (offset < size) {
			fs.truncateSync(this._path(file), offset);
			this._sizes.set(file, offset);
			log.warn(`dropped ${size - offset} byte(s) of an incomplete block at the end of ${this._name(file)}`);
		}
	}

	private _serializeBlock(block: Block): Buffer {
		const SerializedBlock = getBlockProto();
		// 64-bit fields go in as decimal strings; fromObject converts them without precision loss
		const message = SerializedBlock.fromObject({
			timestamp: String(block.timestamp),
			transactions: block.transactions.map((tx) => ({
				version: tx.version,
				inputs: tx.inputs.map((input) => ({
					previousTx: input.previousTx,
					outputIndex: input.outputIndex,
					publicKey: input.publicKey,
					signature: input.signature,
				})),
				outputs: tx.outputs.map((output) => ({
					address: output.address,
					amount: output.amount.toString(),
				})),
				timestamp: String(tx.timestamp),
			})),
			previousHash: block.previousHash,
			nonce: block.nonce,
			bits: block.bits,
			version: block.version,
			index: block.index,
			hash: block.hash,
			signature: block.signature,
		});
		return Buffer.from(SerializedBlock.encode(message).finish());
	}

	private _deserializeBlock(buffer: Buffer): Block {
		const SerializedBlock = getBlockProto();
		const decoded = SerializedBlock.decode(buffer);
		// arrays: true — proto3 omits empty repeated fields on decode
		// longs: String — amounts are uint64 and must not pass through a JS number.
		// defaults: proto3 omits zero values (nonce 0, height 0, ...) from the encoding
		const data = SerializedBlock.toObject(decoded, { longs: String, arrays: true, defaults: true }) as {
			timestamp: string;
			transactions: {
				version: number;
				inputs: { previousTx: string; outputIndex: number; publicKey: string; signature: string }[];
				outputs: { address: string; amount: string }[];
				timestamp: string;
			}[];
			previousHash: string;
			nonce: number;
			bits: number;
			version: number;
			index: number;
			hash: string;
			signature?: string;
		};

		const transactions = data.transactions.map(
			(txData) =>
				new Transaction(
					txData.inputs.map((input) => ({
						previousTx: input.previousTx,
						outputIndex: input.outputIndex,
						publicKey: input.publicKey ?? '',
						signature: input.signature ?? '',
					})),
					txData.outputs.map((output) => ({
						address: output.address,
						amount: BigInt(output.amount),
					})),
					Number(txData.timestamp),
					txData.version,
				),
		);

		const block = new Block(
			Number(data.timestamp),
			transactions,
			data.previousHash,
			data.nonce,
			data.bits,
			data.index,
			data.version,
		);
		block.hash = data.hash;
		block.signature = data.signature ?? '';
		return block;
	}
}
