import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { Blockchain } from '../blockchain/Blockchain.js';
import { Transaction } from '../blockchain/Transaction.js';
import { Block } from '../blockchain/Block.js';
import fs from 'fs';
import { PEER_BROADCAST_INTERVAL, MAX_KNOWN_PEERS } from '../config.js';

export enum MessageType {
	CHAIN = 'CHAIN',
	BLOCK = 'BLOCK',
	TRANSACTION = 'TRANSACTION',
	STAKE = 'STAKE',
	UNSTAKE = 'UNSTAKE',
	GET_LATEST_BLOCK = 'GET_LATEST_BLOCK',
	LATEST_BLOCK = 'LATEST_BLOCK',
	PEERS = 'PEERS',
}

interface ChainMessage {
	type: MessageType.CHAIN;
	data: Block[];
}

interface TransactionMessage {
	type: MessageType.TRANSACTION;
	data: Transaction;
}

interface BlockMessage {
	type: MessageType.BLOCK;
	data: Block;
}

interface StakeMessage {
	type: MessageType.STAKE;
	data: {
		address: string;
		amount: string; // base units, decimal
	};
}

interface UnstakeMessage {
	type: MessageType.UNSTAKE;
	data: {
		address: string;
		amount: string; // base units, decimal
	};
}

interface GetLatestBlockMessage {
	type: MessageType.GET_LATEST_BLOCK;
}

interface LatestBlockMessage {
	type: MessageType.LATEST_BLOCK;
	data: Block;
}

interface PeersMessage {
	type: MessageType.PEERS;
	data: string[];
}

export type Message =
	| ChainMessage
	| TransactionMessage
	| BlockMessage
	| StakeMessage
	| UnstakeMessage
	| GetLatestBlockMessage
	| LatestBlockMessage
	| PeersMessage;

/** Rebuild a block from wire data. Throws if the block or any transaction is malformed. */
function parseBlock(data: unknown): Block {
	return Block.fromJSON(data);
}

function parseAmount(value: unknown): bigint | null {
	return typeof value === 'string' && /^\d{1,20}$/.test(value) ? BigInt(value) : null;
}

