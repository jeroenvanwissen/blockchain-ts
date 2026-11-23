import * as crypto from 'crypto';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { Blockchain } from '../blockchain/Blockchain.js';
import { Transaction } from '../blockchain/Transaction.js';
import { Block } from '../blockchain/Block.js';
import fs from 'fs';
import {
	HANDSHAKE_TIMEOUT,
	MAX_KNOWN_PEERS,
	MAX_LOCATOR_HASHES,
	MAX_MESSAGE_BYTES,
	NETWORK_MAGIC,
	PEER_BROADCAST_INTERVAL,
	PROTOCOL_VERSION,
	RELAY_SEEN_CACHE_SIZE,
	SYNC_BATCH_SIZE,
} from '../config.js';

export enum MessageType {
	VERSION = 'VERSION',
	VERACK = 'VERACK',
	GET_BLOCKS = 'GET_BLOCKS',
	BLOCKS = 'BLOCKS',
	BLOCK = 'BLOCK',
	TRANSACTION = 'TRANSACTION',
	PEERS = 'PEERS',
}

/** First message on every connection, in both directions. */
export interface VersionPayload {
	magic: string;
	version: number;
	genesisHash: string;
	height: number;
	tip: string;
	nonce: string; // random per node: detects connections to ourselves
	listenPort: number; // 0 if unknown
}

export type Message =
	| { type: MessageType.VERSION; data: VersionPayload }
	| { type: MessageType.VERACK }
	| { type: MessageType.GET_BLOCKS; data: { locator: string[] } }
	| { type: MessageType.BLOCKS; data: { blocks: Block[]; more: boolean } }
	| { type: MessageType.BLOCK; data: Block }
	| { type: MessageType.TRANSACTION; data: Transaction }
	| { type: MessageType.PEERS; data: string[] };

interface PeerState {
	versionReceived: boolean;
	verackReceived: boolean;
	isSelf: boolean;
	version?: VersionPayload; // the peer's VERSION, kept until its VERACK arrives
	remoteAddress?: string; // inbound connections: the peer's IP
	handshakeTimer: NodeJS.Timeout | null;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function isVersionPayload(data: unknown): data is VersionPayload {
	if (typeof data !== 'object' || data === null) return false;
	const v = data as Record<string, unknown>;
	return (
		typeof v.magic === 'string' &&
		Number.isInteger(v.version) &&
		typeof v.genesisHash === 'string' &&
		Number.isSafeInteger(v.height) &&
		(v.height as number) >= 0 &&
		typeof v.tip === 'string' &&
		HASH_PATTERN.test(v.tip) &&
		typeof v.nonce === 'string' &&
		v.nonce.length > 0 &&
		v.nonce.length <= 64 &&
		Number.isInteger(v.listenPort) &&
		(v.listenPort as number) >= 0 &&
		(v.listenPort as number) <= 65535
	);
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
	private readonly _peerState = new Map<WebSocket, PeerState>();
	private readonly _nonce = crypto.randomBytes(8).toString('hex');
	private _server: WebSocketServer | null = null;
	private _isClosing = false;
	private readonly _seen = new Set<string>(); // recent `b:<hash>` / `t:<txid>`, oldest first

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

	/** Start accepting peers; resolves once the server is listening. */
	public listen(): Promise<void> {
		const server = new WebSocketServer({
			port: this.p2pPort,
			host: '0.0.0.0',
			clientTracking: true,
			perMessageDeflate: false,
			maxPayload: MAX_MESSAGE_BYTES,
		});
		this._server = server;

		server.on('connection', (socket, request) => {
			console.log(`New connection from ${request.socket.remoteAddress}`);
			this.connectSocket(socket, request.socket.remoteAddress);
		});

		server.on('error', (error) => {
			console.error('WebSocket Server error:', error);
		});

		return new Promise((resolve) => {
			server.on('listening', () => {
				console.log(`P2P Server listening on 0.0.0.0:${this.p2pPort}`);
				this._startPeerBroadcast();
				resolve();
			});
		});
	}

	/** Stop the server, drop all peers and timers (no reconnects). */
	public async close(): Promise<void> {
		this._isClosing = true;
		this._stopPeerBroadcast();
		for (const socket of [...this.sockets]) socket.terminate();
		for (const state of this._peerState.values()) {
			if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
		}
		const server = this._server;
		this._server = null;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
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
				maxPayload: MAX_MESSAGE_BYTES,
				headers: {
					'User-Agent': 'BlockchainClient',
				},
			});

