import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { Blockchain } from '../blockchain/Blockchain';
import { Transaction } from '../blockchain/Transaction';
import { Block } from '../blockchain/Block';
import fs from 'fs';

export enum MessageType {
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

export type Message = ChainMessage | TransactionMessage | BlockMessage | StakeMessage | UnstakeMessage;

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
		const server = new WebSocketServer({ port: this.p2pPort });
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
        if (socket.url) {
            this.reconnectToPeer(socket.url);
        }
    });
    
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
            // Convert Buffer to string if necessary
            const messageStr = message instanceof Buffer ? message.toString() : message;
            const data: Message = JSON.parse(messageStr);
            
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

                case MessageType.STAKE:
                    this.handleStakeMessage(data.data);
                    break;

                case MessageType.UNSTAKE:
                    this.handleUnstakeMessage(data.data);
                    break;
            }
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });
}

		private async reconnectToPeer(peer: string, attempt: number = 1): Promise<void> {
			const maxAttempts = 10;
			const baseDelay = 1000;
			
			if (attempt > maxAttempts) {
					console.log(`Max reconnection attempts reached for peer: ${peer}`);
					return;
			}
	
			const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 30000);
			
			try {
					await new Promise(resolve => setTimeout(resolve, delay));
					const socket = new WebSocket(peer);
					
					socket.on('open', () => {
							console.log(`Reconnected to peer: ${peer}`);
							this.connectSocket(socket);
					});
					
					socket.on('error', () => {
							console.log(`Reconnection attempt ${attempt} failed for peer: ${peer}`);
							this.reconnectToPeer(peer, attempt + 1);
					});
			} catch (error) {
					console.error(`Error reconnecting to peer: ${peer}`, error);
					this.reconnectToPeer(peer, attempt + 1);
			}
	}

	private async handleChainMessage(chain: Block[]): Promise<void> {
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
	            await this.blockchain.replaceLock.acquire();
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
	                this.blockchain.replaceLock.release();
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
