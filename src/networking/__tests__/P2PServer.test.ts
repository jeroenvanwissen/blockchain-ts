import { P2PServer, MessageType, isValidPeerAddress, type VersionPayload } from '../P2PServer.js';
import { NETWORK_MAGIC, PROTOCOL_VERSION, HANDSHAKE_TIMEOUT } from '../../config.js';
import { Blockchain } from '../../blockchain/Blockchain.js';
import { Block } from '../../blockchain/Block.js';
import { NULL_HASH, Transaction } from '../../blockchain/Transaction.js';
import WebSocket from 'ws';
import fs from 'fs';
import { EventEmitter } from 'events';

jest.mock('fs');
jest.mock('ws');

// Mock protobufjs to prevent real .proto file reads (fs is mocked)
jest.mock('protobufjs', () => {
	const mockType = {
		create: (obj: unknown) => obj,
		fromObject: (obj: unknown) => obj,
		encode: (obj: unknown) => ({
			finish: () => Buffer.from(JSON.stringify(obj)),
		}),
		decode: (buf: Buffer) => JSON.parse(buf.toString()) as unknown,
		verify: () => null,
		toObject: (obj: unknown) => obj,
	};
	return {
		__esModule: true,
		default: {
			parse: () => ({ root: { lookupType: () => mockType } }),
		},
	};
});

// Create a mock WebSocket class that extends EventEmitter
class MockWebSocket extends EventEmitter {
	public url: string;
	public readyState: number;
	public send: jest.Mock;
	public close: jest.Mock;
	public terminate: jest.Mock;

	constructor(url: string) {
		super();
		this.url = url;
		this.readyState = WebSocket.OPEN;
		this.send = jest.fn();
		this.close = jest.fn();
		this.terminate = jest.fn();
	}

	/** Messages this socket was asked to send, parsed. */
	sent(): { type: string; data?: unknown }[] {
		return this.send.mock.calls.map((call: [string]) => JSON.parse(call[0]) as { type: string; data?: unknown });
	}
}

// Update the WebSocket mock
(WebSocket as unknown as jest.Mock).mockImplementation(
	(url: string) => new MockWebSocket(url)
);

