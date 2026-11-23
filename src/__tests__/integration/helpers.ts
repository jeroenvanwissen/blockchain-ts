// Helpers for integration tests: real filesystem, real protobuf, temp directories.
// Time is controlled with jest fake timers (see AGENTS.md); call useTestClock() in beforeEach.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Block } from '../../blockchain/Block.js';
import { Blockchain, type BlockchainOptions } from '../../blockchain/Blockchain.js';
import { Transaction } from '../../blockchain/Transaction.js';
import { Wallet } from '../../blockchain/Wallet.js';
import { requiredBits } from '../../blockchain/retarget.js';
import { BLOCK_TIME, POW_BLOCK_REWARD, STAKE_MIN_AGE, STAKE_TIMESTAMP_GRANULARITY } from '../../config.js';

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

/** A solved PoW block on top of `branch` paying `address` (not added to any chain). */
export function powBlockOn(branch: Block[], address: string): Block {
	const parent = branch[branch.length - 1];
	const height = branch.length;
	const timestamp = parent.timestamp + BLOCK_TIME * 1000;
	const block = new Block(
		timestamp,
		[Transaction.coinbase(address, POW_BLOCK_REWARD, height, timestamp)],
		parent.hash,
		0,
		requiredBits(branch, height, false),
		height,
	);
	block.solve();
	return block;
}

/** `branch` plus `count` PoW blocks paying `address`, for building competing branches. */
export function extendBranch(branch: Block[], address: string, count: number): Block[] {
	const result = [...branch];
	for (let i = 0; i < count; i++) result.push(powBlockOn(result, address));
	return result;
}

/** Find a nonce that satisfies the block's own PoW check. */
export function solve(block: Block): Block {
	block.solve();
	return block;
}

/** Short PoW phase for PoS tests (must exceed STAKE_MIN_CONFIRMATIONS so kernels exist). */
export const POS_TEST_CUTOFF = 12;

export function openPosChain(dir: string): Blockchain {
	return openChain(dir, { powCutoffBlock: POS_TEST_CUTOFF });
}

/** Mine the PoW phase to `address`, then let STAKE_MIN_AGE pass so early coinbases can stake. */
export async function finishPowPhase(chain: Blockchain, address: string): Promise<void> {
	await mineBlocks(chain, address, POS_TEST_CUTOFF);
	advanceTime((STAKE_MIN_AGE + 60) * 1000);
}

/** First PoS grid slot after both the clock and the tip's timestamp. */
export function nextStakeTime(chain: Blockchain): number {
	const after = Math.max(Date.now(), chain.getLatestBlock().timestamp + 1);
	return Math.ceil(after / STAKE_TIMESTAMP_GRANULARITY) * STAKE_TIMESTAMP_GRANULARITY;
}

/** Try grid slots until the wallet finds a kernel; moves the clock to that slot. Not added. */
export function findStakeBlock(chain: Blockchain, wallet: Wallet, maxSlots = 100_000): Block {
	let slot = nextStakeTime(chain);
	for (let i = 0; i < maxSlots; i++, slot += STAKE_TIMESTAMP_GRANULARITY) {
		const block = chain.createStakeBlock(wallet, slot);
		if (block) {
			advanceTime(Math.max(0, slot - Date.now()));
			return block;
		}
	}
	throw new Error('no kernel found');
}

export async function stakeBlocks(chain: Blockchain, wallet: Wallet, count: number): Promise<Block[]> {
	const blocks: Block[] = [];
	for (let i = 0; i < count; i++) {
		const block = findStakeBlock(chain, wallet);
		await chain.addMinedBlock(block);
		blocks.push(block);
	}
	return blocks;
}
