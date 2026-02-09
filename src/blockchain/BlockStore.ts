import * as fs from 'fs';
import * as path from 'path';
import protobuf from 'protobufjs';
import { Block } from './Block.js';
import { Transaction } from './Transaction.js';
import {
	BLOCKCHAIN_PROTO_PATH,
	BLOCK_INDEX_PROTO_PATH,
	MAX_BLOCK_FILE_SIZE,
} from '../config.js';

interface IndexEntry {
	hash: string;
	height: number;
	fileNumber: number;
	byteOffset: number;
	dataLength: number;
}

let _blockProtoRoot: protobuf.Root | null = null;
function getBlockProto(): protobuf.Type {
	if (!_blockProtoRoot) {
		_blockProtoRoot = protobuf.loadSync(BLOCKCHAIN_PROTO_PATH);
	}
	return _blockProtoRoot.lookupType('SerializedBlock');
}

let _indexProtoRoot: protobuf.Root | null = null;
function getIndexProto(): protobuf.Type {
	if (!_indexProtoRoot) {
		_indexProtoRoot = protobuf.loadSync(BLOCK_INDEX_PROTO_PATH);
	}
	return _indexProtoRoot.lookupType('BlockIndex');
}

export class BlockStore {
	private _blocksDir: string;
	private _indexPath: string;
	private _entries: IndexEntry[] = [];
	private _hashMap: Map<string, number> = new Map();
	private _heightMap: Map<number, number> = new Map();
	private _currentFileNumber: number = 0;
	private _currentFileSize: number = 0;

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

		const entry: IndexEntry = {
			hash: block.hash,
			height: block.index,
			fileNumber: this._currentFileNumber,
			byteOffset,
			dataLength: blockBytes.length,
		};
		this._entries.push(entry);
		this._hashMap.set(entry.hash, this._entries.length - 1);
		this._heightMap.set(entry.height, this._entries.length - 1);

		this._saveIndex();
	}

	getBlock(hash: string): Block | null {
		const idx = this._hashMap.get(hash);
		if (idx === undefined) return null;
		return this._readBlockAt(this._entries[idx]);
	}

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

	replaceAll(blocks: Block[]): void {
		// Delete all existing blk files and index
		if (fs.existsSync(this._blocksDir)) {
			const files = fs.readdirSync(this._blocksDir);
			for (const file of files) {
				fs.unlinkSync(path.join(this._blocksDir, file));
			}
		}

		// Reset state
		this._entries = [];
		this._hashMap.clear();
		this._heightMap.clear();
		this._currentFileNumber = 0;
		this._currentFileSize = 0;

		// Write all blocks
		for (const block of blocks) {
			this.appendBlock(block);
		}
	}

	rebuildIndex(): void {
		this._entries = [];
		this._hashMap.clear();
		this._heightMap.clear();
		this._currentFileNumber = 0;
		this._currentFileSize = 0;

		if (!fs.existsSync(this._blocksDir)) return;

		const files = fs.readdirSync(this._blocksDir)
			.filter((f) => /^blk\d{5}\.dat$/.test(f))
			.sort();

		for (const file of files) {
			const match = file.match(/^blk(\d{5})\.dat$/);
			if (!match) continue;
			const fileNumber = parseInt(match[1], 10);

			const filePath = path.join(this._blocksDir, file);
			const fileData = fs.readFileSync(filePath);
			let offset = 0;

			while (offset + 4 <= fileData.length) {
				const dataLength = fileData.readUInt32LE(offset);
				if (offset + 4 + dataLength > fileData.length) break;

				const blockBytes = fileData.subarray(offset + 4, offset + 4 + dataLength);
				const block = this._deserializeBlock(Buffer.from(blockBytes));

				const entry: IndexEntry = {
					hash: block.hash,
					height: block.index,
					fileNumber,
					byteOffset: offset,
					dataLength,
				};
				this._entries.push(entry);
				this._hashMap.set(entry.hash, this._entries.length - 1);
				this._heightMap.set(entry.height, this._entries.length - 1);

				offset += 4 + dataLength;
			}

			this._currentFileNumber = fileNumber;
			this._currentFileSize = offset;
		}

		this._saveIndex();
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
		const obj = {
			timestamp: block.timestamp,
			transactions: block.transactions.map((tx) => ({
				inputs: tx.inputs.map((input) => ({
					previousTx: input.previousTx,
					outputIndex: input.outputIndex,
					signature: input.signature,
				})),
				outputs: tx.outputs.map((output) => ({
					address: output.address,
					amount: output.amount,
				})),
				timestamp: tx.timestamp,
				nonce: tx.nonce,
			})),
			previousHash: block.previousHash,
			nonce: block.nonce,
			powDifficulty: block.powDifficulty,
			index: block.index,
			hash: block.hash,
		};
		const message = SerializedBlock.create(obj);
		const errMsg = SerializedBlock.verify(message);
		if (errMsg) throw new Error(`invalid block data: ${errMsg}`);
		return Buffer.from(SerializedBlock.encode(message).finish());
	}

	private _deserializeBlock(buffer: Buffer): Block {
		const SerializedBlock = getBlockProto();
		const decoded = SerializedBlock.decode(buffer as Uint8Array);
		const data = SerializedBlock.toObject(decoded, { longs: Number }) as {
			timestamp: number;
			transactions: {
				inputs: { previousTx: string; outputIndex: number; signature: string }[];
				outputs: { address: string; amount: number }[];
				timestamp: number;
				nonce?: number;
			}[];
			previousHash: string;
			nonce: number;
			powDifficulty: number;
			index: number;
			hash: string;
		};

		const transactions = data.transactions.map((txData) => {
			return new Transaction(
				txData.inputs,
				txData.outputs,
				txData.timestamp,
				txData.nonce,
			);
		});

		const block = new Block(
			data.timestamp,
			transactions,
			data.previousHash,
			data.nonce,
			data.powDifficulty,
			data.index,
		);
		block.hash = data.hash;
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

	private _loadIndex(): void {
		if (!fs.existsSync(this._indexPath)) return;

		try {
			const fileBuffer = fs.readFileSync(this._indexPath);
			if (!fileBuffer || fileBuffer.length === 0) return;

			const IndexType = getIndexProto();
			const decoded = IndexType.decode(fileBuffer as Uint8Array);
			const obj = IndexType.toObject(decoded, { longs: Number }) as {
				entries: IndexEntry[];
				currentFileNumber: number;
				currentFileSize: number;
			};

			this._entries = obj.entries || [];
			this._currentFileNumber = obj.currentFileNumber || 0;
			this._currentFileSize = obj.currentFileSize || 0;

			this._hashMap.clear();
			this._heightMap.clear();
			for (let i = 0; i < this._entries.length; i++) {
				this._hashMap.set(this._entries[i].hash, i);
				this._heightMap.set(this._entries[i].height, i);
			}
		} catch (error) {
			console.error('[BlockStore] error loading index:', error);
			this.rebuildIndex();
		}
	}

	private _saveIndex(): void {
		this._ensureDir();
		const IndexType = getIndexProto();
		const message = IndexType.create({
			entries: this._entries,
			currentFileNumber: this._currentFileNumber,
			currentFileSize: this._currentFileSize,
		});
		const errMsg = IndexType.verify(message);
		if (errMsg) throw new Error(`invalid index data: ${errMsg}`);
		const buffer = IndexType.encode(message).finish();
		fs.writeFileSync(this._indexPath, buffer);
	}
}
