// Relay (TASK-0014): three real nodes in a line, A – B – C (discovery disabled so the line
// stays a line). Items reach C through B, each node processes each item once, and nothing
// flows back to its sender.
import * as net from 'net';
import * as path from 'path';
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { COIN, COIN_MATURITY } from '../../config.js';
import { P2PServer } from '../../networking/P2PServer.js';
import { makeTempDir, openChain, openWallet, removeTempDir } from './helpers.js';

const OPTIONS = { validateDifficulty: false, powCutoffBlock: 1000 };

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe('Relay across a line of nodes (real WebSockets)', () => {
	const dirs: string[] = [];
	const servers: P2PServer[] = [];

	async function startNode(): Promise<{ chain: Blockchain; node: P2PServer; port: number }> {
		const dir = makeTempDir();
		dirs.push(dir);
		const chain = openChain(dir, OPTIONS);
		const port = await freePort();
		const node = new P2PServer(chain, port, path.join(dir, 'peers.json'));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		jest.spyOn(node as any, '_handlePeersMessage').mockImplementation(() => {});
		servers.push(node);
		await node.listen();
		return { chain, node, port };
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

	it('should relay a transaction and a block from A to C through B, once each', async () => {
		const a = await startNode();
		const b = await startNode();
		const c = await startNode();
		const miner = openWallet(dirs[0], 'miner');
		for (let i = 0; i < COIN_MATURITY + 1; i++) {
			const block = a.chain.createBlockTemplate(miner.address, a.chain.getLatestBlock().timestamp + 30_000);
			block.solve();
			await a.chain.addMinedBlock(block);
		}
		b.node.connectToPeers([`ws://127.0.0.1:${a.port}`]);
		c.node.connectToPeers([`ws://127.0.0.1:${b.port}`]);
		const tipHash = a.chain.getLatestBlock().hash;
		await waitUntil(() => c.chain.getLatestBlock().hash === tipHash);

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const txHandled = [a, b, c].map(({ node }) => jest.spyOn(node as any, 'handleTransactionMessage'));
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const blockHandled = [a, b, c].map(({ node }) => jest.spyOn(node as any, 'handleBlockMessage'));

		const tx = a.chain.createTransaction(miner.address, openWallet(dirs[0], 'x').address, COIN, miner);
		await a.chain.addTransaction(tx);
		a.node.broadcastTransaction(tx);
		await waitUntil(() => c.chain.getPendingTransactions().length === 1);
		expect(c.chain.getPendingTransactions()[0].calculateHash()).toBe(tx.calculateHash());

		const block = a.chain.createBlockTemplate(miner.address, a.chain.getLatestBlock().timestamp + 30_000);
		block.solve();
		await a.chain.addMinedBlock(block);
		a.node.broadcastBlock(block);
		await waitUntil(() => c.chain.getLatestBlock().hash === block.hash);
		expect(c.chain.getPendingTransactions()).toHaveLength(0); // confirmed by the relayed block

		await settle(); // give any loop a chance to show up
		expect(txHandled.map((spy) => spy.mock.calls.length)).toEqual([0, 1, 1]);
		expect(blockHandled.map((spy) => spy.mock.calls.length)).toEqual([0, 1, 1]);
	}, 30_000);
});
