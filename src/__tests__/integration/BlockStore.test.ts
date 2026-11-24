// Block files and the append-only block index (TASK-0052), on real files in a temp dir: storing
// a block appends one index record, and every way a stop can cut the two writes short is
// repaired at the next start.
import * as fs from 'fs';
import * as path from 'path';
import protobuf from 'protobufjs';
import { Block } from '../../blockchain/Block.js';
import { BlockStore } from '../../blockchain/BlockStore.js';
import { NULL_HASH, Transaction } from '../../blockchain/Transaction.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const HEADER = 8;
const RECORD = 52;

// index.dat before TASK-0052: one protobuf message, rewritten for every block
const OLD_INDEX_SCHEMA = `
syntax = "proto3";
message BlockIndexEntry { string hash = 1; uint32 height = 2; uint32 file_number = 3; uint64 byte_offset = 4; uint32 data_length = 5; }
message BlockIndex { repeated BlockIndexEntry entries = 1; uint32 current_file_number = 2; uint64 current_file_size = 3; }
`;

/** A chain of `count` blocks, genesis first. */
function blocks(count: number): Block[] {
	const chain: Block[] = [];
	for (let height = 0; height < count; height++) {
		const timestamp = 1_609_459_200_000 + height * 30_000;
		const coinbase = Transaction.coinbase('1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', 50n, height, timestamp);
		chain.push(new Block(timestamp, [coinbase], chain[height - 1]?.hash ?? NULL_HASH, 0, 1, height));
	}
	return chain;
}

