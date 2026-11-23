// One connection per peer node (TASK-0044), over real WebSockets in-process: a node dialed under
// two addresses, and two nodes dialing each other, end up with one connection, the same at both
// ends, and the closed address isn't redialed.
import * as net from 'net';
import * as path from 'path';
import { P2PServer } from '../../networking/P2PServer.js';
import { makeTempDir, openChain, removeTempDir } from './helpers.js';

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

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe('One connection per peer node', () => {
	let dir: string;
	const nodes: P2PServer[] = [];

	beforeEach(() => {
		jest.spyOn(console, 'log').mockImplementation(() => {});
		dir = makeTempDir();
	});

	afterEach(async () => {
		await Promise.all(nodes.splice(0).map((node) => node.close()));
		removeTempDir(dir);
		jest.restoreAllMocks();
	});

	async function start(name: string): Promise<{ node: P2PServer; url: string; nonce: string }> {
		const port = await freePort();
		const chain = openChain(path.join(dir, name), { validateDifficulty: false });
		const node = new P2PServer(chain, port, path.join(dir, name, 'peers.json'));
		await node.listen();
		nodes.push(node);
		return { node, url: `ws://127.0.0.1:${port}`, nonce: node['_nonce'] };
	}

	it('should keep one connection to a node dialed under two addresses, and not redial the other', async () => {
		const a = await start('a');
		const b = await start('b');

		b.node.connectToPeers([a.url, a.url.replace('127.0.0.1', 'localhost')]);
		await waitUntil(() => b.node.getPeerInfo().length >= 1 && a.node.getPeerInfo().length >= 1);
		await settle();

		expect(b.node.getPeerInfo()).toHaveLength(1);
		expect(a.node.getPeerInfo()).toHaveLength(1);
		b.node.fillOutbound();
		await settle();
		expect(b.node.getPeerInfo()).toHaveLength(1);
		expect(b.node['connectedPeers'].size).toBe(1); // no dial in progress to the alias either
	});

	it('should keep the connection dialed by the lower nonce when two nodes dial each other', async () => {
		// Fresh nodes each round: new nonces, so both orders of nonces and handshakes occur
		for (let round = 0; round < 4; round++) {
			const a = await start(`a${round}`);
			const b = await start(`b${round}`);

			a.node.connectToPeers([b.url]);
			b.node.connectToPeers([a.url]);
			await waitUntil(() => a.node.getPeerInfo().length >= 1 && b.node.getPeerInfo().length >= 1);
			await settle();

			const [lower, higher] = a.nonce < b.nonce ? [a, b] : [b, a];
			expect(lower.node.getPeerInfo().map((peer) => peer.inbound)).toEqual([false]);
			expect(higher.node.getPeerInfo().map((peer) => peer.inbound)).toEqual([true]);
			higher.node.fillOutbound();
			await settle();
			expect(higher.node.getPeerInfo()).toHaveLength(1);
			await Promise.all(nodes.splice(0).map((node) => node.close()));
		}
	});
});
