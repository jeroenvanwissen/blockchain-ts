import * as fs from 'fs';
import * as path from 'path';
import protobuf from 'protobufjs';
import * as zlib from 'zlib';
import { Block } from './Block.js';
import { Transaction } from './Transaction.js';
import { BLOCKCHAIN_SCHEMA } from './protoSchemas.js';
import { MAX_BLOCK_FILE_SIZE } from '../config.js';
import { logger } from '../logger.js';

const log = logger('BlockStore');

interface IndexEntry {
	hash: string;
	height: number;
	fileNumber: number;
	byteOffset: number;
	dataLength: number;
}

// index.dat (TASK-0052): a header, then one fixed-size record per stored block, appended as the
// block is stored, so storing a block costs the same at any height. A record is the block hash
// (32 bytes), height, file number, byte offset and data length (uint32 LE each), then a CRC-32
// of those 48 bytes. The blk*.dat files are the source of truth: the index can always be
// rebuilt from them.
const INDEX_MAGIC = Buffer.from('BTSIDX\x00\x01', 'latin1');
const RECORD_SIZE = 52;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BLK_FILE_PATTERN = /^blk(\d{5})\.dat$/;

function encodeRecord(entry: IndexEntry): Buffer {
	if (!HASH_PATTERN.test(entry.hash)) throw new Error(`cannot index block hash ${entry.hash}`);
	const record = Buffer.alloc(RECORD_SIZE);
	record.write(entry.hash, 0, 32, 'hex');
	record.writeUInt32LE(entry.height, 32);
	record.writeUInt32LE(entry.fileNumber, 36);
	record.writeUInt32LE(entry.byteOffset, 40);
	record.writeUInt32LE(entry.dataLength, 44);
	record.writeUInt32LE(zlib.crc32(record.subarray(0, 48)), 48);
	return record;
}

/** The entry in a record; null if its checksum doesn't match. */
function decodeRecord(record: Buffer): IndexEntry | null {
	if (zlib.crc32(record.subarray(0, 48)) !== record.readUInt32LE(48)) return null;
	return {
		hash: record.toString('hex', 0, 32),
		height: record.readUInt32LE(32),
		fileNumber: record.readUInt32LE(36),
		byteOffset: record.readUInt32LE(40),
		dataLength: record.readUInt32LE(44),
	};
}

let _blockProtoRoot: protobuf.Root | null = null;
function getBlockProto(): protobuf.Type {
	if (!_blockProtoRoot) {
		_blockProtoRoot = protobuf.parse(BLOCKCHAIN_SCHEMA).root;
	}
	return _blockProtoRoot.lookupType('SerializedBlock');
}

export class BlockStore {
	private _blocksDir: string;
	private _indexPath: string;
	private _entries: IndexEntry[] = [];
	private _hashMap: Map<string, number> = new Map();
	private _heightMap: Map<number, number> = new Map();
	private _currentFileNumber: number = 0;
	private _currentFileSize: number = 0; // the actual size of the current blk file
	private _indexExists = false;

	constructor(blocksDir: string) {
		this._blocksDir = blocksDir;
		this._indexPath = path.join(blocksDir, 'index.dat');
		this._loadIndex();
	}

	appendBlock(block: Block): void {
		const blockBytes = this._serializeBlock(block);
		const lengthPrefix = Buffer.alloc(4);
		lengthPrefix.writeUInt32LE(blockBytes.length, 0);
		const totalSize = 4 + blockBytes.length;

		// Rotate to a new file if current would exceed limit
		if (this._currentFileSize > 0 && this._currentFileSize + totalSize > MAX_BLOCK_FILE_SIZE) {
			this._currentFileNumber++;
			this._currentFileSize = 0;
		}

		this._ensureDir();

		const filePath = this._blkFilePath(this._currentFileNumber);
		const byteOffset = this._currentFileSize;

		fs.appendFileSync(filePath, Buffer.concat([lengthPrefix, blockBytes]));
		this._currentFileSize += totalSize;

		this._appendEntry({
			hash: block.hash,
			height: block.index,
			fileNumber: this._currentFileNumber,
			byteOffset,
			dataLength: blockBytes.length,
		});
	}

