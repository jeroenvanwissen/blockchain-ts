// import { P2PServer } from '../P2PServer';
// import { Blockchain } from '../../blockchain/Blockchain';
// import WebSocket from 'ws';
// import fs from 'fs';

// jest.mock('fs');
// jest.mock('ws');

// describe('P2PServer', () => {
// 	let blockchain: Blockchain;
// 	let p2pServer: P2PServer;
// 	const peerDataPath = 'peers.json';

// 	beforeEach(() => {
// 		blockchain = new Blockchain();
// 		p2pServer = new P2PServer(blockchain, 5001, peerDataPath);
// 		jest.clearAllMocks();
// 	});

// 	it('should not log invalid peer addresses', () => {
// 		const invalidSocket = { url: '' } as WebSocket;
// 		const validSocket = { url: 'ws://valid-peer' } as WebSocket;

// 		p2pServer['logPeerConnection'](invalidSocket);
// 		p2pServer['logPeerConnection'](validSocket);

// 		expect(fs.readFile).toHaveBeenCalledTimes(1);
// 		expect(fs.writeFile).toHaveBeenCalledTimes(1);

// 		const writeCall = (fs.writeFile as unknown as jest.Mock).mock.calls[0];
// 		const loggedPeers = JSON.parse(writeCall[1]);

// 		expect(loggedPeers).toHaveLength(1);
// 		expect(loggedPeers[0].peer).toBe('ws://valid-peer');
// 	});
// });
