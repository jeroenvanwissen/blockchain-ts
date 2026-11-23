// Peer handshake and incremental sync (TASK-0013) over real WebSockets, in-process.
// Difficulty validation is off and the PoW phase is long, so hundreds of blocks build instantly;
// real timers throughout.
import { once } from 'events';
import * as net from 'net';
import * as path from 'path';
import WebSocket from 'ws';
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { NETWORK_MAGIC, PROTOCOL_VERSION, MAX_MESSAGE_BYTES, SYNC_BATCH_SIZE } from '../../config.js';
import { MessageType, P2PServer } from '../../networking/P2PServer.js';
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

/** Append `count` blocks 30 s apart (easy targets: difficulty validation is off). */
async function buildBlocks(chain: Blockchain, miner: string, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		const block = chain.createBlockTemplate(miner, chain.getLatestBlock().timestamp + 30_000);
		block.solve();
		await chain.addMinedBlock(block);
	}
}

describe('Peer handshake and sync (real WebSockets)', () => {
	const dirs: string[] = [];
	const servers: P2PServer[] = [];

	async function startNode(name: string): Promise<{ chain: Blockchain; node: P2PServer; port: number }> {
		const dir = makeTempDir();
		dirs.push(dir);
		const chain = openChain(dir, OPTIONS);
		const port = await freePort();
		const node = new P2PServer(chain, port, path.join(dir, `${name}-peers.json`));
		servers.push(node);
		await node.listen();
		return { chain, node, port };
	}

	function rawVersion(genesisHash: string, overrides: Record<string, unknown> = {}): string {
		return JSON.stringify({
			type: MessageType.VERSION,
			data: {
				magic: NETWORK_MAGIC,
				version: PROTOCOL_VERSION,
				genesisHash,
				height: 0,
				tip: genesisHash,
				nonce: 'raw-client',
				listenPort: 0,
				...overrides,
			},
		});
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

	it(`should sync 500 blocks from a peer in batches of ${SYNC_BATCH_SIZE}`, async () => {
		const a = await startNode('a');
		const b = await startNode('b');
		await buildBlocks(a.chain, openWallet(dirs[0], 'miner').address, 500);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const batches = jest.spyOn(b.node as any, '_handleBlocks');

		b.node.connectToPeers([`ws://127.0.0.1:${a.port}`]);
		await waitUntil(() => b.chain.getLatestBlock().hash === a.chain.getLatestBlock().hash);

		expect(b.chain.getChain()).toHaveLength(501);
		expect(batches.mock.calls.length).toBeGreaterThanOrEqual(Math.ceil(500 / SYNC_BATCH_SIZE));
		expect(b.chain.isChainValid()).toBe(true);
	});

	it('should fetch missing blocks when a relayed block has an unknown parent', async () => {
		const a = await startNode('a');
		const b = await startNode('b');
		const miner = openWallet(dirs[0], 'miner').address;
		await buildBlocks(a.chain, miner, 3);
		b.node.connectToPeers([`ws://127.0.0.1:${a.port}`]);
		await waitUntil(() => b.chain.getChain().length === 4);

		await buildBlocks(a.chain, miner, 2); // not announced
		a.node.broadcastBlock(a.chain.getLatestBlock()); // only the newest: B lacks its parent

		await waitUntil(() => b.chain.getLatestBlock().hash === a.chain.getLatestBlock().hash);
		expect(b.chain.getChain()).toHaveLength(6);
	});

	it('should disconnect a peer with a different genesis', async () => {
		const a = await startNode('a');
		const client = new WebSocket(`ws://127.0.0.1:${a.port}`);
		await once(client, 'open');
		client.send(rawVersion('ab'.repeat(32)));

		await once(client, 'close');
		await waitUntil(() => a.node.getSockets().length === 0); // server side closes too
		expect(a.node.getSockets()).toHaveLength(0);
	});

	it('should detect and drop a connection to itself', async () => {
		const a = await startNode('a');
		const socket = new WebSocket(`ws://127.0.0.1:${a.port}`);
		await once(socket, 'open');
		a.node['connectSocket'](socket); // the node dials its own port

		await waitUntil(() => socket.readyState === WebSocket.CLOSED);
		await waitUntil(() => a.node.getSockets().length === 0);
		expect(socket.readyState).toBe(WebSocket.CLOSED);
	});

	it('should ignore malformed and oversized messages and keep serving peers', async () => {
		const a = await startNode('a');
		const genesis = a.chain.getChain()[0].hash;

		const noisy = new WebSocket(`ws://127.0.0.1:${a.port}`);
		await once(noisy, 'open');
		noisy.send('not json');
		noisy.send(JSON.stringify({ type: MessageType.BLOCKS, data: { blocks: [{}] } })); // before handshake
		noisy.send(JSON.stringify(42));
		noisy.send(rawVersion(genesis, { tip: 'bad' }));
		await once(noisy, 'close');

		const oversized = new WebSocket(`ws://127.0.0.1:${a.port}`);
		await once(oversized, 'open');
		oversized.send('x'.repeat(MAX_MESSAGE_BYTES + 1));
		await once(oversized, 'close');

		const good = new WebSocket(`ws://127.0.0.1:${a.port}`);
		const replies: string[] = [];
		good.on('message', (data: Buffer) => replies.push((JSON.parse(data.toString()) as { type: string }).type));
		await once(good, 'open');
		good.send(rawVersion(genesis));
		await waitUntil(() => replies.includes(MessageType.VERACK));
		expect(replies).toContain(MessageType.VERACK);
		good.close();
	});
});
