// Pending transactions across restarts and connections (TASK-0047): the mempool is saved at
// shutdown and re-admitted at startup, and peers exchange the txids of their pending
// transactions after the handshake, requesting the ones they lack once they have the peer's chain.
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { Block } from '../../blockchain/Block.js';
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { Transaction } from '../../blockchain/Transaction.js';
import type { Wallet } from '../../blockchain/Wallet.js';
import { BLOCK_TIME, COIN, COIN_MATURITY, POW_BLOCK_REWARD } from '../../config.js';
import { MessageType, P2PServer } from '../../networking/P2PServer.js';
import { advanceTime, makeTempDir, mineBlocks, openChain, openWallet, removeTempDir, useTestClock } from './helpers.js';

const pendingTxids = (chain: Blockchain) => chain.getPendingTransactions().map((tx) => tx.calculateHash());

describe('Pending transactions across restarts', () => {
	let dir: string;
	let miner: Wallet;
	let errors: jest.SpyInstance;
	let logs: jest.SpyInstance;

	beforeEach(() => {
		useTestClock();
		logs = jest.spyOn(console, 'log').mockImplementation(() => {});
		errors = jest.spyOn(console, 'error').mockImplementation(() => {});
		dir = makeTempDir();
		miner = openWallet(dir, 'miner');
	});

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
		removeTempDir(dir);
	});

	const logged = (spy: jest.SpyInstance) => spy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');

	it('should re-admit the transactions pending at shutdown, and drop those spent meanwhile', async () => {
		const chain = openChain(dir);
		const [alice, bob] = [openWallet(dir, 'alice'), openWallet(dir, 'bob')];
		await mineBlocks(chain, miner.address, COIN_MATURITY + 2);
		const keep = chain.createTransaction(miner.address, alice.address, COIN, miner);
		await chain.addTransaction(keep);
		const doomed = chain.createTransaction(miner.address, bob.address, COIN, miner);
		await chain.addTransaction(doomed);
		chain.saveMempool();
		expect(logged(logs)).toContain('saved 2 pending transaction(s)');

		// While "down", a block confirms another spend of the doomed payment's input
		const input = doomed.inputs[0];
		const amount = chain.getUTXO(input.previousTx, input.outputIndex)!.output.amount;
		const conflict = new Transaction([{ ...input, publicKey: '', signature: '' }], [{ address: alice.address, amount }], Date.now());
		miner.signTransaction(conflict);
		advanceTime(BLOCK_TIME * 1000);
		const tip = chain.getLatestBlock();
		const block = new Block(
			Date.now(),
			[Transaction.coinbase(miner.address, POW_BLOCK_REWARD, tip.index + 1, Date.now()), conflict],
			tip.hash,
			0,
			chain.getRequiredBits(false),
			tip.index + 1,
		);
		block.solve();
		await chain.addMinedBlock(block);

		for (const options of [{}, { useChainstate: false }]) {
			logs.mockClear();
			const restarted = openChain(dir, options);
			expect(pendingTxids(restarted)).toEqual([keep.calculateHash()]);
			expect(logged(logs)).toContain('Mempool loaded: 1 pending transaction(s), 1 no longer valid');
		}
		expect(errors).not.toHaveBeenCalled(); // no WARN or ERROR line: smoke would fail on one
	});

	it('should keep the arrival order and start empty when nothing was saved', async () => {
		const chain = openChain(dir);
		await mineBlocks(chain, miner.address, COIN_MATURITY + 3);
		const payments = [];
		for (let i = 0; i < 3; i++) {
			const payment = chain.createTransaction(miner.address, openWallet(dir, `payee${i}`).address, COIN, miner);
			await chain.addTransaction(payment);
			payments.push(payment.calculateHash());
		}
		expect(pendingTxids(openChain(dir))).toEqual([]); // not saved yet
		chain.saveMempool();

		expect(pendingTxids(openChain(dir))).toEqual(payments);
		expect(fs.existsSync(path.join(dir, 'blocks', 'mempool.json.tmp'))).toBe(false); // written atomically
	});

	it('should ignore a damaged mempool file with a warning', () => {
		openChain(dir);
		fs.writeFileSync(path.join(dir, 'blocks', 'mempool.json'), '{"version":1,"transactions":[{"inputs":"nope"}]}');

		const chain = openChain(dir);

		expect(pendingTxids(chain)).toEqual([]);
		expect(logged(errors)).toMatch(/WARN .*ignoring the saved mempool/);
	});
});

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

