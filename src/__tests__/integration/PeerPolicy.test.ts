// Peer limits and misbehavior (TASK-0020) over real WebSockets, in-process. Difficulty
// validation is off so blocks build instantly.
import { once } from 'events';
import * as net from 'net';
import * as path from 'path';
import WebSocket from 'ws';
import { Block } from '../../blockchain/Block.js';
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { Transaction } from '../../blockchain/Transaction.js';
import {
	MAX_FUTURE_BLOCK_TIME,
	MAX_INBOUND_PEERS,
	MAX_OUTBOUND_PEERS,
	MAX_RECONNECT_ATTEMPTS,
	NETWORK_MAGIC,
	POW_BLOCK_REWARD,
	PROTOCOL_VERSION,
	RECONNECT_BASE_DELAY,
	RECONNECT_MAX_DELAY,
} from '../../config.js';
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

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** A PoW block on the tip at `timestamp` whose coinbase claims `claim`. */
function blockOnTip(chain: Blockchain, miner: string, timestamp: number, claim = POW_BLOCK_REWARD): Block {
	const tip = chain.getLatestBlock();
	const coinbase = Transaction.coinbase(miner, claim, tip.index + 1, timestamp);
	const block = new Block(timestamp, [coinbase], tip.hash, 0, chain.getRequiredBits(false), tip.index + 1);
	block.solve();
	return block;
}

describe('Peer limits and misbehavior', () => {
	let dir: string;
	let chain: Blockchain;
	let node: P2PServer;
	let port: number;
	const clients: WebSocket[] = [];

	beforeEach(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => {});
		jest.spyOn(console, 'error').mockImplementation(() => {});
		dir = makeTempDir();
		chain = openChain(dir, OPTIONS);
		port = await freePort();
		node = new P2PServer(chain, port, path.join(dir, 'peers.json'));
		await node.listen();
	});

	afterEach(async () => {
		clients.splice(0).forEach((client) => client.terminate());
		await node.close();
		removeTempDir(dir);
		jest.restoreAllMocks();
	});

	/** A raw peer that completes the handshake, announcing `listenPort`. */
	async function rawPeer(listenPort: number): Promise<WebSocket> {
		const client = new WebSocket(`ws://127.0.0.1:${port}`);
		clients.push(client);
		const ready = new Promise<void>((resolve) => {
			client.on('message', (raw: Buffer) => {
				if ((JSON.parse(raw.toString()) as { type: MessageType }).type === MessageType.VERACK) resolve();
			});
		});
		await once(client, 'open');
		const genesis = chain.getChain()[0].hash;
		client.send(
			JSON.stringify({
				type: MessageType.VERSION,
				data: { magic: NETWORK_MAGIC, version: PROTOCOL_VERSION, genesisHash: genesis, height: 0, tip: genesis, nonce: `raw-${listenPort}`, listenPort },
			}),
		);
		client.send(JSON.stringify({ type: MessageType.VERACK }));
		await ready;
		await waitUntil(() => node.getPeerInfo().some((p) => p.address.endsWith(`:${listenPort}`)));
		return client;
	}

	const scoreOf = (listenPort: number) =>
		[...node['_peerState'].values()].find((s) => s.version?.listenPort === listenPort)?.score;

	it('should ban a peer whose blocks are invalid, by IP and listen port on loopback', async () => {
		const miner = openWallet(dir, 'miner').address;
		const bad = await rawPeer(40_001);
		const overpaying = blockOnTip(chain, miner, chain.getLatestBlock().timestamp + 30_000, POW_BLOCK_REWARD + 1n);

		bad.send(JSON.stringify({ type: MessageType.BLOCK, data: overpaying }));
		await waitUntil(() => scoreOf(40_001) === 50);
		bad.send(JSON.stringify({ type: MessageType.BLOCK, data: { not: 'a block' } }));
		await once(bad, 'close');

		expect(node.isBanned('127.0.0.1:40001')).toBe(true);
		// The same peer is refused at the handshake; another local node is not affected
		const again = new WebSocket(`ws://127.0.0.1:${port}`);
		clients.push(again);
		await once(again, 'open');
		const genesis = chain.getChain()[0].hash;
		again.send(
			JSON.stringify({
				type: MessageType.VERSION,
				data: { magic: NETWORK_MAGIC, version: PROTOCOL_VERSION, genesisHash: genesis, height: 0, tip: genesis, nonce: 'again', listenPort: 40_001 },
			}),
		);
		await once(again, 'close');
		await expect(rawPeer(40_002)).resolves.toBeDefined();
	});

	it('should not count rejections an honest peer can cause', async () => {
		const miner = openWallet(dir, 'miner').address;
		const peer = await rawPeer(40_003);
		const future = blockOnTip(chain, miner, Date.now() + MAX_FUTURE_BLOCK_TIME + 60_000); // our clock may lag
		const known = chain.getLatestBlock(); // already have it

		peer.send(JSON.stringify({ type: MessageType.BLOCK, data: future }));
		peer.send(JSON.stringify({ type: MessageType.BLOCK, data: known }));
		peer.send(JSON.stringify({ type: MessageType.TRANSACTION, data: { not: 'a tx' } })); // malformed: counts
		await waitUntil(() => scoreOf(40_003) === 20);

		expect(scoreOf(40_003)).toBe(20); // only the malformed transaction
		expect(chain.hasBlock(future.hash)).toBe(false);
	});

	it(`should refuse inbound connections beyond ${MAX_INBOUND_PEERS}`, async () => {
		for (let i = 0; i < MAX_INBOUND_PEERS; i++) {
			const client = new WebSocket(`ws://127.0.0.1:${port}`);
			clients.push(client);
			await once(client, 'open');
		}
		await waitUntil(() => node.getSockets().length === MAX_INBOUND_PEERS);

		const extra = new WebSocket(`ws://127.0.0.1:${port}`);
		clients.push(extra);
		const [code] = (await once(extra, 'close')) as [number];

		expect(code).toBe(1013);
		expect(node.getSockets()).toHaveLength(MAX_INBOUND_PEERS);
	});

	it(`should dial at most ${MAX_OUTBOUND_PEERS} peers`, async () => {
		const ports = await Promise.all(Array.from({ length: MAX_OUTBOUND_PEERS + 3 }, freePort));

		node.connectToPeers(ports.map((p) => `ws://127.0.0.1:${p}`)); // nothing listens: dials pending

		expect(node['connectedPeers'].size).toBe(MAX_OUTBOUND_PEERS);
		expect(node.getKnownPeers()).toHaveLength(MAX_OUTBOUND_PEERS + 3); // the rest stay known
	});

	it('should back off reconnects exponentially up to the cap, then stop', () => {
		jest.useFakeTimers();
		try {
			const attempts: number[] = [];
			const start = Date.now();
			jest.spyOn(node as unknown as { _dial: (url: string, onFail?: () => void) => void }, '_dial').mockImplementation(
				(_url, onFail) => {
					attempts.push(Date.now() - start);
					onFail?.(); // unreachable
				},
			);

			node['reconnectToPeer']('ws://127.0.0.1:1');
			jest.runAllTimers();

			const delays = attempts.map((t, i) => t - (attempts[i - 1] ?? 0));
			const expected = Array.from({ length: MAX_RECONNECT_ATTEMPTS }, (_, i) =>
				Math.min(RECONNECT_BASE_DELAY * 2 ** i, RECONNECT_MAX_DELAY),
			);
			expect(delays).toEqual(expected);
		} finally {
			jest.useRealTimers();
		}
	});
});
