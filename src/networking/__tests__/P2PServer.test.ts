import { P2PServer, type Message, MessageType } from '../P2PServer.js';
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
			loadSync: () => ({ lookupType: () => mockType }),
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

		// Add existsSync mock
		(fs.existsSync as jest.Mock).mockReturnValue(true);

		// Suppress console output during tests
		jest.spyOn(console, 'log').mockImplementation(() => {});
		jest.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('should not log invalid peer addresses', () => {
		const invalidSocket = { url: '' } as WebSocket;
		const validSocket = { url: 'ws://valid-peer' } as WebSocket;

		// Mock fs.writeFile to capture the written data
		const writeFileMock = fs.writeFile as unknown as jest.Mock;

		p2pServer['logPeerConnection'](invalidSocket);
		p2pServer['logPeerConnection'](validSocket);

		// Get the last call to writeFile
		const lastWriteCall =
			writeFileMock.mock.calls[writeFileMock.mock.calls.length - 1];
		const writtenData = JSON.parse(lastWriteCall[1]);

		expect(writtenData).toHaveLength(1);
		expect(writtenData[0]).toBe('valid-peer');
	});

	it('should handle stake messages correctly', async () => {
		const stakeData = {
			address: 'testAddress',
			amount: 100,
		};

		// Mock blockchain methods needed for staking (now returns Promise)
		const stakeSpy = jest.spyOn(blockchain, 'stake').mockResolvedValue(undefined);

		await p2pServer['handleStakeMessage'](stakeData);

		expect(stakeSpy).toHaveBeenCalledWith('testAddress', 100);
		stakeSpy.mockRestore();
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
			amount: 100,
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
});
