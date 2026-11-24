// The port a node announces (TASK-0050): P2P_EXTERNAL_PORT when peers reach it under another port
// than the one it listens on (a published Docker port, a router's forward). Real WebSockets.
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

describe('Announced listen port', () => {
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

	async function start(name: string, externalPort?: number): Promise<{ node: P2PServer; port: number }> {
		const port = await freePort();
		const chain = openChain(path.join(dir, name), { validateDifficulty: false });
		const node = new P2PServer(chain, port, path.join(dir, name, 'peers.json'), { externalPort });
		await node.listen();
		nodes.push(node);
		return { node, port };
	}

	it('should announce the external port, so peers learn the address they can dial', async () => {
		const a = await start('a');
		const b = await start('b', 45678); // say B's port 45678 is forwarded to the port it listens on

		b.node.connectToPeers([`ws://127.0.0.1:${a.port}`]);
		await waitUntil(() => a.node.getPeerInfo().length === 1);

		expect(a.node.getPeerInfo()[0].address).toBe('127.0.0.1:45678'); // inbound on loopback: IP and announced port
		expect(a.node.getKnownPeers()).toContain('ws://127.0.0.1:45678');
		expect(a.node.getKnownPeers()).not.toContain(`ws://127.0.0.1:${b.port}`);
		expect(b.node['_versionPayload']().listenPort).toBe(45678);
		expect(a.node['_versionPayload']().listenPort).toBe(a.port); // default: the port it listens on
	});
});
