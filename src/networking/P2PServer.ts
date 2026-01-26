import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { Blockchain } from '../blockchain/Blockchain.js';
import { Transaction } from '../blockchain/Transaction.js';
import { Block } from '../blockchain/Block.js';
import fs from 'fs';

export enum MessageType {
	CHAIN = 'CHAIN',
	BLOCK = 'BLOCK',
	TRANSACTION = 'TRANSACTION',
	STAKE = 'STAKE',
	UNSTAKE = 'UNSTAKE',
	GET_LATEST_BLOCK = 'GET_LATEST_BLOCK',
	LATEST_BLOCK = 'LATEST_BLOCK',
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
		amount: number;
	};
}

interface UnstakeMessage {
	type: MessageType.UNSTAKE;
	data: {
		address: string;
		amount: number;
	};
}

interface GetLatestBlockMessage {
	type: MessageType.GET_LATEST_BLOCK;
}

interface LatestBlockMessage {
	type: MessageType.LATEST_BLOCK;
	data: Block;
}

export type Message =
	| ChainMessage
	| TransactionMessage
	| BlockMessage
	| StakeMessage
	| UnstakeMessage
	| GetLatestBlockMessage
	| LatestBlockMessage;

// DTOs for wire format
interface SerializedTxInput {
	previousTx: string;
	outputIndex: number;
	signature: string;
}
interface SerializedTxOutput {
	address: string;
	amount: number;
}
interface SerializedTransaction {
	inputs: SerializedTxInput[];
	outputs: SerializedTxOutput[];
	timestamp: number;
	nonce?: number;
}
interface SerializedBlock {
	timestamp: number;
	transactions: SerializedTransaction[];
	previousHash: string;
	nonce: number;
	powDifficulty: number;
	index: number;
	hash: string;
}

function isSerializedTransaction(obj: unknown): obj is SerializedTransaction {
	return (
		typeof obj === 'object' &&
		obj !== null &&
		Array.isArray((obj as SerializedTransaction).inputs) &&
		Array.isArray((obj as SerializedTransaction).outputs) &&
		typeof (obj as SerializedTransaction).timestamp === 'number'
	);
}

function isSerializedBlock(obj: unknown): obj is SerializedBlock {
	return (
		typeof obj === 'object' &&
		obj !== null &&
		Array.isArray((obj as SerializedBlock).transactions) &&
		typeof (obj as SerializedBlock).timestamp === 'number' &&
		typeof (obj as SerializedBlock).previousHash === 'string' &&
		typeof (obj as SerializedBlock).nonce === 'number' &&
		typeof (obj as SerializedBlock).powDifficulty === 'number' &&
		typeof (obj as SerializedBlock).index === 'number' &&
		typeof (obj as SerializedBlock).hash === 'string'
	);
}

export class P2PServer {
	private sockets: WebSocket[];
	private connectedPeers: Set<string>;