export function isValidPeerAddress(address: string): boolean {
	try {
		if (!/^wss?:\/\//.test(address)) return false;
		const url = new URL(address);
		const port = parseInt(url.port, 10);
		if (!url.hostname || isNaN(port) || port < 1 || port > 65535) return false;
		if (/\s/.test(url.hostname)) return false;
		return true;
	} catch {
		return false;
	}
}

export class P2PServer {
	private sockets: WebSocket[];
	private connectedPeers: Set<string>;
	private _knownPeers: Set<string>;
	private _ownAddresses: Set<string>;
	private _peerBroadcastInterval: NodeJS.Timeout | null = null;

	constructor(
		private blockchain: Blockchain,
		private p2pPort: number,
		private peerDataPath: string
	) {
		this.sockets = [];
		this.connectedPeers = new Set();
		this._knownPeers = new Set();
		this._ownAddresses = new Set();
		this._buildOwnAddresses();
	}

	private _buildOwnAddresses(): void {
		this._ownAddresses.add(`ws://localhost:${this.p2pPort}`);
		this._ownAddresses.add(`ws://127.0.0.1:${this.p2pPort}`);
		this._ownAddresses.add(`ws://0.0.0.0:${this.p2pPort}`);
	}

	private normalizePeerUrl(url: string): string {
		// Ensure protocol
		if (!/^wss?:\/\//.test(url)) {
			url = `ws://${url}`;
		}
		// Remove trailing slash
		return url.replace(/\/$/, '');
	}

	public listen(): void {
		const server = new WebSocketServer({
			port: this.p2pPort,
			host: '0.0.0.0',
			clientTracking: true,
			perMessageDeflate: false,
		});

		server.on('connection', (socket, request) => {
			console.log(`New connection from ${request.socket.remoteAddress}`);
			this.connectSocket(socket);
		});

		server.on('error', (error) => {
			console.error('WebSocket Server error:', error);
		});

		server.on('listening', () => {
			const addr = server.address();
			if (addr && typeof addr === 'object' && 'address' in addr) {
				console.log(`P2P Server listening on ${addr.address}:${this.p2pPort}`);
			} else {
				console.log(`P2P Server listening on port ${this.p2pPort}`);
			}
			this._startPeerBroadcast();
		});
	}

	connectToPeers(newPeers: string[]): void {
		newPeers.forEach((peer) => {
			const normalizedPeer = this.normalizePeerUrl(peer);

			// Validate peer address format
			if (!isValidPeerAddress(normalizedPeer)) {
				console.log(`Invalid peer address, skipping: ${peer}`);
				return;
			}

			// Skip own addresses
			if (this._ownAddresses.has(normalizedPeer)) return;

			// Track as known peer
			this._knownPeers.add(normalizedPeer);

			// Check if we're already connected or connecting to this peer
			if (this.connectedPeers.has(normalizedPeer)) {
				return;
			}

			// Mark as connecting before attempting connection
			this.connectedPeers.add(normalizedPeer);

			console.log(`Attempting to connect to peer: ${normalizedPeer}`);

			const socket = new WebSocket(normalizedPeer, {
				handshakeTimeout: 5000,
				headers: {
					'User-Agent': 'BlockchainClient',
				},
			});

			socket.on('open', () => {
				console.log(`Successfully connected to peer: ${normalizedPeer}`);
				this.connectSocket(socket);
			});

			socket.on('error', (error) => {
				console.log(`Connection failed to peer: ${normalizedPeer}`);
				console.error('Error details:', error.message);
				this.connectedPeers.delete(normalizedPeer); // Remove from tracking on error
			});

			socket.on('close', () => {
				this.connectedPeers.delete(normalizedPeer); // Remove from tracking on close
			});
		});
	}

	private connectSocket(socket: WebSocket): void {
		this.sockets.push(socket);

		// Add error handler
		socket.on('error', (error) => {
			console.error('Socket connection error:', error);
			const index = this.sockets.indexOf(socket);
			if (index > -1) {
				this.sockets.splice(index, 1);
			}
		});

		// Add close handler
		socket.on('close', () => {
			const index = this.sockets.indexOf(socket);
			if (index > -1) {
				this.sockets.splice(index, 1);
			}
			if ((socket as unknown as { url?: string; reconnecting?: boolean }).url) {
				// Only attempt reconnection if socket is not already reconnecting
				const s = socket as unknown as { url?: string; reconnecting?: boolean };
				if (!s.reconnecting && s.url) {
					void this.reconnectToPeer(s.url);
				}
			}
		});

		this.logPeerConnection(socket as unknown as WebSocket);
		this.messageHandler(socket);
		this.sendChain(socket);
		this._sendPeerList(socket);
	}

	private async reconnectToPeer(
		peer: string,
		attempt: number = 1
	): Promise<void> {
		const maxAttempts = 10;
		const baseDelay = 1000;

		if (attempt > maxAttempts) {
			console.log(`Max reconnection attempts reached for peer: ${peer}`);
			return;
		}

		const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 30000);

		try {
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
			const socket = new WebSocket(peer);

			// Mark socket as reconnecting
			(socket as unknown as { reconnecting?: boolean }).reconnecting = true;

			socket.on('open', () => {
				(socket as unknown as { reconnecting?: boolean }).reconnecting = false;
				this.connectSocket(socket);
			});

			socket.on('error', () => {
				console.log(`Reconnection attempt ${attempt} failed for peer: ${peer}`);
				void this.reconnectToPeer(peer, attempt + 1);
			});
		} catch (error) {
			console.error(`Error reconnecting to peer: ${peer}`, error);
			void this.reconnectToPeer(peer, attempt + 1);
		}
	}

	private logPeerConnection(socket: WebSocket): void {
		const peerAddress = (socket as unknown as { url?: string }).url;
		if (!peerAddress || !/^wss?:\/\//.test(peerAddress)) {
			console.log('Invalid peer address, not logging');
			return;
		}
		const normalized = this.normalizePeerUrl(peerAddress);
		this._knownPeers.add(normalized);
		this._persistPeers();
	}

	private messageHandler(socket: WebSocket): void {
		// Chain-affecting messages from one peer are handled in arrival order: a block relayed
		// right after a CHAIN message must not be processed before that chain is adopted
		let queue: Promise<void> = Promise.resolve();
		const enqueue = (task: () => Promise<void>): void => {
			queue = queue.then(task, task);
		};

		socket.on('message', (message: Buffer | string) => {
			try {
				const messageStr =
					message instanceof Buffer ? message.toString() : message;
				const jsonStr: string =
					typeof messageStr === 'string' ? messageStr : messageStr.toString();
				const data: Message = JSON.parse(jsonStr);

				switch (data.type) {
					case MessageType.CHAIN: {
						const payload = data.data;
						enqueue(() => this.handleChainMessage(payload));
						break;
					}
					case MessageType.BLOCK: {
						const payload = data.data;
						enqueue(() => this.handleBlockMessage(payload));
						break;
					}
					case MessageType.TRANSACTION: {
						const payload = data.data;
						enqueue(() => this.handleTransactionMessage(payload));
						break;
					}
					case MessageType.STAKE: {
						const payload = data.data;
						enqueue(() => this.handleStakeMessage(payload));
						break;
					}
					case MessageType.UNSTAKE: {
						const payload = data.data;
						enqueue(() => this.handleUnstakeMessage(payload));
						break;
					}
					case MessageType.GET_LATEST_BLOCK:
						this.handleGetLatestBlockMessage(socket);
						break;

					case MessageType.PEERS:
						this._handlePeersMessage(data.data);
						break;
				}
			} catch (error) {
				console.error('Error parsing message:', error);
			}
		});
	}

	private handleGetLatestBlockMessage(socket: WebSocket): void {
		try {
			const latestBlock = this.blockchain.getLatestBlock();
			const message: LatestBlockMessage = {
				type: MessageType.LATEST_BLOCK,
				data: latestBlock,
			};
			socket.send(JSON.stringify(message));
		} catch (error) {
			console.error('Error handling get latest block message:', error);
		}
	}

	private async handleChainMessage(chain: unknown): Promise<void> {
		try {
			if (!Array.isArray(chain) || chain.length === 0) return;
			const blocks = chain.map((blockData) => parseBlock(blockData));
			// Compute weight of received chain and compare to current
			Blockchain.computeChainWeights(blocks);
			const receivedWeight = blocks[blocks.length - 1].cumulativeWeight;
			if (receivedWeight > this.blockchain.getChainWeight()) {
				// replaceChain handles its own locking and validation
				await this.blockchain.replaceChain(blocks);
				const tip = this.blockchain.getLatestBlock();
				console.log(
					`Synced chain from peer: height ${tip.index}, tip ${tip.hash.slice(0, 16)}`,
				);
			}
		} catch (error) {
			console.error('Error handling chain message:', error);
		}
	}

	private async handleBlockMessage(blockData: unknown): Promise<void> {
		try {
			const block = parseBlock(blockData);
			// Ignore blocks we already have (e.g. our own block echoed back by a peer)
			if (this.blockchain.getChain()[block.index]?.hash === block.hash) return;
			// Check if we need to sync first
			const currentChainLength = this.blockchain.getChain().length;
			if (block.index > currentChainLength) {
				// Request the latest block; a higher index suggests we should sync chain elsewhere
				const msg: GetLatestBlockMessage = {
					type: MessageType.GET_LATEST_BLOCK,
				};
				this.broadcast(msg as unknown as Message);
				return;
			}
			// addMinedBlock handles its own locking
			await this.blockchain.addMinedBlock(block);
			console.log(`Accepted block ${block.index} (${block.hash.slice(0, 16)}) from peer`);
			// Only broadcast if we successfully added the block
			const out: BlockMessage = { type: MessageType.BLOCK, data: block };
			this.broadcast(out);
		} catch (error) {
			console.error('Error handling block message:', error);
		}
	}

	private async handleTransactionMessage(txData: unknown): Promise<void> {
		try {
			// fromJSON keeps every field, so the txid matches the sender's
			const transaction = Transaction.fromJSON(txData);
			await this.blockchain.addTransaction(transaction);
		} catch (error) {
			console.error('Error handling transaction message:', error);
		}
	}

	private async handleStakeMessage(stakeData: { address: string; amount: unknown }): Promise<void> {
		try {
			const amount = parseAmount(stakeData?.amount);
			if (amount === null || typeof stakeData.address !== 'string') return;
			await this.blockchain.stake(stakeData.address, amount);
		} catch (error) {
			console.error('Error handling stake message:', error);
		}
	}

	private async handleUnstakeMessage(unstakeData: {
		address: string;
		amount: unknown;
	}): Promise<void> {
		try {
			const amount = parseAmount(unstakeData?.amount);
			if (amount === null || typeof unstakeData.address !== 'string') return;
			await this.blockchain.unstake(unstakeData.address, amount);
		} catch (error) {
			console.error('Error handling unstake message:', error);
		}
	}

	broadcastTransaction(transaction: Transaction): void {
		const message: TransactionMessage = {
			type: MessageType.TRANSACTION,
			data: transaction,
		};
		this.broadcast(message);
	}

	broadcastBlock(block: Block): void {
		const message: BlockMessage = {
			type: MessageType.BLOCK,
			data: block,
		};
		this.broadcast(message);
	}

	private sendChain(socket: WebSocket): void {
		const message: ChainMessage = {
			type: MessageType.CHAIN,
			data: this.blockchain.getChain(),
		};
		socket.send(JSON.stringify(message));
	}

	broadcastChain(): void {
		const message: ChainMessage = {
			type: MessageType.CHAIN,
			data: this.blockchain.getChain(),
		};
		this.broadcast(message);
	}

	private broadcast(message: Message): void {
		this.sockets.forEach((socket) => {
			if (socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(message));
			}
		});
	}

	getKnownPeers(): string[] {
		return [...this._knownPeers];
	}

	loadInitialPeers(peers: string[]): void {
		for (const peer of peers) {
			const normalized = this.normalizePeerUrl(peer);
			if (isValidPeerAddress(normalized) && !this._ownAddresses.has(normalized)) {
				this._knownPeers.add(normalized);
			}
		}
	}

	private _startPeerBroadcast(): void {
		if (this._peerBroadcastInterval) return;
		this._peerBroadcastInterval = setInterval(() => {
			this._broadcastPeerList();
		}, PEER_BROADCAST_INTERVAL);
	}

	private _stopPeerBroadcast(): void {
		if (this._peerBroadcastInterval) {
			clearInterval(this._peerBroadcastInterval);
			this._peerBroadcastInterval = null;
		}
	}

	private _broadcastPeerList(): void {
		const peers = this.getKnownPeers();
		if (peers.length === 0) return;
		const message: PeersMessage = {
			type: MessageType.PEERS,
			data: peers,
		};
		this.broadcast(message);
	}

	private _sendPeerList(socket: WebSocket): void {
		const peers = this.getKnownPeers();
		if (peers.length === 0) return;
		const message: PeersMessage = {
			type: MessageType.PEERS,
			data: peers,
		};
		socket.send(JSON.stringify(message));
	}

	private _handlePeersMessage(peerAddresses: unknown): void {
		if (!Array.isArray(peerAddresses)) return;

		const newPeersToConnect: string[] = [];

		for (const addr of peerAddresses) {
			if (typeof addr !== 'string') continue;
			const normalized = this.normalizePeerUrl(addr);

			if (!isValidPeerAddress(normalized)) continue;
			if (this._ownAddresses.has(normalized)) continue;
			if (this._knownPeers.has(normalized)) continue;
			if (this._knownPeers.size >= MAX_KNOWN_PEERS) break;

			this._knownPeers.add(normalized);

			if (!this.connectedPeers.has(normalized)) {
				newPeersToConnect.push(normalized);
			}
		}

		this._persistPeers();

		if (newPeersToConnect.length > 0) {
			this.connectToPeers(newPeersToConnect);
		}
	}

	private _persistPeers(): void {
		const peers = this.getKnownPeers().map(url => url.replace(/^wss?:\/\//, ''));
		try {
			fs.writeFileSync(this.peerDataPath, JSON.stringify(peers, null, 2));
		} catch (error) {
			console.error('Error writing peers.json:', error);
		}
	}

	getSockets(): WebSocket[] {
		return this.sockets;
	}
}