	getBlock(hash: string): Block | null {
		const idx = this._hashMap.get(hash);
		if (idx === undefined) return null;
		return this._readBlockAt(this._entries[idx]);
	}

	/** Most recently stored block at this height (side branches can share heights). */
	getBlockByHeight(height: number): Block | null {
		const idx = this._heightMap.get(height);
		if (idx === undefined) return null;
		return this._readBlockAt(this._entries[idx]);
	}

	loadAllBlocks(): Block[] {
		if (this._entries.length === 0) return [];

		const blocks: Block[] = [];
		for (const entry of this._entries) {
			blocks.push(this._readBlockAt(entry));
		}
		return blocks;
	}

	getBlockCount(): number {
		return this._entries.length;
	}

	/** Rebuild index.dat from the blk*.dat files (a damaged or missing index, an older format). */
	rebuildIndex(): void {
		const entries: IndexEntry[] = [];
		for (const fileNumber of this._blkFileNumbers()) {
			for (const entry of this._scanFile(fileNumber, 0)) entries.push(entry); // a file can hold too many to spread
		}
		this._setEntries(entries);
		this._ensureDir();
		const temp = `${this._indexPath}.tmp`;
		fs.writeFileSync(temp, Buffer.concat([INDEX_MAGIC, ...entries.map(encodeRecord)]));
		fs.renameSync(temp, this._indexPath);
		this._indexExists = true;
		this._setCurrentFile();
	}

	private _ensureDir(): void {
		if (!fs.existsSync(this._blocksDir)) {
			fs.mkdirSync(this._blocksDir, { recursive: true });
		}
	}