describe('P2PServer', () => {
	let blockchain: Blockchain;
	let p2pServer: P2PServer;
	let mockSocket: MockWebSocket;
	const peerDataPath = 'peers.json';

	const peerVersion = (overrides: Partial<VersionPayload> = {}): string =>
		JSON.stringify({
			type: MessageType.VERSION,
			data: {
				magic: NETWORK_MAGIC,
				version: PROTOCOL_VERSION,
				genesisHash: blockchain.getChain()[0].hash,
				height: 0,
				tip: blockchain.getChain()[0].hash,
				nonce: 'peer-nonce',
				listenPort: 0,
				...overrides,
			},
		});

	/**
	 * Connect a mock socket and complete the VERSION/VERACK handshake from the peer's side. Each
	 * socket is a different node (its own nonce): one node twice would be a duplicate (TASK-0044).
	 */
	const connectReady = (socket: MockWebSocket): void => {
		p2pServer['connectSocket'](socket as unknown as WebSocket);
		socket.emit('message', peerVersion({ nonce: `peer-nonce:${socket.url}` }));
		socket.emit('message', JSON.stringify({ type: MessageType.VERACK }));
	};

	beforeEach(() => {
		(fs.existsSync as jest.Mock).mockReturnValue(false); // the chain starts from an empty data dir
		blockchain = new Blockchain({ dbPath: ':memory:' }); // fs is mocked; SQLite isn't
		p2pServer = new P2PServer(blockchain, 5001, peerDataPath);
		mockSocket = new MockWebSocket('ws://test');
		jest.clearAllMocks();

		// Fix fs mocks
		(fs.readFile as unknown as jest.Mock).mockImplementation(
			(path, encoding, callback) => {
				callback(null, '[]');
			}
		);

		(fs.writeFile as unknown as jest.Mock).mockImplementation(
			(path, data, callback) => {
				callback(null);
			}
		);

		// Add sync fs mocks
		(fs.existsSync as jest.Mock).mockReturnValue(true);
		(fs.writeFileSync as jest.Mock).mockImplementation(() => {});

		// Suppress console output during tests
		jest.spyOn(console, 'log').mockImplementation(() => {});
		jest.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(async () => {
		await p2pServer.close(); // clears handshake timers of the mock sockets
	});

	it('should not add an address just because a socket connected', () => {
		// Addresses come from configured peers, PEERS messages and inbound listen ports only
		p2pServer['logPeerConnection']({ url: '' } as WebSocket);
		p2pServer['logPeerConnection']({ url: 'ws://valid-peer:5002' } as WebSocket);

		expect(p2pServer.getKnownPeers()).toHaveLength(0);
	});

	it('should keep every field (and the txid) of a relayed transaction', async () => {
		const privateKey = Buffer.alloc(32, 7);
		const tx = new Transaction(
			[{ previousTx: 'ab'.repeat(32), outputIndex: 0, publicKey: '', signature: '' }],
			[{ address: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', amount: 123n }],
			1_700_000_000_000,
		);
		tx.signTransaction(privateKey);
		const addSpy = jest.spyOn(blockchain, 'addTransaction').mockResolvedValue(undefined);

		await p2pServer['handleTransactionMessage'](JSON.parse(JSON.stringify(tx)));

		const received = addSpy.mock.calls[0][0];
		expect(received.calculateHash()).toBe(tx.calculateHash());
		expect(received.witnessHash()).toBe(tx.witnessHash());
		addSpy.mockRestore();
	});

	it('should drop a block that contains a malformed transaction', async () => {
		const block = new Block(Date.now(), [Transaction.coinbase('x', 1n, 1)], NULL_HASH, 0, undefined, 1);
		const wire = JSON.parse(JSON.stringify(block)) as { transactions: Record<string, unknown>[] };
		delete wire.transactions[0].outputs;
		const addSpy = jest.spyOn(blockchain, 'addMinedBlock').mockResolvedValue('connected');

		await p2pServer['handleBlockMessage'](wire);

		expect(addSpy).not.toHaveBeenCalled();
		addSpy.mockRestore();
	});

	// Fix the network disconnection test
	it('should handle network disconnection', () => {
		const reconnectSpy = jest
			.spyOn(p2pServer as unknown as { reconnectToPeer(peer: string): Promise<void> }, 'reconnectToPeer')
			.mockImplementation();
		p2pServer['connectSocket'](mockSocket as unknown as WebSocket);

		mockSocket.emit('close');

		expect(reconnectSpy).toHaveBeenCalled();
		reconnectSpy.mockRestore();
	});

	// Fix the broadcast test
	it('should broadcast messages to all connected sockets', () => {
		const mockSocket1 = new MockWebSocket('ws://peer1');
		const mockSocket2 = new MockWebSocket('ws://peer2');
		const notReady = new MockWebSocket('ws://peer3');
		connectReady(mockSocket1);
		connectReady(mockSocket2);
		p2pServer['connectSocket'](notReady as unknown as WebSocket); // no handshake yet

		const transaction = new Transaction([], []);
		const message = {
			type: MessageType.TRANSACTION,
			data: transaction,
		};

		p2pServer['broadcast']({
			type: MessageType.TRANSACTION,
			data: transaction,
		});

		const sentMessage = JSON.stringify(message);
		expect(mockSocket1.send).toHaveBeenCalledWith(sentMessage);
		expect(mockSocket2.send).toHaveBeenCalledWith(sentMessage);
		expect(notReady.send).not.toHaveBeenCalledWith(sentMessage);
	});

	// Add test for socket error handling with proper error event
	it('should log socket errors (routine on P2P: info level) and forget the socket', () => {
		const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
		const mockError = new Error('Connection failed');

		p2pServer['connectSocket'](mockSocket as unknown as WebSocket);
		mockSocket.emit('error', mockError);

		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('INFO  [P2P] Socket connection error:'), 'Connection failed');
		expect(p2pServer.getSockets()).not.toContain(mockSocket);
		consoleSpy.mockRestore();
	});

	// Add test for message parsing with proper message event
	it('should count unparseable messages as misbehavior', () => {
		const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

		p2pServer['connectSocket'](mockSocket as unknown as WebSocket);
		mockSocket.emit('message', 'invalid-json');

		expect(p2pServer['_peerState'].get(mockSocket as unknown as WebSocket)?.score).toBe(20);
		expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Peer misbehaving (+20'));
		consoleSpy.mockRestore();
	});

	describe('isValidPeerAddress', () => {
		it('should accept valid ws:// addresses', () => {
			expect(isValidPeerAddress('ws://host:5001')).toBe(true);
		});

		it('should accept valid wss:// addresses', () => {
			expect(isValidPeerAddress('wss://host:5001')).toBe(true);
		});

		it('should reject addresses without protocol', () => {
			expect(isValidPeerAddress('host:5001')).toBe(false);
		});

		it('should reject addresses with invalid port', () => {
			expect(isValidPeerAddress('ws://host:99999')).toBe(false);
		});

		it('should reject addresses with port 0', () => {
			expect(isValidPeerAddress('ws://host:0')).toBe(false);
		});

		it('should reject addresses without port', () => {
			expect(isValidPeerAddress('ws://host')).toBe(false);
		});

		it('should reject empty string', () => {
			expect(isValidPeerAddress('')).toBe(false);
		});

		it('should reject addresses with whitespace in hostname', () => {
			expect(isValidPeerAddress('ws://ho st:5001')).toBe(false);
		});
	});

	describe('known peers', () => {
		it('should add peers to known set on connectToPeers', () => {
			p2pServer.connectToPeers(['ws://peer1:5001', 'ws://peer2:5002']);
			expect(p2pServer.getKnownPeers()).toContain('ws://peer1:5001');
			expect(p2pServer.getKnownPeers()).toContain('ws://peer2:5002');
		});

		it('should load initial peers into known set', () => {
			p2pServer.loadInitialPeers(['ws://seed1:5001', 'ws://seed2:5002']);
			expect(p2pServer.getKnownPeers()).toHaveLength(2);
		});

		it('should skip own addresses in known peers', () => {
			p2pServer.loadInitialPeers(['ws://localhost:5001']);
			expect(p2pServer.getKnownPeers()).toHaveLength(0);
		});

		it('should skip 127.0.0.1 own address', () => {
			p2pServer.loadInitialPeers(['ws://127.0.0.1:5001']);
			expect(p2pServer.getKnownPeers()).toHaveLength(0);
		});

		it('should skip invalid addresses in loadInitialPeers', () => {
			p2pServer.loadInitialPeers(['not-valid', 'ws://valid:5001']);
			expect(p2pServer.getKnownPeers()).toHaveLength(1);
		});

		it('should normalize bare host:port to ws:// in loadInitialPeers', () => {
			p2pServer.loadInitialPeers(['peer1:5002']);
			expect(p2pServer.getKnownPeers()).toContain('ws://peer1:5002');
		});
	});

	describe('PEERS message handling', () => {
		it('should add valid peers from PEERS message', () => {
			p2pServer['_handlePeersMessage'](['ws://discovered1:5001', 'ws://discovered2:5002']);
			expect(p2pServer.getKnownPeers()).toContain('ws://discovered1:5001');
			expect(p2pServer.getKnownPeers()).toContain('ws://discovered2:5002');
		});

		it('should skip invalid addresses in PEERS message', () => {
			p2pServer['_handlePeersMessage'](['not-valid', 'ws://valid:5001']);
			expect(p2pServer.getKnownPeers()).toHaveLength(1);
			expect(p2pServer.getKnownPeers()[0]).toBe('ws://valid:5001');
		});

		it('should skip duplicate peers in PEERS message', () => {
			p2pServer.loadInitialPeers([], ['ws://existing:5001']);
			p2pServer['_handlePeersMessage'](['ws://existing:5001']);
			expect(p2pServer.getKnownPeers()).toHaveLength(1);
		});

		it('should skip non-array data in PEERS message', () => {
			p2pServer['_handlePeersMessage']('not-an-array');
			expect(p2pServer.getKnownPeers()).toHaveLength(0);
		});

		it('should skip non-string entries in PEERS message', () => {
			p2pServer['_handlePeersMessage']([123, null, 'ws://valid:5001']);
			expect(p2pServer.getKnownPeers()).toHaveLength(1);
		});

		it('should skip own addresses in PEERS message', () => {
			p2pServer['_handlePeersMessage'](['ws://localhost:5001', 'ws://remote:5002']);
			expect(p2pServer.getKnownPeers()).toHaveLength(1);
			expect(p2pServer.getKnownPeers()[0]).toBe('ws://remote:5002');
		});

		it('should not exceed MAX_KNOWN_PEERS', () => {
			// Fill up known peers to the limit (none has failed, so none can be replaced)
			p2pServer.loadInitialPeers([], Array.from({ length: 128 }, (_, i) => `ws://existing${i}:5001`));
			p2pServer['_handlePeersMessage'](['ws://new-peer:6001']);
			expect(p2pServer.getKnownPeers()).not.toContain('ws://new-peer:6001');
			expect(p2pServer.getKnownPeers()).toHaveLength(128);
		});

		it('should fill outbound slots at random after learning addresses, not dial the named ones', () => {
			const fillSpy = jest.spyOn(p2pServer, 'fillOutbound').mockImplementation();
			const connectSpy = jest.spyOn(p2pServer, 'connectToPeers');
			p2pServer['_handlePeersMessage'](['ws://new-peer:5001']);
			expect(fillSpy).toHaveBeenCalledTimes(1);
			expect(connectSpy).not.toHaveBeenCalled();
			fillSpy.mockRestore();
			connectSpy.mockRestore();
		});

		it('should not refill when a PEERS message teaches nothing new', () => {
			p2pServer.loadInitialPeers([], ['ws://existing:5001']);
			const fillSpy = jest.spyOn(p2pServer, 'fillOutbound').mockImplementation();
			p2pServer['_handlePeersMessage'](['ws://existing:5001']);
			expect(fillSpy).not.toHaveBeenCalled();
			fillSpy.mockRestore();
		});

		it('should not pass on learned addresses until they are verified', () => {
			jest.spyOn(p2pServer, 'fillOutbound').mockImplementation();
			p2pServer['_handlePeersMessage'](['ws://unverified:5001']);
			expect(p2pServer.getKnownPeers()).toContain('ws://unverified:5001');
			expect(p2pServer['_addresses'].shareable(32)).toEqual([]);
		});

		it('should persist peers after handling PEERS message', () => {
			const writeFileSyncMock = fs.writeFileSync as jest.Mock;
			p2pServer['_handlePeersMessage'](['ws://persist-me:5001']);
			expect(writeFileSyncMock).toHaveBeenCalledWith(
				peerDataPath,
				expect.stringContaining('persist-me:5001'),
			);
		});
	});

	describe('peer list exchange', () => {
		it('should send peer list on new connection', () => {
			p2pServer.loadInitialPeers(['ws://known-peer:5001']); // configured: shareable
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const reconnectSpy = jest.spyOn(p2pServer as any, 'reconnectToPeer').mockImplementation();
			connectReady(mockSocket);

			const sentMessages: { type: string; data?: string[] }[] = mockSocket.send.mock.calls.map(
				(call: [string]) => JSON.parse(call[0]) as { type: string; data?: string[] }
			);
			const peersMessage = sentMessages.find(msg => msg.type === 'PEERS');
			expect(peersMessage).toBeDefined();
			expect(peersMessage!.data).toContain('ws://known-peer:5001');
			reconnectSpy.mockRestore();
		});

		it('should not send peer list when no known peers', () => {
			const noUrlSocket = new MockWebSocket('');
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const reconnectSpy = jest.spyOn(p2pServer as any, 'reconnectToPeer').mockImplementation();
			connectReady(noUrlSocket);

			const sentMessages: { type: string }[] = noUrlSocket.send.mock.calls.map(
				(call: [string]) => JSON.parse(call[0]) as { type: string }
			);
			const peersMessage = sentMessages.find(msg => msg.type === 'PEERS');
			expect(peersMessage).toBeUndefined();
			reconnectSpy.mockRestore();
		});
	});

	describe('periodic peer broadcast', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			p2pServer['_stopPeerBroadcast']();
			jest.useRealTimers();
		});

		it('should broadcast peer list at configured interval', () => {
			p2pServer.loadInitialPeers(['ws://peer1:5001']); // configured: shareable
			const mockSocket1 = new MockWebSocket('ws://peer1:5001');
			connectReady(mockSocket1);
			mockSocket1.send.mockClear();

			p2pServer['_startPeerBroadcast']();
			jest.advanceTimersByTime(60_000);

			const sentMessages: { type: string; data?: string[] }[] = mockSocket1.send.mock.calls.map(
				(call: [string]) => JSON.parse(call[0]) as { type: string; data?: string[] }
			);
			const peersMessage = sentMessages.find(msg => msg.type === 'PEERS');
			expect(peersMessage).toBeDefined();
			expect(peersMessage!.data).toContain('ws://peer1:5001');
		});

		it('should not broadcast when no known peers', () => {
			const noUrlSocket = new MockWebSocket('');
			connectReady(noUrlSocket);
			noUrlSocket.send.mockClear();

			p2pServer['_startPeerBroadcast']();
			jest.advanceTimersByTime(60_000);

			expect(noUrlSocket.send).not.toHaveBeenCalled();
		});

		it('should not start multiple broadcast intervals', () => {
			p2pServer['_startPeerBroadcast']();
			const firstInterval = p2pServer['_peerBroadcastInterval'];
			p2pServer['_startPeerBroadcast']();
			expect(p2pServer['_peerBroadcastInterval']).toBe(firstInterval);
		});
	});

	describe('PEERS message routing', () => {
		it('should route PEERS message type to handler', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const handleSpy = jest.spyOn(p2pServer as any, '_handlePeersMessage');
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const reconnectSpy = jest.spyOn(p2pServer as any, 'reconnectToPeer').mockImplementation();
			connectReady(mockSocket);

			const peersMsg = JSON.stringify({
				type: MessageType.PEERS,
				data: ['ws://remote:5001'],
			});
			mockSocket.emit('message', peersMsg);

			expect(handleSpy).toHaveBeenCalledWith(['ws://remote:5001'], mockSocket);
			handleSpy.mockRestore();
			reconnectSpy.mockRestore();
		});
	});

	describe('peer persistence', () => {
		it('should write known peers to peerDataPath in host:port format', () => {
			const writeFileSyncMock = fs.writeFileSync as jest.Mock;
			p2pServer.loadInitialPeers(['ws://host1:5001', 'ws://host2:5002']);

			p2pServer['_persistPeers']();

			expect(writeFileSyncMock).toHaveBeenCalledWith(
				peerDataPath,
				expect.any(String),
			);
			const written = JSON.parse(
				writeFileSyncMock.mock.calls[writeFileSyncMock.mock.calls.length - 1][1] as string
			) as string[];
			expect(written).toContain('host1:5001');
			expect(written).toContain('host2:5002');
		});

		it('should handle write errors gracefully', () => {
			(fs.writeFileSync as jest.Mock).mockImplementationOnce(() => {
				throw new Error('disk full');
			});

			p2pServer.loadInitialPeers(['ws://host:5001']);
			p2pServer['_persistPeers']();

			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining('ERROR [P2P] Error writing peers.json:'),
				expect.any(Error),
			);
		});
	});

	describe('connectToPeers validation', () => {
		it('should skip invalid peer addresses', () => {
			p2pServer.connectToPeers(['not-a-url']);
			expect(p2pServer['connectedPeers'].size).toBe(0);
			expect(p2pServer.getKnownPeers()).toHaveLength(0);
		});

		it('should skip own addresses', () => {
			p2pServer.connectToPeers(['ws://localhost:5001']);
			expect(p2pServer['connectedPeers'].size).toBe(0);
		});

		it('should add valid peers to known set and connected set', () => {
			p2pServer.connectToPeers(['ws://remote:5002']);
			expect(p2pServer.getKnownPeers()).toContain('ws://remote:5002');
			expect(p2pServer['connectedPeers'].has('ws://remote:5002')).toBe(true);
		});
	});
	describe('handshake', () => {
		it('should send VERSION on connect and VERACK after a valid VERSION', () => {
			p2pServer['connectSocket'](mockSocket as unknown as WebSocket);
			expect(mockSocket.sent()[0]).toMatchObject({
				type: MessageType.VERSION,
				data: { magic: NETWORK_MAGIC, genesisHash: blockchain.getChain()[0].hash },
			});

			mockSocket.emit('message', peerVersion());
			expect(mockSocket.sent().map((m) => m.type)).toContain(MessageType.VERACK);
			expect(p2pServer['_isReady'](mockSocket as unknown as WebSocket)).toBe(false); // no VERACK yet
			mockSocket.emit('message', JSON.stringify({ type: MessageType.VERACK }));
			expect(p2pServer['_isReady'](mockSocket as unknown as WebSocket)).toBe(true);
		});

		it.each([
			['a different genesis', { genesisHash: 'ab'.repeat(32) }],
			['a different network', { magic: 'other-net' }],
			['another protocol version', { version: PROTOCOL_VERSION + 1 }],
			['a malformed VERSION', { tip: 'not-a-hash' }],
		])('should disconnect a peer with %s', (_what, overrides) => {
			p2pServer['connectSocket'](mockSocket as unknown as WebSocket);
			mockSocket.emit('message', peerVersion(overrides as Partial<VersionPayload>));
			expect(mockSocket.close).toHaveBeenCalled();
			expect(mockSocket.sent().map((m) => m.type)).not.toContain(MessageType.VERACK);
		});

		it('should detect a connection to itself and stop dialling that address', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const reconnectSpy = jest.spyOn(p2pServer as any, 'reconnectToPeer').mockImplementation();
			const selfSocket = new MockWebSocket('ws://my-lan-ip:5001');
			p2pServer['connectSocket'](selfSocket as unknown as WebSocket);
			selfSocket.emit('message', peerVersion({ nonce: p2pServer['_nonce'] }));
			selfSocket.emit('close');

			expect(selfSocket.close).toHaveBeenCalled();
			expect(p2pServer['_ownAddresses'].has('ws://my-lan-ip:5001')).toBe(true);
			expect(p2pServer.getKnownPeers()).not.toContain('ws://my-lan-ip:5001');
			expect(reconnectSpy).not.toHaveBeenCalled();
			reconnectSpy.mockRestore();
		});

		it('should ignore other messages before the handshake completes', () => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const handleSpy = jest.spyOn(p2pServer as any, '_handlePeersMessage');
			p2pServer['connectSocket'](mockSocket as unknown as WebSocket);
			mockSocket.emit('message', JSON.stringify({ type: MessageType.PEERS, data: ['ws://x:1'] }));
			expect(handleSpy).not.toHaveBeenCalled();
		});

		it('should drop a peer that does not complete the handshake in time', () => {
			jest.useFakeTimers();
			try {
				p2pServer['connectSocket'](mockSocket as unknown as WebSocket);
				jest.advanceTimersByTime(HANDSHAKE_TIMEOUT + 1);
				expect(mockSocket.close).toHaveBeenCalled();
			} finally {
				jest.useRealTimers();
			}
		});
	});

	describe('block sync', () => {
		it('should request blocks when the peer has a tip we do not know', () => {
			p2pServer['connectSocket'](mockSocket as unknown as WebSocket);
			mockSocket.emit('message', peerVersion({ height: 5, tip: 'cd'.repeat(32) }));
			mockSocket.emit('message', JSON.stringify({ type: MessageType.VERACK }));

			const request = mockSocket.sent().find((m) => m.type === (MessageType.GET_BLOCKS as string));
			expect(request?.data).toEqual({ locator: [blockchain.getChain()[0].hash] });
		});

		it('should answer GET_BLOCKS and ignore malformed requests', async () => {
			connectReady(mockSocket);
			mockSocket.send.mockClear();
			for (const locator of ['nope', ['zz'], new Array(65).fill('ab'.repeat(32))]) {
				mockSocket.emit('message', JSON.stringify({ type: MessageType.GET_BLOCKS, data: { locator } }));
			}
			expect(mockSocket.send).not.toHaveBeenCalled();

			mockSocket.emit(
				'message',
				JSON.stringify({ type: MessageType.GET_BLOCKS, data: { locator: [blockchain.getChain()[0].hash] } }),
			);
			await new Promise((resolve) => setTimeout(resolve, 0)); // requests are served from a queue
			expect(mockSocket.sent()).toEqual([{ type: MessageType.BLOCKS, data: { blocks: [], more: false } }]);
		});

		it('should ignore malformed BLOCKS, BLOCK and TRANSACTION payloads', async () => {
			connectReady(mockSocket);
			const addSpy = jest.spyOn(blockchain, 'addMinedBlock');
			for (const message of [
				{ type: MessageType.BLOCKS, data: 'nope' },
				{ type: MessageType.BLOCKS, data: { blocks: [{ junk: true }], more: true } },
				{ type: MessageType.BLOCK, data: { index: 'x' } },
				{ type: MessageType.TRANSACTION, data: [] },
				{ type: 'UNKNOWN', data: 1 },
				42,
			]) {
				mockSocket.emit('message', JSON.stringify(message));
			}
			await new Promise((resolve) => setImmediate(resolve));
			expect(addSpy).not.toHaveBeenCalled();
		});
	});
	describe('relay', () => {
		const flush = () => new Promise((resolve) => setImmediate(resolve));

		function signedTransaction(): Transaction {
			const tx = new Transaction(
				[{ previousTx: 'ab'.repeat(32), outputIndex: 0, publicKey: '', signature: '' }],
				[{ address: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', amount: 123n }],
				1_700_000_000_000,
			);
			tx.signTransaction(Buffer.alloc(32, 7));
			return tx;
		}

		function readyPair(): [MockWebSocket, MockWebSocket] {
			const s1 = new MockWebSocket('ws://peer1:5001');
			const s2 = new MockWebSocket('ws://peer2:5001');
			connectReady(s1);
			connectReady(s2);
			s1.send.mockClear();
			s2.send.mockClear();
			return [s1, s2];
		}

		const txMessage = (tx: Transaction) => JSON.stringify({ type: MessageType.TRANSACTION, data: tx });

		it('should relay an accepted transaction to other peers but not back to the sender', async () => {
			const [s1, s2] = readyPair();
			jest.spyOn(blockchain, 'addTransaction').mockResolvedValue(undefined);
			const tx = signedTransaction();

			s1.emit('message', txMessage(tx));
			await flush();

			expect(s2.sent()).toEqual([{ type: MessageType.TRANSACTION, data: JSON.parse(JSON.stringify(tx)) }]);
			expect(s1.send).not.toHaveBeenCalled();
		});

		it('should not relay a rejected transaction', async () => {
			const [s1, s2] = readyPair();
			jest.spyOn(blockchain, 'addTransaction').mockRejectedValue(new Error('invalid'));

			s1.emit('message', txMessage(signedTransaction()));
			await flush();

			expect(s2.send).not.toHaveBeenCalled();
		});

		it('should process each transaction once, however many peers send it', async () => {
			const [s1, s2] = readyPair();
			const add = jest.spyOn(blockchain, 'addTransaction').mockResolvedValue(undefined);
			const tx = signedTransaction();

			s1.emit('message', txMessage(tx));
			s2.emit('message', txMessage(tx));
			s1.emit('message', txMessage(tx));
			await flush();

			expect(add).toHaveBeenCalledTimes(1);
		});

		it('should ignore echoes of its own broadcasts', async () => {
			const [s1] = readyPair();
			const addTx = jest.spyOn(blockchain, 'addTransaction');
			const addBlock = jest.spyOn(blockchain, 'addMinedBlock');
			const tx = signedTransaction();
			const block = new Block(Date.now(), [Transaction.coinbase('x', 1n, 1)], blockchain.getChain()[0].hash, 0, undefined, 1);
			p2pServer.broadcastTransaction(tx);
			p2pServer.broadcastBlock(block);

			s1.emit('message', txMessage(tx));
			s1.emit('message', JSON.stringify({ type: MessageType.BLOCK, data: block }));
			await flush();

			expect(addTx).not.toHaveBeenCalled();
			expect(addBlock).not.toHaveBeenCalled();
		});

		it('should relay accepted blocks to other peers but not back to the sender', async () => {
			const [s1, s2] = readyPair();
			jest.spyOn(blockchain, 'addMinedBlock').mockResolvedValue('connected');
			const block = new Block(Date.now(), [Transaction.coinbase('x', 1n, 1)], blockchain.getChain()[0].hash, 0, undefined, 1);

			s1.emit('message', JSON.stringify({ type: MessageType.BLOCK, data: block }));
			await flush();

			expect(s2.sent().map((m) => m.type)).toEqual([MessageType.BLOCK]);
			expect(s1.send).not.toHaveBeenCalled();
		});
	});
});
