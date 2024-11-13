import WebSocket from 'ws';
import { Blockchain } from '../blockchain/Blockchain';
import { Transaction } from '../blockchain/Transaction';
import { Block } from '../blockchain/Block';
import fs from 'fs';

enum MessageType {
	CHAIN = 'CHAIN',
	BLOCK = 'BLOCK',
	TRANSACTION = 'TRANSACTION',
	STAKE = 'STAKE',
	UNSTAKE = 'UNSTAKE',
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

type Message = ChainMessage | TransactionMessage | BlockMessage;

export class P2PServer {
	private sockets: WebSocket[];

	constructor(
		private blockchain: Blockchain,
		private p2pPort: number,
		private peerDataPath: string
	) {
		this.sockets = [];
	}

	listen(): void {
		const server = new WebSocket.Server({ port: this.p2pPort });
		server.on('connection', (socket) => this.connectSocket(socket));
		console.log(
			`Listening for peer-to-peer connections on port ${this.p2pPort}`
		);
	}

	connectToPeers(newPeers: string[]): void {
		newPeers.forEach((peer) => {
			// Ensure the peer address includes a protocol
			if (!/^wss?:\/\//.test(peer)) {
				peer = `ws://${peer}`;
			}
			const socket = new WebSocket(peer);
			socket.on('open', () => this.connectSocket(socket));
			socket.on('error', (error) => {
				console.log(`Connection failed to peer: ${peer}`);
				console.error(error);
			});
		});
	}

	private connectSocket(socket: WebSocket): void {
		this.sockets.push(socket);
		console.log('Socket connected');
		this.logPeerConnection(socket);
		this.messageHandler(socket);
		this.sendChain(socket);
	}

	private logPeerConnection(socket: WebSocket): void {
		const peerAddress = socket.url;
		if (!peerAddress || !/^wss?:\/\//.test(peerAddress)) {
			console.log('Invalid peer address, not logging');
			return;
		}
		// Extract host:port from the peer address
		const hostPort = peerAddress.replace(/^wss?:\/\//, '');
		fs.readFile(this.peerDataPath, 'utf8', (err, data) => {
			let peers: string[] = [];
			if (!err) {
				try {
					peers = JSON.parse(data);
				} catch (parseError) {
					console.error('Error parsing peers.json:', parseError);
				}
			}
			// Add the host:port to the array
			peers.push(hostPort);
			// Deduplicate peers
			peers = Array.from(new Set(peers));
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
		});
	}

	private messageHandler(socket: WebSocket): void {
		socket.on('message', (message: string) => {
			const data: Message = JSON.parse(message);

			switch (data.type) {
				case MessageType.CHAIN:
					this.handleChainMessage(data.data);
					break;

				case MessageType.BLOCK:
					this.handleBlockMessage(data.data);
					break;

				case MessageType.TRANSACTION:
					this.handleTransactionMessage(data.data);
					break;

				// case MessageType.STAKE:
				// 	this.handleStakeMessage(data.data);
				// 	break;

				// case MessageType.UNSTAKE:
				// 	this.handleUnstakeMessage(data.data);
				// 	break;
			}
		});
	}

	private handleChainMessage(chain: Block[]): void {
		try {
			const blocks = chain.map((blockData) => {
				const transactions = blockData.transactions.map(
					(txData) => new Transaction(txData.inputs, txData.outputs)
				);

				return new Block(
					blockData.timestamp,
					transactions,
					blockData.previousHash,
					blockData.nonce,
					blockData.powDifficulty,
					blockData.index
				);
			});

			if (blocks.length > this.blockchain.getChain().length) {
				// Validate received chain
				const tempChain = new Blockchain();
				tempChain.getChain().length = 0; // Clear chain
				tempChain.getChain().push(...blocks);

				if (tempChain.isChainValid()) {
					this.blockchain.getChain().length = 0; // Clear current chain
					this.blockchain.getChain().push(...blocks);
					this.blockchain.clearPendingTransactions();
				}
			}
		} catch (error) {
			console.error('Error handling chain message:', error);
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

	private handleBlockMessage(blockData: Block): void {
		try {
			const transactions = blockData.transactions.map(
				(txData) => new Transaction(txData.inputs, txData.outputs)
			);

			const block = new Block(
				blockData.timestamp,
				transactions,
				blockData.previousHash,
				blockData.nonce,
				blockData.powDifficulty,
				blockData.index
			);

			this.blockchain.addMinedBlock(block);
			this.broadcast({
				type: MessageType.BLOCK,
				data: block,
			});
		} catch (error) {
			console.error('Error handling block message:', error);
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
