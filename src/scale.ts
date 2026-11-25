// Scale measurement (TASK-0052): `npm run scale [-- --blocks <n>] [--batch <n>]`. Builds a chain
// in-process in a temp dir, one signed payment per block, on a simulated clock (30 s per block)
// with difficulty validation off, and reports per batch how long accepting a block takes
// (`addMinedBlock`), the heap and the size of index.dat; then the chain database's size, how long
// a start takes from it and with --reindex, and the time per block to sync the chain into a new
// node in batches as a peer sends them (`addBlocks`, TASK-0054). Run it before and after a change
// to storage or chain state to see how costs grow with the chain. Uses plain console output (a
// script, like smoke).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Blockchain, type BlockchainOptions } from './blockchain/Blockchain.js';
import { Wallet } from './blockchain/Wallet.js';
import { BLOCK_TIME, COIN, COIN_MATURITY, GENESIS_TIMESTAMP, SYNC_BATCH_SIZE } from './config.js';
import { setLogLevel } from './logger.js';

function option(name: string, fallback: number): number {
	const index = process.argv.indexOf(name);
	const value = index > 0 ? Number(process.argv[index + 1]) : fallback;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} needs a positive whole number`);
	return value;
}

const BLOCKS = option('--blocks', 16_000);
const BATCH = option('--batch', 4_000);

// Payments are dated by the clock and must not be later than their block (consensus)
let now = GENESIS_TIMESTAMP + 24 * 60 * 60 * 1000;
Date.now = () => now;
setLogLevel('warn');

const gc = (globalThis as { gc?: () => void }).gc;
const heapMb = () => {
	gc?.();
	return (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0);
};
const kb = (file: string) => (fs.statSync(file).size / 1024).toFixed(0);

function timed<T>(action: () => T): [T, string] {
	const start = performance.now();
	const result = action();
	return [result, (performance.now() - start).toFixed(0)];
}

/** Build the chain and report per batch. */
async function build(dir: string, options: BlockchainOptions & { blocksDir: string }): Promise<void> {
	const miner = new Wallet(path.join(dir, 'miner.dat'));
	const receiver = new Wallet(path.join(dir, 'receiver.dat'));
	const chain = new Blockchain(options);
	for (let height = 0; height < BLOCKS; ) {
		let accepting = 0;
		const end = Math.min(height + BATCH, BLOCKS);
		for (const first = height; height < end; height++) {
			now += BLOCK_TIME * 1000;
			if (height > COIN_MATURITY) {
				const { transaction } = chain.createPayment(miner, [{ address: receiver.address, amount: COIN / 100n }]);
				await chain.addTransaction(transaction);
			}
			const block = chain.createBlockTemplate(miner.address, now);
			block.solve();
			const start = performance.now();
			await chain.addMinedBlock(block);
			accepting += performance.now() - start;
			if (height === end - 1) {
				const perBlock = (accepting / (end - first)).toFixed(2);
				console.log(`[scale] blocks ${first + 1}-${end}: accept ${perBlock} ms/block, heap ${heapMb()} MB, index.dat ${kb(path.join(options.blocksDir, 'index.dat'))} KB`);
			}
		}
	}
	if (chain.getPendingTransactions().length > 1) throw new Error('payments are not being mined');
	chain.close();
	console.log(`[scale] chain.db ${kb(path.join(options.blocksDir, 'chain.db'))} KB`);
}

/** A new node syncing `source`'s chain: batches of SYNC_BATCH_SIZE blocks, as a peer serves them. */
async function sync(source: Blockchain, options: BlockchainOptions): Promise<void> {
	const target = new Blockchain(options);
	let accepting = 0;
	for (;;) {
		const batch = source.getBlocksAfter(target.getBlockLocator(), SYNC_BATCH_SIZE);
		if (batch.length === 0) break;
		const start = performance.now();
		await target.addBlocks(batch);
		accepting += performance.now() - start;
	}
	if (target.getLatestBlock().hash !== source.getLatestBlock().hash) throw new Error('the synced node has another tip');
	console.log(`[scale] sync into a new node: ${(accepting / target.getHeight()).toFixed(2)} ms/block (${(accepting / 1000).toFixed(1)} s)`);
	target.close();
}

async function main(): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blockchain-ts-scale-'));
	const options = { validateDifficulty: false, powCutoffBlock: Number.MAX_SAFE_INTEGER, blocksDir: path.join(dir, 'blocks') };
	try {
		console.log(`[scale] ${BLOCKS} blocks, one payment each${gc ? '' : ' (heap without GC: run through npm run scale)'}`);
		await build(dir, options); // the chain it built is garbage now: the next heap figures are a started node's
		const [fromState, stateMs] = timed(() => new Blockchain(options));
		console.log(`[scale] start from the chain database: ${stateMs} ms (height ${fromState.getHeight()}), heap ${heapMb()} MB`);
		fromState.close();
		const [reindexed, reindexMs] = timed(() => new Blockchain({ ...options, reindex: true }));
		console.log(`[scale] start with --reindex: ${reindexMs} ms (height ${reindexed.getHeight()})`);
		await sync(reindexed, { ...options, blocksDir: path.join(dir, 'synced') });
		reindexed.close();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

main().catch((error: Error) => {
	console.error(`[scale] FAIL: ${error.message}`);
	process.exitCode = 1;
});