	constructor(
		private blockchain: Blockchain,
		private p2pPort: number,
		private peerDataPath: string
	) {
		this.sockets = [];
		this.connectedPeers = new Set();
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
		});
	}

	// Update connectToPeers method
	connectToPeers(newPeers: string[]): void {
		newPeers.forEach((peer) => {
			const normalizedPeer = this.normalizePeerUrl(peer);

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
		// Extract host:port from the peer address
		const hostPort = peerAddress.replace(/^wss?:\/\//, '');

		// Create peers.json if it doesn't exist
		if (!fs.existsSync(this.peerDataPath)) {
			fs.writeFileSync(this.peerDataPath, '[]');
		}

		fs.readFile(this.peerDataPath, 'utf8', (err, data) => {
			let peers: string[] = [];
			if (!err && data) {
				try {
					peers = JSON.parse(data);
				} catch (parseError) {
					console.error('Error parsing peers.json:', parseError);
					peers = []; // Reset to empty array if parsing fails
				}
			}

			// Add the host:port to the array if it's not already there
			if (!peers.includes(hostPort)) {
				peers.push(hostPort);

				// Write updated peers list
				fs.writeFile(
					this.peerDataPath,
					JSON.stringify(peers, null, 2),
					(writeErr) => {
						if (writeErr) {
							console.error('Error writing to peers.json:', writeErr);
						} else {
							console.log('Peer connection logged');
						}
					}
				);
			}
		});
	}

	private messageHandler(socket: WebSocket): void {
		socket.on('message', (message: Buffer | string) => {
			try {
				const messageStr =
					message instanceof Buffer ? message.toString() : message;
				const jsonStr: string =
					typeof messageStr === 'string' ? messageStr : messageStr.toString();
				const data: Message = JSON.parse(jsonStr);

				switch (data.type) {
					case MessageType.CHAIN:
						void this.handleChainMessage(data.data);
						break;

					case MessageType.BLOCK:
						void this.handleBlockMessage(data.data);
						break;

					case MessageType.TRANSACTION:
						this.handleTransactionMessage(data.data);
						break;

					case MessageType.STAKE:
						this.handleStakeMessage(data.data);
						break;

					case MessageType.UNSTAKE:
						this.handleUnstakeMessage(data.data);
						break;

					case MessageType.GET_LATEST_BLOCK:
						this.handleGetLatestBlockMessage(socket);
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
			if (!Array.isArray(chain)) return;
			// If any block is not a valid SerializedBlock, throw
			for (const blockData of chain) {
				if (!isSerializedBlock(blockData)) {
					throw new Error('Invalid block data in chain');
				}
			}
			const blocks: Block[] = [];
			for (const blockData of chain) {
				// blockData is guaranteed to be SerializedBlock here
				const transactions: Transaction[] = [];
				for (const txData of blockData.transactions) {
					if (!isSerializedTransaction(txData)) continue;
					transactions.push(
						new Transaction(
							txData.inputs,
							txData.outputs,
							txData.timestamp,
							txData.nonce
						)
					);
				}
				blocks.push(
					new Block(
						blockData.timestamp,
						transactions,
						blockData.previousHash,
						blockData.nonce,
						blockData.powDifficulty,
						blockData.index
					)
				);
			}
			if (blocks.length > this.blockchain.getChain().length) {
				const release = await this.blockchain.replaceLock.acquire();
				try {
					// Create temporary blockchain for validation
					const tempChain = new Blockchain();
					tempChain.getChain().length = 0;
					tempChain.getChain().push(...blocks);
					// Validate the new chain
					if (await tempChain.isChainValid()) {
						// Replace the current chain if valid
						this.blockchain.getChain().length = 0;
						this.blockchain.getChain().push(...blocks);
						this.blockchain.clearPendingTransactions();
					}
				} finally {
					release();
				}
			}
		} catch (error) {
			console.error('Error handling chain message:', error);
		}
	}

	private async handleBlockMessage(blockData: unknown): Promise<void> {
		try {
			if (!isSerializedBlock(blockData)) return;
			const transactions: Transaction[] = [];
			for (const txData of blockData.transactions) {
				if (!isSerializedTransaction(txData)) continue;
				transactions.push(
					new Transaction(
						txData.inputs,
						txData.outputs,
						txData.timestamp,
						txData.nonce
					)
				);
			}
			const block = new Block(
				blockData.timestamp,
				transactions,
				blockData.previousHash,
				blockData.nonce,
				blockData.powDifficulty,
				blockData.index
			);
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
			// If the block index matches our current chain length, try to add it
			const release = await this.blockchain.replaceLock.acquire();
			try {
				this.blockchain.addMinedBlock(block);
				// Only broadcast if we successfully added the block
				const out: BlockMessage = { type: MessageType.BLOCK, data: block };
				this.broadcast(out);
			} finally {
				release();
			}
		} catch (error) {
			console.error('Error handling block message:', error);
		}
	}

	private handleTransactionMessage(txData: Transaction): void {
		try {
			const transaction = new Transaction(txData.inputs, txData.outputs);
			this.blockchain.addTransaction(transaction);
		} catch (error) {
			console.error('Error handling transaction message:', error);
		}
	}

	private handleStakeMessage(stakeData: {
		address: string;
		amount: number;
	}): void {
		try {
			this.blockchain.stake(stakeData.address, stakeData.amount);
		} catch (error) {
			console.error('Error handling stake message:', error);
		}
	}

	private handleUnstakeMessage(unstakeData: {
		address: string;
		amount: number;
	}): void {
		try {
			this.blockchain.unstake(unstakeData.address, unstakeData.amount);
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

	getSockets(): WebSocket[] {
		return this.sockets;
	}
}
