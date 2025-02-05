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
	GET_LATEST_BLOCK = 'GET_LATEST_BLOCK',
	LATEST_BLOCK = 'LATEST_BLOCK'
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

export type Message = ChainMessage | TransactionMessage | BlockMessage | 
    StakeMessage | UnstakeMessage | GetLatestBlockMessage | LatestBlockMessage;

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
            perMessageDeflate: false
        });

        server.on('connection', (socket, request) => {
            console.log(`New connection from ${request.socket.remoteAddress}`);
            this.connectSocket(socket);
        });

        server.on('error', (error) => {
            console.error('WebSocket Server error:', error);
        });

        server.on('listening', () => {
            console.log(`P2P Server listening on ${server.address().address}:${this.p2pPort}`);
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
                    'User-Agent': 'BlockchainClient'
                }
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

    // // Update reconnectToPeer method
    // private async reconnectToPeer(peer: string, attempt: number = 1): Promise<void> {
    //     const normalizedPeer = this.normalizePeerUrl(peer);
        
    //     // Don't attempt to reconnect if already connected or connecting
    //     if (this.connectedPeers.has(normalizedPeer)) {
    //         return;
    //     }

    //     // Rest of the reconnectToPeer method remains the same...
    // }

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
        if (socket.url) {
            // Only attempt reconnection if socket is not already reconnecting
            if (!socket.reconnecting) {
                this.reconnectToPeer(socket.url);
            }
        }
    });
    
    this.logPeerConnection(socket);
    this.messageHandler(socket);
    this.sendChain(socket);
}

private async reconnectToPeer(peer: string, attempt: number = 1): Promise<void> {
    const normalizedPeer = this.normalizePeerUrl(peer);
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
        
        // Mark socket as reconnecting
        (socket as any).reconnecting = true;
        
        socket.on('open', () => {
            (socket as any).reconnecting = false;
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
						data: latestBlock
				};
				socket.send(JSON.stringify(message));
		} catch (error) {
				console.error('Error handling get latest block message:', error);
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

	private async handleBlockMessage(blockData: Block): Promise<void> {
	    try {
	        const transactions = blockData.transactions.map(
	            (txData) => new Transaction(txData.inputs, txData.outputs, txData.timestamp, txData.nonce)
	        );
	
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
	            // Request the full chain from peers
	            this.broadcast({
	                type: MessageType.GET_LATEST_BLOCK,
	                data: null,
	            });
	            return;
	        }
	
	        // If the block index matches our current chain length, try to add it
	        await this.blockchain.replaceLock.acquire();
	        try {
	            this.blockchain.addMinedBlock(block);
	            // Only broadcast if we successfully added the block
	            this.broadcast({
	                type: MessageType.BLOCK,
	                data: block,
	            });
	        } finally {
	            this.blockchain.replaceLock.release();
	        }
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
