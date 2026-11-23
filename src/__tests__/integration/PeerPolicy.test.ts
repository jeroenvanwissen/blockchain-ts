// Peer limits and misbehavior (TASK-0020) over real WebSockets, in-process. Difficulty
// validation is off so blocks build instantly.
import { once } from 'events';
import * as fs from 'fs';
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
	MAX_PENDING_GET_BLOCKS,
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
	let banListPath: string;
	const clients: WebSocket[] = [];

	beforeEach(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => {});
		jest.spyOn(console, 'error').mockImplementation(() => {});
		dir = makeTempDir();
		chain = openChain(dir, OPTIONS);
		port = await freePort();
		banListPath = path.join(dir, 'banned.json');
		node = new P2PServer(chain, port, path.join(dir, 'peers.json'), { banListPath });
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
		// The ban survives a restart: a new node reads it from the ban list
		const restarted = new P2PServer(chain, await freePort(), path.join(dir, 'peers2.json'), { banListPath });
		expect(restarted.isBanned('127.0.0.1:40001')).toBe(true);
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

	it('should reject listen() when the port is taken, instead of running without accepting peers', async () => {
		const second = new P2PServer(chain, port, path.join(dir, 'peers2.json'));

		await expect(second.listen()).rejects.toThrow('EADDRINUSE');
		await second.close();
		expect(node.getSockets()).toHaveLength(0); // the first server is unaffected
	});

	it('should drop expired bans when loading the ban list', () => {
		fs.writeFileSync(banListPath, JSON.stringify({ '10.0.0.1': Date.now() - 1, '10.0.0.2': Date.now() + 60_000 }));

		const loaded = new P2PServer(chain, port + 1, path.join(dir, 'peers2.json'), { banListPath });

		expect(loaded.isBanned('10.0.0.1')).toBe(false);
		expect(loaded.isBanned('10.0.0.2')).toBe(true);
	});

	it(`should serve block requests one at a time and count more than ${MAX_PENDING_GET_BLOCKS} waiting as flooding`, async () => {
		const peer = await rawPeer(40_004);
		let replies = 0;
		peer.on('message', (raw: Buffer) => {
			if ((JSON.parse(raw.toString()) as { type: MessageType }).type === MessageType.BLOCKS) replies++;
		});
		const request = JSON.stringify({ type: MessageType.GET_BLOCKS, data: { locator: [chain.getChain()[0].hash] } });

		for (let i = 0; i < 10; i++) peer.send(request);
		await waitUntil(() => replies === MAX_PENDING_GET_BLOCKS);
		await new Promise((resolve) => setTimeout(resolve, 300)); // no more replies come

		expect(replies).toBe(MAX_PENDING_GET_BLOCKS);
		expect(scoreOf(40_004)).toBe((10 - MAX_PENDING_GET_BLOCKS) * 10);
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