describe('BlockStore', () => {
	let dir: string;
	let warn: jest.SpyInstance;
	let info: jest.SpyInstance;
	const file = (name: string) => path.join(dir, name);
	const size = (name: string) => fs.statSync(file(name)).size;
	const hashes = (store: BlockStore) => store.loadAllBlocks().map((block) => block.hash);
	const logged = (spy: jest.SpyInstance) => spy.mock.calls.map((call) => String(call[0])).join('\n');

	/** A store holding `chain`. */
	function storeWith(chain: Block[]): BlockStore {
		const store = new BlockStore(dir);
		for (const block of chain) store.appendBlock(block);
		return store;
	}

	beforeEach(() => {
		dir = makeTempDir();
		info = jest.spyOn(console, 'log').mockImplementation(() => {});
		warn = jest.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		jest.restoreAllMocks();
		removeTempDir(dir);
	});

	it('should store blocks and read them back by hash, by height and in order, also after a restart', () => {
		const chain = blocks(3);
		const store = storeWith(chain);

		expect(store.getBlockCount()).toBe(3);
		expect(store.getBlock(chain[1].hash)?.hash).toBe(chain[1].hash);
		expect(store.getBlockByHeight(2)?.hash).toBe(chain[2].hash);
		expect(store.getBlock('ab'.repeat(32))).toBeNull();
		expect(store.getBlockByHeight(3)).toBeNull();
		expect(hashes(store)).toEqual(chain.map((block) => block.hash));

		const reopened = new BlockStore(dir);
		expect(hashes(reopened)).toEqual(chain.map((block) => block.hash));
		expect(reopened.getBlock(chain[2].hash)?.transactions[0].outputs[0].amount).toBe(50n);
		expect(logged(warn)).toBe('');
	});

	it('should append one record per block and leave the earlier records untouched', () => {
		const chain = blocks(4);
		const store = storeWith(chain.slice(0, 3));
		const before = fs.readFileSync(file('index.dat'));
		expect(before).toHaveLength(HEADER + 3 * RECORD);

		store.appendBlock(chain[3]);

		const after = fs.readFileSync(file('index.dat'));
		expect(after).toHaveLength(HEADER + 4 * RECORD);
		expect(after.subarray(0, before.length).equals(before)).toBe(true);
	});

	it('should index a block stored just before a stop that came before its index record', () => {
		const chain = blocks(4);
		storeWith(chain.slice(0, 3));
		fs.truncateSync(file('index.dat'), HEADER + 2 * RECORD); // block 2 in blk00000.dat only

		const store = new BlockStore(dir);

		expect(hashes(store)).toEqual(chain.slice(0, 3).map((block) => block.hash));
		expect(logged(warn)).toContain('indexed 1 stored block(s) the block index was missing');
		store.appendBlock(chain[3]); // lands after block 2, and the index says so
		expect(new BlockStore(dir).getBlock(chain[3].hash)?.hash).toBe(chain[3].hash);
		expect(size('index.dat')).toBe(HEADER + 4 * RECORD);
	});

	it('should drop a torn index record and index its block again', () => {
		const chain = blocks(3);
		storeWith(chain);
		fs.truncateSync(file('index.dat'), size('index.dat') - 20);

		const store = new BlockStore(dir);

		expect(hashes(store)).toEqual(chain.map((block) => block.hash));
		expect(logged(warn)).toContain('dropped an incomplete record at the end of the block index');
		expect(size('index.dat')).toBe(HEADER + 3 * RECORD);
	});

	it.each([
		['a block cut short', (frame: Buffer) => frame.subarray(0, frame.length - 10)],
		['a length prefix cut short', (frame: Buffer) => frame.subarray(0, 3)],
		['zeroes', () => Buffer.alloc(4096)],
	])('should cut %s off the end of a block file, so the next block is stored where a scan finds it', (_, torn) => {
		const chain = blocks(4);
		storeWith(chain.slice(0, 2));
		const complete = size('blk00000.dat');
		const data = fs.readFileSync(file('blk00000.dat'));
		const frame = data.subarray(0, 4 + data.readUInt32LE(0)); // block 0's length prefix and data, to tear a copy of
		fs.appendFileSync(file('blk00000.dat'), torn(frame));

		const store = new BlockStore(dir);

		expect(size('blk00000.dat')).toBe(complete);
		expect(logged(warn)).toMatch(/dropped \d+ byte\(s\) of an incomplete block at the end of blk00000\.dat/);
		store.appendBlock(chain[2]);
		store.appendBlock(chain[3]);
		const rebuilt = new BlockStore(dir);
		rebuilt.rebuildIndex();
		expect(hashes(rebuilt)).toEqual(chain.map((block) => block.hash));
	});

	it('should index blocks in a block file after the last indexed one', () => {
		const chain = blocks(3);
		storeWith(chain.slice(0, 2));
		const frames = fs.readFileSync(file('blk00000.dat'));
		new BlockStore(makeSibling('other')).appendBlock(chain[2]);
		fs.copyFileSync(path.join(dir, 'other', 'blk00000.dat'), file('blk00001.dat')); // block 2 in a new file

		const store = new BlockStore(dir);

		expect(hashes(store)).toEqual(chain.map((block) => block.hash));
		expect(store.getBlock(chain[2].hash)?.index).toBe(2);
		store.appendBlock(blocks(4)[3]); // the current file is blk00001.dat now
		expect(size('blk00000.dat')).toBe(frames.length);
		expect(new BlockStore(dir).getBlockCount()).toBe(4);
	});

	it('should rebuild a damaged index from the block files', () => {
		const chain = blocks(3);
		storeWith(chain);
		const index = fs.readFileSync(file('index.dat'));
		index[HEADER + RECORD + 40] ^= 0xff; // record 2's byte offset; the checksum no longer matches
		fs.writeFileSync(file('index.dat'), index);

		const store = new BlockStore(dir);

		expect(logged(warn)).toContain('the block index is damaged at record 2; rebuilding it from the block files');
		expect(hashes(store)).toEqual(chain.map((block) => block.hash));
		expect(new BlockStore(dir).getBlockCount()).toBe(3); // the rebuilt index is saved
	});

	it('should rebuild the index when a block file is shorter than the index says', () => {
		const chain = blocks(3);
		storeWith(chain);
		fs.truncateSync(file('blk00000.dat'), size('blk00000.dat') - 5); // block 2 cut short

		const store = new BlockStore(dir);

		expect(logged(warn)).toContain('the block index is damaged at record 3');
		expect(hashes(store)).toEqual(chain.slice(0, 2).map((block) => block.hash));
	});

	it('should rebuild a missing index', () => {
		const chain = blocks(2);
		storeWith(chain);
		fs.unlinkSync(file('index.dat'));

		const store = new BlockStore(dir);

		expect(logged(warn)).toContain('the block index is missing; rebuilding it from the block files');
		expect(hashes(store)).toEqual(chain.map((block) => block.hash));
		expect(store.getBlockByHeight(1)?.hash).toBe(chain[1].hash);
	});

	it('should convert an index.dat from before (one protobuf message)', () => {
		const chain = blocks(3);
		storeWith(chain);
		const entries = chain.map((block) => block.hash); // as the old format lists them
		const type = protobuf.parse(OLD_INDEX_SCHEMA).root.lookupType('BlockIndex');
		const old = type.encode(type.fromObject({ entries: entries.map((hash, height) => ({ hash, height })) })).finish();
		fs.writeFileSync(file('index.dat'), old);

		const store = new BlockStore(dir);

		expect(logged(info)).toContain('converting the block index to the append-only format');
		expect(logged(warn)).toBe('');
		expect(hashes(store)).toEqual(entries);
		expect(fs.readFileSync(file('index.dat')).subarray(0, 6).toString()).toBe('BTSIDX');
		expect(size('index.dat')).toBe(HEADER + 3 * RECORD);
	});

	it('should start empty in a new directory', () => {
		const store = new BlockStore(file('new'));
		expect(store.getBlockCount()).toBe(0);
		expect(store.loadAllBlocks()).toEqual([]);
		store.rebuildIndex();
		expect(store.getBlockCount()).toBe(0);
	});

	function makeSibling(name: string): string {
		const sibling = path.join(dir, name);
		fs.mkdirSync(sibling);
		return sibling;
	}
});