	private _blkFilePath(fileNumber: number): string {
		return path.join(
			this._blocksDir,
			`blk${fileNumber.toString().padStart(5, '0')}.dat`,
		);
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

	private _readBlockAt(entry: IndexEntry): Block {
		const filePath = this._blkFilePath(entry.fileNumber);
		const fd = fs.openSync(filePath, 'r');
		try {
			const buffer = Buffer.alloc(entry.dataLength);
			fs.readSync(fd, buffer, 0, entry.dataLength, entry.byteOffset + 4);
			return this._deserializeBlock(buffer);
		} finally {
			fs.closeSync(fd);
		}
	}

	/**
	 * Load index.dat and bring it in line with the blk*.dat files: a missing, damaged or older
	 * index is rebuilt from them; blocks stored after the last indexed one (a stop between the
	 * two writes of appendBlock) are indexed; a torn record or block at the end is dropped.
	 */
	private _loadIndex(): void {
		const files = this._blkFileNumbers();
		if (!fs.existsSync(this._indexPath)) {
			if (files.length === 0) return; // a new store
			log.warn('the block index is missing; rebuilding it from the block files');
			this.rebuildIndex();
			return;
		}
		const data = fs.readFileSync(this._indexPath);
		if (data.length < INDEX_MAGIC.length || !data.subarray(0, INDEX_MAGIC.length).equals(INDEX_MAGIC)) {
			log.info('converting the block index to the append-only format');
			this.rebuildIndex();
			return;
		}

		const sizes = new Map(files.map((fileNumber) => [fileNumber, fs.statSync(this._blkFilePath(fileNumber)).size]));
		const count = Math.floor((data.length - INDEX_MAGIC.length) / RECORD_SIZE);
		const entries: IndexEntry[] = [];
		for (let i = 0; i < count; i++) {
			const start = INDEX_MAGIC.length + i * RECORD_SIZE;
			const entry = decodeRecord(data.subarray(start, start + RECORD_SIZE));
			if (!entry || entry.byteOffset + 4 + entry.dataLength > (sizes.get(entry.fileNumber) ?? -1)) {
				log.warn(`the block index is damaged at record ${i + 1}; rebuilding it from the block files`);
				this.rebuildIndex();
				return;
			}
			entries.push(entry);
		}
		const complete = INDEX_MAGIC.length + count * RECORD_SIZE;
		if (data.length > complete) {
			fs.truncateSync(this._indexPath, complete);
			log.warn('dropped an incomplete record at the end of the block index');
		}
		this._setEntries(entries);
		this._indexExists = true;

		// The files hold blocks after the last indexed one only if a stop came between the writes
		const last = entries[entries.length - 1];
		let recovered = 0;
		for (const fileNumber of files) {
			if (last && fileNumber < last.fileNumber) continue;
			const from = last && fileNumber === last.fileNumber ? last.byteOffset + 4 + last.dataLength : 0;
			for (const entry of this._scanFile(fileNumber, from)) {
				this._appendEntry(entry);
				recovered++;
			}
		}
		if (recovered > 0) log.warn(`indexed ${recovered} stored block(s) the block index was missing`);
		this._setCurrentFile();
	}

	/** Index a stored block: one record appended to index.dat. */
	private _appendEntry(entry: IndexEntry): void {
		const record = encodeRecord(entry);
		if (this._indexExists) {
			fs.appendFileSync(this._indexPath, record);
		} else {
			this._ensureDir();
			fs.writeFileSync(this._indexPath, Buffer.concat([INDEX_MAGIC, record]));
			this._indexExists = true;
		}
		this._entries.push(entry);
		this._hashMap.set(entry.hash, this._entries.length - 1);
		this._heightMap.set(entry.height, this._entries.length - 1);
	}

	private _setEntries(entries: IndexEntry[]): void {
		this._entries = entries;
		this._hashMap.clear();
		this._heightMap.clear();
		entries.forEach((entry, i) => {
			this._hashMap.set(entry.hash, i);
			this._heightMap.set(entry.height, i);
		});
	}

	/** New blocks go to the last blk file, at its actual end. */
	private _setCurrentFile(): void {
		const files = this._blkFileNumbers();
		this._currentFileNumber = files.length > 0 ? files[files.length - 1] : 0;
		this._currentFileSize = files.length > 0 ? fs.statSync(this._blkFilePath(this._currentFileNumber)).size : 0;
	}

	private _blkFileNumbers(): number[] {
		if (!fs.existsSync(this._blocksDir)) return [];
		return fs
			.readdirSync(this._blocksDir)
			.map((file) => BLK_FILE_PATTERN.exec(file))
			.filter((match) => match !== null)
			.map((match) => parseInt(match[1], 10))
			.sort((a, b) => a - b);
	}

	/**
	 * Index entries for the blocks in a blk file from byte `from` on. A torn block at the end
	 * (length prefix or data cut short, or zeroes) is cut off the file, so later blocks are
	 * appended where a scan can find them; an unreadable block that is complete is skipped.
	 */
	private _scanFile(fileNumber: number, from: number): IndexEntry[] {
		const filePath = this._blkFilePath(fileNumber);
		const size = fs.statSync(filePath).size;
		if (from >= size) return [];
		const data = Buffer.alloc(size - from);
		const fd = fs.openSync(filePath, 'r');
		try {
			fs.readSync(fd, data, 0, data.length, from);
		} finally {
			fs.closeSync(fd);
		}

		const entries: IndexEntry[] = [];
		let offset = 0;
		while (offset + 4 <= data.length) {
			const dataLength = data.readUInt32LE(offset);
			if (dataLength === 0 || offset + 4 + dataLength > data.length) break;
			const byteOffset = from + offset;
			try {
				const block = this._deserializeBlock(data.subarray(offset + 4, offset + 4 + dataLength));
				if (!HASH_PATTERN.test(block.hash)) throw new Error('malformed hash');
				entries.push({ hash: block.hash, height: block.index, fileNumber, byteOffset, dataLength });
			} catch (error) {
				log.warn(`skipping an unreadable block in ${path.basename(filePath)} at byte ${byteOffset}: ${(error as Error).message}`);
			}
			offset += 4 + dataLength;
		}
		if (offset < data.length) {
			fs.truncateSync(filePath, from + offset);
			log.warn(`dropped ${data.length - offset} byte(s) of an incomplete block at the end of ${path.basename(filePath)}`);
		}
		return entries;
	}
}