			socket.on('open', () => {
				console.log(`Successfully connected to peer: ${normalizedPeer}`);
				this.connectSocket(socket);
			});

			socket.on('error', (error) => {
				// Unreachable peers are routine (offline, wrong address): not an error
				console.log(`Connection failed to peer: ${normalizedPeer} (${error.message})`);
				this.connectedPeers.delete(normalizedPeer); // Remove from tracking on error
			});

			socket.on('close', () => {
				this.connectedPeers.delete(normalizedPeer); // Remove from tracking on close
			});
		});
	}

	private connectSocket(socket: WebSocket, remoteAddress?: string): void {
		this.sockets.push(socket);
		const state: PeerState = {
			versionReceived: false,
			verackReceived: false,
			isSelf: false,
			remoteAddress,
			handshakeTimer: setTimeout(() => {
				if (!this._isReady(socket)) {
					console.log('Peer did not complete the handshake in time, disconnecting');
					socket.close();
				}
			}, HANDSHAKE_TIMEOUT),
		};
		state.handshakeTimer?.unref?.(); // don't keep the process alive for it
		this._peerState.set(socket, state);

		socket.on('error', (error) => {
			console.error('Socket connection error:', error);
			this._forget(socket);
		});

		socket.on('close', () => {
			this._forget(socket);
			const s = socket as unknown as { url?: string; reconnecting?: boolean };
			if (s.url && !s.reconnecting && !state.isSelf && !this._isClosing) {
				void this.reconnectToPeer(s.url);
			}
		});

		this.logPeerConnection(socket as unknown as WebSocket);
		this.messageHandler(socket);
		this._send(socket, { type: MessageType.VERSION, data: this._versionPayload() });
	}

	private _forget(socket: WebSocket): void {
		const index = this.sockets.indexOf(socket);
		if (index > -1) this.sockets.splice(index, 1);
		const state = this._peerState.get(socket);
		if (state?.handshakeTimer) clearTimeout(state.handshakeTimer);
		this._peerState.delete(socket);
	}

	private _isReady(socket: WebSocket): boolean {
		const state = this._peerState.get(socket);
		return !!state && state.versionReceived && state.verackReceived && !state.isSelf;
	}

	private _versionPayload(): VersionPayload {
		const tip = this.blockchain.getLatestBlock();
		return {
			magic: NETWORK_MAGIC,
			version: PROTOCOL_VERSION,
			genesisHash: this.blockchain.getChain()[0].hash,
			height: tip.index,
			tip: tip.hash,
			nonce: this._nonce,
			listenPort: this.p2pPort,
		};
	}

	private _send(socket: WebSocket, message: Message): void {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	}

	private async reconnectToPeer(
		peer: string,
		attempt: number = 1
	): Promise<void> {
		const maxAttempts = 10;
		const baseDelay = 1000;

		if (this._isClosing || this._ownAddresses.has(peer)) return;
		if (attempt > maxAttempts) {
			console.log(`Max reconnection attempts reached for peer: ${peer}`);
			return;
		}

		const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 30000);

		try {
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
			if (this._isClosing) return;
			const socket = new WebSocket(peer, { maxPayload: MAX_MESSAGE_BYTES });

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
		// Chain-affecting messages from one peer are handled in arrival order: blocks relayed
		// right after a BLOCKS batch must not be processed before that batch
		let queue: Promise<void> = Promise.resolve();
		const enqueue = (task: () => Promise<void>): void => {
			queue = queue.then(task, task);
		};

		socket.on('message', (message: Buffer | string) => {
			let data: Message;
			try {
				const text = message instanceof Buffer ? message.toString() : String(message);
				data = JSON.parse(text) as Message;
			} catch (error) {
				console.error('Error parsing message:', error);
				return;
			}
			if (typeof data !== 'object' || data === null) return;

			// Only the handshake is processed before it completes
			if (data.type === MessageType.VERSION) {
				this._handleVersion(socket, data.data);
				return;
			}
			if (data.type === MessageType.VERACK) {
				this._handleVerack(socket);
				return;
			}
			if (!this._isReady(socket)) return;

			switch (data.type) {
				case MessageType.GET_BLOCKS:
					this._handleGetBlocks(socket, data.data);
					break;
				case MessageType.BLOCKS: {
					const payload = data.data;
					enqueue(() => this._handleBlocks(socket, payload));
					break;
				}
				case MessageType.BLOCK: {
					const payload = data.data;
					enqueue(() => this.handleBlockMessage(payload, socket));
					break;
				}
				case MessageType.TRANSACTION: {
					const payload = data.data;
					enqueue(() => this.handleTransactionMessage(payload, socket));
					break;
				}
				case MessageType.PEERS:
					this._handlePeersMessage(data.data);
					break;
			}
		});
	}

	private _handleVersion(socket: WebSocket, data: unknown): void {
		const state = this._peerState.get(socket);
		if (!state || state.versionReceived) return;
		const reject = (reason: string) => {
			console.log(`Disconnecting peer: ${reason}`);
			socket.close();
		};
		if (!isVersionPayload(data)) return reject('malformed VERSION');
		if (data.magic !== NETWORK_MAGIC) return reject(`different network (${data.magic})`);
		if (data.version !== PROTOCOL_VERSION) return reject(`protocol version ${data.version}`);
		if (data.genesisHash !== this.blockchain.getChain()[0].hash) return reject('different genesis block');
		if (data.nonce === this._nonce) {
			state.isSelf = true;
			const url = (socket as unknown as { url?: string }).url;
			if (url) {
				const normalized = this.normalizePeerUrl(url);
				this._ownAddresses.add(normalized);
				this._knownPeers.delete(normalized);
				this._persistPeers();
			}
			return reject('connected to ourselves');
		}

		state.versionReceived = true;
		this._rememberListenAddress(state, data.listenPort);
		this._send(socket, { type: MessageType.VERACK });
		state.version = data;
		if (state.verackReceived) this._onReady(socket, data);
	}

	private _handleVerack(socket: WebSocket): void {
		const state = this._peerState.get(socket);
		if (!state || state.verackReceived) return;
		state.verackReceived = true;
		if (state.versionReceived && state.version) this._onReady(socket, state.version);
	}

	/** Handshake complete: share peers and fetch blocks if the peer has a tip we don't. */
	private _onReady(socket: WebSocket, version: VersionPayload): void {
		const state = this._peerState.get(socket);
		if (state?.handshakeTimer) {
			clearTimeout(state.handshakeTimer);
			state.handshakeTimer = null;
		}
		this._sendPeerList(socket);
		if (!this.blockchain.hasBlock(version.tip)) this._requestBlocks(socket);
	}

	/** Inbound peers tell us their listen port: remember host:port so others can reach them. */
	private _rememberListenAddress(state: PeerState, listenPort: number): void {
		if (!state.remoteAddress || listenPort === 0) return;
		let host = state.remoteAddress.replace(/^::ffff:/, '');
		if (host.includes(':')) host = `[${host}]`;
		const address = this.normalizePeerUrl(`${host}:${listenPort}`);
		if (!isValidPeerAddress(address) || this._ownAddresses.has(address)) return;
		if (this._knownPeers.size >= MAX_KNOWN_PEERS || this._knownPeers.has(address)) return;
		this._knownPeers.add(address);
		this._persistPeers();
	}

	private _requestBlocks(socket: WebSocket, after?: string): void {
		const locator = this.blockchain.getBlockLocator();
		if (after) locator.unshift(after);
		this._send(socket, {
			type: MessageType.GET_BLOCKS,
			data: { locator: locator.slice(0, MAX_LOCATOR_HASHES) },
		});
	}

	private _handleGetBlocks(socket: WebSocket, data: unknown): void {
		const locator = (data as { locator?: unknown } | null)?.locator;
		if (
			!Array.isArray(locator) ||
			locator.length > MAX_LOCATOR_HASHES ||
			!locator.every((hash) => typeof hash === 'string' && HASH_PATTERN.test(hash))
		) {
			return;
		}
		// Up to SYNC_BATCH_SIZE blocks, and at most half the message limit in total
		const candidates = this.blockchain.getBlocksAfter(locator as string[], SYNC_BATCH_SIZE + 1);
		const blocks: Block[] = [];
		let bytes = 0;
		for (const block of candidates.slice(0, SYNC_BATCH_SIZE)) {
			const size = JSON.stringify(block).length;
			if (blocks.length > 0 && bytes + size > MAX_MESSAGE_BYTES / 2) break;
			blocks.push(block);
			bytes += size;
		}
		const more = candidates.length > blocks.length;
		this._send(socket, { type: MessageType.BLOCKS, data: { blocks, more } });
	}

	private async _handleBlocks(socket: WebSocket, data: unknown): Promise<void> {
		const payload = data as { blocks?: unknown; more?: unknown } | null;
		if (!payload || !Array.isArray(payload.blocks) || payload.blocks.length > SYNC_BATCH_SIZE) {
			return;
		}
		let accepted = 0;
		let lastHash: string | undefined;
		for (const raw of payload.blocks) {
			try {
				const block = Block.fromJSON(raw);
				lastHash = block.hash;
				if (this.blockchain.hasBlock(block.hash)) continue;
				await this.blockchain.addMinedBlock(block);
				accepted++;
			} catch (error) {
				console.error('Error syncing block from peer:', (error as Error).message);
				return; // stop at the first bad block; don't ask this peer for more
			}
		}
		if (accepted > 0) {
			const tip = this.blockchain.getLatestBlock();
			console.log(
				`Synced ${accepted} block(s) from peer: height ${tip.index}, tip ${tip.hash.slice(0, 16)}`,
			);
		}
		if (payload.more === true && lastHash) {
			this._requestBlocks(socket, lastHash);
		} else if (accepted > 0) {
			// Caught up: announce the new tip so peers that lack it can sync from us
			const tip = this.blockchain.getLatestBlock();
			this._markSeen(`b:${tip.hash}`);
			this.broadcast({ type: MessageType.BLOCK, data: tip }, socket);
		}
	}

	/**
	 * Remember a relayed item; false if it was seen recently (duplicate, echo, or something
	 * already rejected), so it is neither re-validated nor relayed again.
	 */
	private _markSeen(id: string): boolean {
		if (this._seen.has(id)) return false;
		this._seen.add(id);
		if (this._seen.size > RELAY_SEEN_CACHE_SIZE) {
			this._seen.delete(this._seen.values().next().value as string);
		}
		return true;
	}

	private async handleBlockMessage(blockData: unknown, from?: WebSocket): Promise<void> {
		try {
			const block = Block.fromJSON(blockData);
			// Ignore blocks seen recently or already known (e.g. our own block echoed back)
			if (!this._markSeen(`b:${block.hash}`) || this.blockchain.hasBlock(block.hash)) return;
			// Unknown parent: we are missing blocks; fetch them from this peer
			if (!this.blockchain.hasBlock(block.previousHash)) {
				if (from) this._requestBlocks(from);
				return;
			}
			const outcome = await this.blockchain.addMinedBlock(block);
			const label = outcome === 'side' ? 'Stored side-branch block' : 'Accepted block';
			console.log(`${label} ${block.index} (${block.hash.slice(0, 16)}) from peer`);
			// Relay only accepted blocks, and not back to the sender
			this.broadcast({ type: MessageType.BLOCK, data: block }, from);
		} catch (error) {
			console.error('Error handling block message:', error);
		}
	}

	private async handleTransactionMessage(txData: unknown, from?: WebSocket): Promise<void> {
		try {
			// fromJSON keeps every field, so the txid matches the sender's
			const transaction = Transaction.fromJSON(txData);
			if (!this._markSeen(`t:${transaction.calculateHash()}`)) return;
			await this.blockchain.addTransaction(transaction);
			// Relay only accepted transactions, and not back to the sender
			this.broadcast({ type: MessageType.TRANSACTION, data: transaction }, from);
		} catch (error) {
			console.error('Error handling transaction message:', error);
		}
	}

	/** Announce a transaction accepted locally. */
	broadcastTransaction(transaction: Transaction): void {
		this._markSeen(`t:${transaction.calculateHash()}`);
		this.broadcast({ type: MessageType.TRANSACTION, data: transaction });
	}

	/** Announce a block produced or accepted locally. */
	broadcastBlock(block: Block): void {
		this._markSeen(`b:${block.hash}`);
		this.broadcast({ type: MessageType.BLOCK, data: block });
	}

	/** Send to every peer that completed the handshake, except `except` (the sender). */
	private broadcast(message: Message, except?: WebSocket): void {
		for (const socket of this.sockets) {
			if (socket !== except && this._isReady(socket)) this._send(socket, message);
		}
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
		this.broadcast({ type: MessageType.PEERS, data: peers });
	}

	private _sendPeerList(socket: WebSocket): void {
		const peers = this.getKnownPeers();
		if (peers.length === 0) return;
		this._send(socket, { type: MessageType.PEERS, data: peers });
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
