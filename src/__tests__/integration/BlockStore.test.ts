// The block files (TASK-0052, TASK-0055), on real files in a temp dir: blocks are appended and
// read back by position, a scan finds them all (or those after a known one) and cuts an
// incomplete block a stop left off the end of a file, and the store keeps no per-block state.
import * as fs from 'fs';
import * as path from 'path';
import { Block } from '../../blockchain/Block.js';
import { BlockStore, type BlockPosition } from '../../blockchain/BlockStore.js';
import { NULL_HASH, Transaction } from '../../blockchain/Transaction.js';
import * as config from '../../config.js';
import { makeTempDir, removeTempDir } from './helpers.js';

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

const hashes = (chain: Block[]) => chain.map((block) => block.hash);

describe('BlockStore', () => {
	let dir: string;
	let warn: jest.SpyInstance;
	let stores: BlockStore[];
	const file = (name: string) => path.join(dir, name);
	const size = (name: string) => fs.statSync(file(name)).size;
	const logged = (spy: jest.SpyInstance) => spy.mock.calls.map((call: unknown[]) => call.map(String).join(' ')).join('\n');
	const scanned = (store: BlockStore, after?: BlockPosition) => [...store.scan(after)].map(({ block }) => block.hash);

	function open(at = dir): BlockStore {
		const store = new BlockStore(at);
		stores.push(store);
		return store;
	}

	/** A store holding `chain`, and where each block went. */
	function storeWith(chain: Block[]): { store: BlockStore; positions: BlockPosition[] } {
		const store = open();
		return { store, positions: chain.map((block) => store.append(block)) };
	}

	beforeEach(() => {
		dir = makeTempDir();
		stores = [];
		jest.spyOn(console, 'log').mockImplementation(() => {});
		warn = jest.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		for (const store of stores) store.close();
		jest.restoreAllMocks();
		removeTempDir(dir);
	});

	it('should append blocks one after another and read them back by position, also after a restart', () => {
		const chain = blocks(3);
		const { store, positions } = storeWith(chain);

		expect(positions[0]).toEqual({ file: 0, offset: 0, length: positions[0].length });
		expect(positions[1].offset).toBe(4 + positions[0].length);
		expect(size('blk00000.dat')).toBe(positions[2].offset + 4 + positions[2].length);
		expect(store.read(positions[1]).hash).toBe(chain[1].hash);

		const reopened = open();
		expect(reopened.read(positions[2]).transactions[0].outputs[0].amount).toBe(50n);
		expect(positions.every((position) => reopened.contains(position))).toBe(true);
		expect(logged(warn)).toBe('');
	});

	it('should scan every stored block in order with its position, or those after a known one', () => {
		const chain = blocks(4);
		const { positions } = storeWith(chain);
		const store = open();

		expect([...store.scan()].map(({ block, position }) => [block.hash, position])).toEqual(chain.map((block, i) => [block.hash, positions[i]]));
		expect(scanned(store, positions[1])).toEqual(hashes(chain.slice(2)));
		expect(scanned(store, positions[3])).toEqual([]);
	});

	it('should keep no per-block state in memory: only each file\'s size and its open files', () => {
		const chain = blocks(5);
		const { store, positions } = storeWith(chain);
		for (const position of positions) store.read(position);

		expect(store['_sizes'].size).toBe(1);
		expect(store['_readers'].size).toBe(1);
	});

	it('should tell whether the files are long enough to hold a block at a position', () => {
		const { store, positions } = storeWith(blocks(2));

		expect(store.contains(positions[1])).toBe(true);
		expect(store.contains({ ...positions[1], length: positions[1].length + 1 })).toBe(false);
		expect(store.contains({ ...positions[0], file: 1 })).toBe(false);
	});

	it('should fail to read a block the files don\'t hold', () => {
		const { store, positions } = storeWith(blocks(2));

		expect(() => store.read({ ...positions[1], length: positions[1].length + 10 })).toThrow('blk00000.dat ends inside the block');
		expect(() => store.read({ ...positions[0], file: 7 })).toThrow(/ENOENT/);
	});

	it.each([
		['a block cut short', (frame: Buffer) => frame.subarray(0, frame.length - 10)],
		['a length prefix cut short', (frame: Buffer) => frame.subarray(0, 3)],
		['zeroes', () => Buffer.alloc(4096)],
	])('should cut %s off the end of a block file, so the next block is stored where a scan finds it', (_, torn) => {
		const chain = blocks(4);
		const { positions } = storeWith(chain.slice(0, 2));
		const complete = size('blk00000.dat');
		const data = fs.readFileSync(file('blk00000.dat'));
		fs.appendFileSync(file('blk00000.dat'), torn(data.subarray(0, 4 + positions[0].length))); // a torn copy of block 0

		const store = open();
		expect(scanned(store, positions[1])).toEqual([]); // a start that knows both blocks

		expect(size('blk00000.dat')).toBe(complete);
		expect(logged(warn)).toMatch(/dropped \d+ byte\(s\) of an incomplete block at the end of blk00000\.dat/);
		store.append(chain[2]);
		store.append(chain[3]);
		expect(scanned(open())).toEqual(hashes(chain));
	});

	it('should cut off what a failed write left, so the next block follows the last complete one', () => {
		const chain = blocks(3);
		const { store } = storeWith(chain.slice(0, 1));
		const complete = size('blk00000.dat');
		const realFs = jest.requireActual<typeof fs>('fs'); // the module behind the import's (read-only) bindings
		const writeSync = realFs.writeSync;
		jest.spyOn(realFs, 'writeSync').mockImplementationOnce(((fd: number, buffer: Buffer) => {
			writeSync(fd, buffer.subarray(0, 10));
			throw new Error('ENOSPC: no space left on device');
		}) as unknown as typeof fs.writeSync);

		expect(() => store.append(chain[1])).toThrow('ENOSPC');

		expect(size('blk00000.dat')).toBe(complete);
		expect(store.append(chain[2]).offset).toBe(complete);
		expect(scanned(open())).toEqual(hashes([chain[0], chain[2]]));
		expect(logged(warn)).toBe('');
	});

	it('should start a new file when a block would grow the last one past MAX_BLOCK_FILE_SIZE, and read from any of them', () => {
		const settings: { MAX_BLOCK_FILE_SIZE: number } = config;
		jest.replaceProperty(settings, 'MAX_BLOCK_FILE_SIZE', 1); // one block per file
		const chain = blocks(12);
		const { store, positions } = storeWith(chain);

		expect(positions.map((position) => [position.file, position.offset])).toEqual(chain.map((_, i) => [i, 0]));
		for (const position of [...positions, ...[...positions].reverse()]) expect(store.read(position).hash).toBe(chain[position.file].hash);
		expect(store['_readers'].size).toBe(8); // at most this many open
		expect(scanned(open())).toEqual(hashes(chain));
		expect(open().append(blocks(13)[12]).file).toBe(12); // after a restart, the last file
	});

	it('should scan the blocks of every file and append to the last one', () => {
		const chain = blocks(4);
		storeWith(chain.slice(0, 2));
		const other = path.join(dir, 'other');
		open(other).append(chain[2]);
		fs.copyFileSync(path.join(other, 'blk00000.dat'), file('blk00001.dat')); // block 2 in a second file

		const store = open();

		expect([...store.scan()].map(({ block, position }) => [block.index, position.file])).toEqual([[0, 0], [1, 0], [2, 1]]);
		expect(store.append(chain[3]).file).toBe(1);
		expect(scanned(open())).toEqual(hashes(chain));
	});

	it('should skip an unreadable block in the middle of a file', () => {
		const chain = blocks(3);
		const { positions } = storeWith(chain);
		const data = fs.readFileSync(file('blk00000.dat'));
		data.fill(0xff, positions[1].offset + 4, positions[1].offset + 4 + positions[1].length);
		fs.writeFileSync(file('blk00000.dat'), data);

		expect(scanned(open())).toEqual(hashes([chain[0], chain[2]]));
		expect(logged(warn)).toContain(`skipping an unreadable block in blk00000.dat at byte ${positions[1].offset}`);
	});

	it('should start empty in a new directory and make it for the first block', () => {
		const store = open(file('new'));

		expect(scanned(store)).toEqual([]);
		expect(store.append(blocks(1)[0])).toEqual({ file: 0, offset: 0, length: expect.any(Number) as number });
		expect(fs.existsSync(file('new/blk00000.dat'))).toBe(true);
	});
});
