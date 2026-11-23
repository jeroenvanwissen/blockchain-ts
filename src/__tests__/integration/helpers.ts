// Helpers for integration tests: real filesystem, real protobuf, temp directories.
// Time is controlled with jest fake timers (see AGENTS.md); call useTestClock() in beforeEach.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Block } from '../../blockchain/Block.js';
import { Blockchain, type BlockchainOptions } from '../../blockchain/Blockchain.js';
import { Wallet } from '../../blockchain/Wallet.js';
import { BLOCK_TIME } from '../../config.js';

const START_TIME = Date.UTC(2027, 0, 1);

let now = START_TIME;

export function useTestClock(): void {
	jest.useFakeTimers();
	now = START_TIME;
	jest.setSystemTime(new Date(now));
}

export function advanceTime(ms: number): void {
	now += ms;
	jest.setSystemTime(new Date(now));
}

export function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'blockchain-ts-it-'));
}

export function removeTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

export function openChain(dir: string, options: BlockchainOptions = {}): Blockchain {
	return new Blockchain({ ...options, blocksDir: path.join(dir, 'blocks') });
}

export function openWallet(dir: string, name: string): Wallet {
	return new Wallet(path.join(dir, `${name}.dat`));
}

/** Mine `count` PoW blocks to `address`, one target block time apart. */
export async function mineBlocks(chain: Blockchain, address: string, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		advanceTime(BLOCK_TIME * 1000);
		await chain.minePendingTransactions(address);
	}
}

/** Find a nonce that satisfies the block's own PoW check. */
export function solve(block: Block): Block {
	block.solve();
	return block;
}