async function waitUntil(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const OPTIONS = { validateDifficulty: false, powCutoffBlock: 1000 };

describe('Pending transactions between peers (real WebSockets)', () => {
	const dirs: string[] = [];
	const servers: P2PServer[] = [];

	async function startNode(): Promise<{ dir: string; chain: Blockchain; node: P2PServer; url: string }> {
		const dir = makeTempDir();
		dirs.push(dir);
		const chain = openChain(dir, OPTIONS);
		const port = await freePort();
		const node = new P2PServer(chain, port, path.join(dir, 'peers.json'));
		servers.push(node);
		await node.listen();
		return { dir, chain, node, url: `ws://127.0.0.1:${port}` };
	}

	/** Blocks with mature coins for `miner` on `chain`, 30 s apart and never dated after now. */
	async function fund(chain: Blockchain, miner: Wallet, count = COIN_MATURITY + 2): Promise<void> {
		for (let i = 0; i < count; i++) {
			const block = chain.createBlockTemplate(miner.address, Math.max(chain.getLatestBlock().timestamp + 30_000, Date.now()));
			block.solve();
			await chain.addMinedBlock(block);
		}
	}

	beforeEach(() => {
		jest.spyOn(console, 'log').mockImplementation(() => {});
		jest.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => server.close()));
		dirs.splice(0).forEach(removeTempDir);
		jest.restoreAllMocks();
	});

	it('should give a new peer that is behind the pending transactions once it has caught up', async () => {
		const a = await startNode();
		const miner = openWallet(a.dir, 'miner');
		await fund(a.chain, miner);
		const payment = a.chain.createTransaction(miner.address, openWallet(a.dir, 'payee').address, COIN, miner);
		await a.chain.addTransaction(payment); // no peers yet: never relayed
		const b = await startNode(); // genesis only: the payment's inputs are in blocks it lacks
		b.node['_markSeen'](`t:${payment.calculateHash()}`); // as if relayed (and rejected) while behind

		b.node.connectToPeers([a.url]);
		await waitUntil(() => pendingTxids(b.chain).includes(payment.calculateHash()));

		expect(b.chain.getLatestBlock().hash).toBe(a.chain.getLatestBlock().hash);
	});

	it('should exchange pending transactions in both directions', async () => {
		const a = await startNode();
		const b = await startNode();
		const miner = openWallet(a.dir, 'miner');
		await fund(a.chain, miner);
		for (const block of a.chain.getChain().slice(1)) await b.chain.addMinedBlock(block);
		const toA = a.chain.createTransaction(miner.address, openWallet(a.dir, 'x').address, COIN, miner);
		await a.chain.addTransaction(toA);
		const toB = a.chain.createTransaction(miner.address, openWallet(a.dir, 'y').address, COIN, miner); // other inputs
		await b.chain.addTransaction(toB);

		b.node.connectToPeers([a.url]);
		const both = [toA.calculateHash(), toB.calculateHash()].sort();
		await waitUntil(() => pendingTxids(a.chain).length === 2 && pendingTxids(b.chain).length === 2);

		expect(pendingTxids(a.chain).sort()).toEqual(both);
		expect(pendingTxids(b.chain).sort()).toEqual(both);
	});

	it('should send only announced transactions, each once, and penalize malformed lists', async () => {
		const a = await startNode();
		const b = await startNode();
		const miner = openWallet(a.dir, 'miner');
		await fund(a.chain, miner);
		const announced = a.chain.createTransaction(miner.address, openWallet(a.dir, 'x').address, COIN, miner);
		await a.chain.addTransaction(announced);
		b.node.connectToPeers([a.url]);
		await waitUntil(() => pendingTxids(b.chain).length === 1);
		const later = a.chain.createTransaction(miner.address, openWallet(a.dir, 'y').address, COIN, miner);
		await a.chain.addTransaction(later); // pending after the handshake: not in A's MEMPOOL to B

		const socket = a.node['sockets'][0];
		const spied = a.node as unknown as {
			_send(socket: unknown, message: { type: string }): void;
			_misbehaving(socket: unknown, points: number, reason: string): void;
		};
		const send = jest.spyOn(spied, '_send');
		const misbehaving = jest.spyOn(spied, '_misbehaving');
		a.node['_handleGetTransactions'](socket, { txids: [announced.calculateHash(), later.calculateHash(), 'f'.repeat(64)] });

		expect(send).not.toHaveBeenCalled(); // the announced one was already sent; the others never announced
		a.node['_peerState'].get(socket)!.announced.add(later.calculateHash());
		a.node['_handleGetTransactions'](socket, { txids: [later.calculateHash()] });
		a.node['_handleGetTransactions'](socket, { txids: [later.calculateHash()] });
		expect(send.mock.calls.map(([, message]) => message.type)).toEqual([MessageType.TRANSACTION]);

		a.node['_handleGetTransactions'](socket, { txids: ['not a txid'] });
		a.node['_handleMempool'](socket, { txids: Array.from({ length: 5001 }, () => 'a'.repeat(64)) });
		expect(misbehaving.mock.calls.map(([, points, reason]) => [points, reason])).toEqual([
			[10, 'malformed GET_TRANSACTIONS'],
			[10, 'malformed MEMPOOL'],
		]);
	});
});
