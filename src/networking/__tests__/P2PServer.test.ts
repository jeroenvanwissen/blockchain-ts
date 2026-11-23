import { P2PServer, MessageType, isValidPeerAddress } from '../P2PServer.js';
import { Blockchain } from '../../blockchain/Blockchain.js';
import { Block } from '../../blockchain/Block.js';
import { Transaction } from '../../blockchain/Transaction.js';
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

	constructor(url: string) {
		super();
		this.url = url;
		this.readyState = WebSocket.OPEN;
		this.send = jest.fn();
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

	beforeEach(() => {
		blockchain = new Blockchain();
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

	it('should not log invalid peer addresses', () => {
		const invalidSocket = { url: '' } as WebSocket;
		const validSocket = { url: 'ws://valid-peer:5002' } as WebSocket;

		p2pServer['logPeerConnection'](invalidSocket);
		p2pServer['logPeerConnection'](validSocket);

		// Get the last call to writeFileSync
		const writeFileSyncMock = fs.writeFileSync as jest.Mock;
		const lastWriteCall =
			writeFileSyncMock.mock.calls[writeFileSyncMock.mock.calls.length - 1];
		const writtenData = JSON.parse(lastWriteCall[1]);

		expect(writtenData).toHaveLength(1);
		expect(writtenData[0]).toBe('valid-peer:5002');
	});

	it('should handle stake messages correctly', async () => {
		const stakeData = {
			address: 'testAddress',
			amount: '100', // base units, decimal string on the wire
		};

		// Mock blockchain methods needed for staking (now returns Promise)
		const stakeSpy = jest.spyOn(blockchain, 'stake').mockResolvedValue(undefined);

		await p2pServer['handleStakeMessage'](stakeData);

		expect(stakeSpy).toHaveBeenCalledWith('testAddress', 100n);
		stakeSpy.mockRestore();
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
		const block = new Block(Date.now(), [Transaction.coinbase('x', 1n, 1)], '0', 0, 1, 1);
		const wire = JSON.parse(JSON.stringify(block)) as { transactions: Record<string, unknown>[] };
		delete wire.transactions[0].outputs;
		const addSpy = jest.spyOn(blockchain, 'addMinedBlock').mockResolvedValue(undefined);

		await p2pServer['handleBlockMessage'](wire);

		expect(addSpy).not.toHaveBeenCalled();
		addSpy.mockRestore();
	});

	it('should handle chain replacement correctly', async () => {
		// Create a mock chain
		const mockTransaction = new Transaction([], []);
		const mockBlock1 = new Block(
			Date.now(),
			[mockTransaction],
			'0', // Genesis block previous hash
			0,
			4,
			0
		);
		const mockBlock2 = new Block(
			Date.now(),
			[mockTransaction],
			mockBlock1.hash,
			0,
			4,
			1
		);
		const mockChain = [mockBlock1, mockBlock2];

		// Mock blockchain methods with longer incoming chain
		const getChainSpy = jest
			.spyOn(blockchain, 'getChain')
			.mockReturnValue([mockBlock1]);
		const replaceChainSpy = jest
			.spyOn(blockchain, 'replaceChain')
			.mockResolvedValue(undefined);

		await p2pServer['handleChainMessage'](mockChain);

		// Verify replaceChain was called with the new blocks
		expect(replaceChainSpy).toHaveBeenCalled();

		// Cleanup
		getChainSpy.mockRestore();
		replaceChainSpy.mockRestore();
	});

	it('should handle errors during stake message processing', async () => {
		const stakeData = {
			address: 'testAddress',
			amount: '100', // base units, decimal string on the wire
		};
		const spy = jest.spyOn(blockchain, 'stake').mockRejectedValue(
			new Error('Stake failed')
		);
		const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

		await p2pServer['handleStakeMessage'](stakeData);

		expect(consoleSpy).toHaveBeenCalledWith(
			'Error handling stake message:',
			expect.any(Error)
		);

		spy.mockRestore();
		consoleSpy.mockRestore();
	});

	it('should handle errors during chain message processing', async () => {
		const invalidChain = [{}] as Block[];
		const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

		await p2pServer['handleChainMessage'](invalidChain);

		expect(consoleSpy).toHaveBeenCalledWith(
			'Error handling chain message:',
			expect.any(Error)
		);

		consoleSpy.mockRestore();
	});

	// Fix the network disconnection test
	it('should handle network disconnection', () => {
		const reconnectSpy = jest
			.spyOn(p2pServer as any, 'reconnectToPeer')
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

		p2pServer['sockets'] = [mockSocket1, mockSocket2] as unknown as WebSocket[];

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
	});

	// Add test for socket error handling with proper error event
	it('should handle socket connection errors', () => {
		const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
		const mockError = new Error('Connection failed');

		p2pServer['connectSocket'](mockSocket as unknown as WebSocket);
		mockSocket.emit('error', mockError);

		expect(consoleSpy).toHaveBeenCalled();
		consoleSpy.mockRestore();
	});

	// Add test for message parsing with proper message event
	it('should handle message parsing errors', () => {
		const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

		p2pServer['connectSocket'](mockSocket as unknown as WebSocket);
		mockSocket.emit('message', 'invalid-json');

		expect(consoleSpy).toHaveBeenCalled();
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
			p2pServer['_knownPeers'].add('ws://existing:5001');
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
			// Fill up known peers to the limit
			for (let i = 0; i < 128; i++) {
				p2pServer['_knownPeers'].add(`ws://existing${i}:5001`);
			}
			p2pServer['_handlePeersMessage'](['ws://new-peer:6001']);
			expect(p2pServer['_knownPeers'].has('ws://new-peer:6001')).toBe(false);
			expect(p2pServer['_knownPeers'].size).toBe(128);
		});

		it('should attempt connection to newly discovered peers', () => {
			const connectSpy = jest.spyOn(p2pServer, 'connectToPeers');
			p2pServer['_handlePeersMessage'](['ws://new-peer:5001']);
			expect(connectSpy).toHaveBeenCalledWith(['ws://new-peer:5001']);
			connectSpy.mockRestore();
		});

		it('should not attempt connection to already connected peers', () => {
			p2pServer['connectedPeers'].add('ws://existing:5001');
			const connectSpy = jest.spyOn(p2pServer, 'connectToPeers');
			p2pServer['_handlePeersMessage'](['ws://existing:5001']);
			expect(connectSpy).not.toHaveBeenCalled();
			connectSpy.mockRestore();
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
			p2pServer['_knownPeers'].add('ws://known-peer:5001');
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const reconnectSpy = jest.spyOn(p2pServer as any, 'reconnectToPeer').mockImplementation();
			p2pServer['connectSocket'](mockSocket as unknown as WebSocket);

			const sentMessages: { type: string; data?: string[] }[] = mockSocket.send.mock.calls.map(
				(call: [string]) => JSON.parse(call[0]) as { type: string; data?: string[] }
			);
			const peersMessage = sentMessages.find(msg => msg.type === 'PEERS');
			expect(peersMessage).toBeDefined();
			expect(peersMessage!.data).toContain('ws://known-peer:5001');
			reconnectSpy.mockRestore();
		});

		it('should not send peer list when no known peers', () => {
			// Use a socket without a valid ws:// URL so logPeerConnection doesn't add it
			const noUrlSocket = new MockWebSocket('');
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const reconnectSpy = jest.spyOn(p2pServer as any, 'reconnectToPeer').mockImplementation();
			p2pServer['connectSocket'](noUrlSocket as unknown as WebSocket);

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
			p2pServer['_knownPeers'].add('ws://peer1:5001');
			const mockSocket1 = new MockWebSocket('ws://peer1:5001');
			p2pServer['sockets'] = [mockSocket1] as unknown as WebSocket[];

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
			const mockSocket1 = new MockWebSocket('ws://peer1:5001');
			p2pServer['sockets'] = [mockSocket1] as unknown as WebSocket[];

			p2pServer['_startPeerBroadcast']();
			jest.advanceTimersByTime(60_000);

			expect(mockSocket1.send).not.toHaveBeenCalled();
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
			p2pServer['connectSocket'](mockSocket as unknown as WebSocket);

			const peersMsg = JSON.stringify({
				type: MessageType.PEERS,
				data: ['ws://remote:5001'],
			});
			mockSocket.emit('message', peersMsg);

			expect(handleSpy).toHaveBeenCalledWith(['ws://remote:5001']);
			handleSpy.mockRestore();
			reconnectSpy.mockRestore();
		});
	});

	describe('peer persistence', () => {
		it('should write known peers to peerDataPath in host:port format', () => {
			const writeFileSyncMock = fs.writeFileSync as jest.Mock;
			p2pServer['_knownPeers'].add('ws://host1:5001');
			p2pServer['_knownPeers'].add('ws://host2:5002');

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

			p2pServer['_knownPeers'].add('ws://host:5001');
			p2pServer['_persistPeers']();

			expect(console.error).toHaveBeenCalledWith(
				'Error writing peers.json:',
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
});
