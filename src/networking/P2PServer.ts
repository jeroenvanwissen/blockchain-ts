import * as crypto from 'crypto';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { Blockchain } from '../blockchain/Blockchain.js';
import { Transaction } from '../blockchain/Transaction.js';
import { Block } from '../blockchain/Block.js';
import fs from 'fs';
import {
	BAN_DURATION,
	BAN_SCORE,
	BLOCK_JSON_CACHE_SIZE,
	GET_BLOCKS_INTERVAL,
	HANDSHAKE_TIMEOUT,
	MAX_INBOUND_PEERS,
	MAX_KNOWN_PEERS,
	MAX_OUTBOUND_PEERS,
	MAX_PENDING_GET_BLOCKS,
	MAX_RECONNECT_ATTEMPTS,
	MAX_LOCATOR_HASHES,
	MAX_MESSAGE_BYTES,
	NETWORK_MAGIC,
	PEER_BROADCAST_INTERVAL,
	PROTOCOL_VERSION,
	RECONNECT_BASE_DELAY,
	RECONNECT_MAX_DELAY,
	RELAY_SEEN_CACHE_SIZE,
	SYNC_BATCH_SIZE,
} from '../config.js';
import { logger } from '../logger.js';

const log = logger('P2P');

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
	score: number; // misbehavior points; BAN_SCORE gets the peer banned
	pendingGetBlocks: number; // block requests queued for this peer
	nextBlocksAt: number; // earliest time (ms) the next block batch may be sent
}

/** Block rejections an honest peer can cause (races, our clock): no misbehavior points. */
const BENIGN_BLOCK_ERRORS = ['block already known', 'unknown parent block', 'too far in the future'];

function isLoopback(ip: string): boolean {
	return ip === '::1' || ip.startsWith('127.');
}

/** A connected peer that completed the handshake (for the API). */
export interface PeerInfo {
	address: string; // outbound: the URL we dialed; inbound: remote IP, plus its listen port if known
	inbound: boolean;
	startHeight: number; // height in the peer's VERSION
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
	private readonly _banned = new Map<string, number>(); // ban key → expiry (ms)
	private readonly _dialing = new Set<WebSocket>(); // outbound sockets not open yet
	private readonly _blockJson = new Map<string, string>(); // block hash → serialized block, oldest first
	private readonly _banListPath: string | undefined;

	private readonly _networkMagic: string;

	constructor(
		private blockchain: Blockchain,
		private p2pPort: number,
		private peerDataPath: string,
		options: { networkMagic?: string; banListPath?: string } = {},
	) {
		this._networkMagic = options.networkMagic ?? NETWORK_MAGIC;
		this._banListPath = options.banListPath;
		this._loadBans();
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
			const remoteAddress = request.socket.remoteAddress;
			const ip = (remoteAddress ?? '').replace(/^::ffff:/, '');
			if (!isLoopback(ip) && this.isBanned(ip)) {
				socket.close(1008, 'banned');
				return;
			}
			if (this._countPeers(true) >= MAX_INBOUND_PEERS) {
				log.info(`Refusing inbound connection from ${ip}: ${MAX_INBOUND_PEERS} inbound peers already`);
				socket.close(1013, 'too many peers');
				return;
			}
			log.debug(`New connection from ${remoteAddress}`);
			this.connectSocket(socket, remoteAddress);
		});

		// Until it listens, an error (port taken, no permission) rejects; afterwards it's logged
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.once('listening', () => {
				server.off('error', reject);
				server.on('error', (error) => log.error('WebSocket Server error:', error));
				log.info(`P2P Server listening on 0.0.0.0:${this.p2pPort}`);
				this._startPeerBroadcast();
				resolve();
			});
		});
	}

	/** Stop the server, drop all peers and timers (no reconnects). */
	public async close(): Promise<void> {
		this._isClosing = true;
		this._stopPeerBroadcast();
		for (const socket of [...this.sockets, ...this._dialing]) socket.terminate();
		this._dialing.clear();
		for (const state of this._peerState.values()) {
			if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
		}
		const server = this._server;
		this._server = null;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/** Remember these peers and dial them, up to MAX_OUTBOUND_PEERS connections. */
	connectToPeers(newPeers: string[]): void {
		for (const peer of newPeers) {
			const normalizedPeer = this.normalizePeerUrl(peer);
			if (!isValidPeerAddress(normalizedPeer)) {
				log.warn(`Invalid peer address, skipping: ${peer}`);
				continue;
			}
			if (this._ownAddresses.has(normalizedPeer) || this.isBanned(normalizedPeer)) continue;
			this._knownPeers.add(normalizedPeer);
			if (this._canDial(normalizedPeer)) this._dial(normalizedPeer);
		}
	}

	/** Whether `key` (a peer URL, IP, or loopback IP:port) is banned right now. */
	isBanned(key: string): boolean {
		const expiry = this._banned.get(key);
		if (expiry === undefined) return false;
		if (Date.now() < expiry) return true;
		this._banned.delete(key);
		return false;
	}

	/** Outbound connections, including dials in progress (inbound: connected inbound peers). */
	private _countPeers(inbound: boolean): number {
		if (!inbound) return this.connectedPeers.size;
		return this.sockets.filter((socket) => !(socket as unknown as { url?: string }).url).length;
	}

	private _canDial(url: string): boolean {
		return (
			!this._isClosing &&
			!this.connectedPeers.has(url) &&
			!this._ownAddresses.has(url) &&
			!this.isBanned(url) &&
			this._countPeers(false) < MAX_OUTBOUND_PEERS
		);
	}

	/** Open an outbound connection; `onFail` runs if it never opens. */
	private _dial(url: string, onFail?: () => void): void {
		this.connectedPeers.add(url); // connecting or connected
		log.debug(`Attempting to connect to peer: ${url}`);
		const socket = new WebSocket(url, {
			handshakeTimeout: 5000,
			maxPayload: MAX_MESSAGE_BYTES,
			headers: { 'User-Agent': 'BlockchainClient' },
		});
		this._dialing.add(socket);
		let opened = false;
		socket.on('open', () => {
			opened = true;
			this._dialing.delete(socket);
			log.info(`Successfully connected to peer: ${url}`);
			this.connectSocket(socket);
		});
		socket.on('error', (error) => {
			this._dialing.delete(socket);
			this.connectedPeers.delete(url);
			// connectSocket handles errors on established connections; close() cancels dials
			if (opened || this._isClosing) return;
			// Unreachable peers are routine (offline, wrong address): not an error
			log.info(`Connection failed to peer: ${url} (${error.message})`);
			onFail?.();
		});
		socket.on('close', () => {
			this._dialing.delete(socket);
			this.connectedPeers.delete(url);
		});
	}

	/** Top outbound connections back up from known peers (runs with the peer broadcast). */
	private _fillOutbound(): void {
		for (const peer of this._knownPeers) {
			if (this._countPeers(false) >= MAX_OUTBOUND_PEERS) break;
			if (this._canDial(peer)) this._dial(peer);
		}
	}

	/** Add misbehavior points; at BAN_SCORE the peer is disconnected and banned. */
	private _misbehaving(socket: WebSocket, points: number, reason: string): void {
		const state = this._peerState.get(socket);
		if (!state || points <= 0) return;
		state.score += points;
		log.warn(`Peer misbehaving (+${points}, score ${state.score}/${BAN_SCORE}): ${reason}`);
		if (state.score < BAN_SCORE) return;
		const key = this._banKey(socket, state);
		this._banned.set(key, Date.now() + BAN_DURATION);
		this._saveBans();
		log.warn(`Banning peer ${key} for ${BAN_DURATION / 3_600_000} h`);
		const url = (socket as unknown as { url?: string }).url;
		if (url && this._knownPeers.delete(this.normalizePeerUrl(url))) this._persistPeers();
		socket.close(1008, 'misbehaving');
	}

	/**
	 * What a ban applies to: the dialed URL for outbound peers, the IP for inbound ones. On
	 * loopback (local test networks share 127.0.0.1) the inbound key includes the listen port.
	 */
	private _banKey(socket: WebSocket, state: PeerState): string {
		const url = (socket as unknown as { url?: string }).url;
		if (url) return this.normalizePeerUrl(url);
		const ip = (state.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
		return isLoopback(ip) ? `${ip}:${state.version?.listenPort ?? 0}` : ip;
	}

	/** A peer's block was rejected: misbehavior unless an honest peer could cause it. */
	private _blockRejected(socket: WebSocket | undefined, error: Error): void {
		if (BENIGN_BLOCK_ERRORS.some((benign) => error.message.includes(benign))) {
			log.debug('Block from peer not accepted:', error.message);
			return;
		}
		log.warn('Rejected invalid block from peer:', error.message);
		if (socket) this._misbehaving(socket, 50, `invalid block (${error.message})`);
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
					log.info('Peer did not complete the handshake in time, disconnecting');
					socket.close();
				}
			}, HANDSHAKE_TIMEOUT),
			score: 0,
			pendingGetBlocks: 0,
			nextBlocksAt: 0,
		};
		state.handshakeTimer?.unref?.(); // don't keep the process alive for it
		this._peerState.set(socket, state);

		socket.on('error', (error) => {
			log.info('Socket connection error:', error.message);
			this._forget(socket);
		});

		socket.on('close', () => {
			this._forget(socket);
			const url = (socket as unknown as { url?: string }).url;
			if (url && !state.isSelf && !this._isClosing) this.reconnectToPeer(this.normalizePeerUrl(url));
		});

		this.logPeerConnection(socket);
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
			magic: this._networkMagic,
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

	/**
	 * Redial a lost outbound peer with capped exponential backoff. After MAX_RECONNECT_ATTEMPTS
	 * the periodic outbound fill may still pick it up. Never redials banned peers or beyond
	 * the outbound limit.
	 */
	private reconnectToPeer(peer: string, attempt: number = 1): void {
		if (attempt > MAX_RECONNECT_ATTEMPTS) {
			log.info(`Max reconnection attempts reached for peer: ${peer}`);
			return;
		}
		const delay = Math.min(RECONNECT_BASE_DELAY * 2 ** (attempt - 1), RECONNECT_MAX_DELAY);
		const timer = setTimeout(() => {
			if (!this._canDial(peer)) return;
			this._dial(peer, () => {
				log.debug(`Reconnection attempt ${attempt} failed for peer: ${peer}`);
				this.reconnectToPeer(peer, attempt + 1);
			});
		}, delay);
		timer.unref?.();
	}

	private logPeerConnection(socket: WebSocket): void {
		const peerAddress = (socket as unknown as { url?: string }).url;
		if (!peerAddress || !/^wss?:\/\//.test(peerAddress)) {
			log.debug('Invalid peer address, not logging');
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
			} catch {
				this._misbehaving(socket, 20, 'message is not JSON');
				return;
			}
			if (typeof data !== 'object' || data === null) {
				this._misbehaving(socket, 20, 'message is not an object');
				return;
			}

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
					this._handlePeersMessage(data.data, socket);
					break;
			}
		});
	}

	private _handleVersion(socket: WebSocket, data: unknown): void {
		const state = this._peerState.get(socket);
		if (!state || state.versionReceived) return;
		const reject = (reason: string) => {
			log.info(`Disconnecting peer: ${reason}`);
			socket.close();
		};
		if (!isVersionPayload(data)) return reject('malformed VERSION');
		if (data.magic !== this._networkMagic) return reject(`different network (${data.magic})`);
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

		if (this.isBanned(this._banKey(socket, { ...state, version: data }))) return reject('banned');

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

	/**
	 * Queue a block request. Honest peers wait for each batch before asking for the next, so a
	 * peer's requests are served one at a time, GET_BLOCKS_INTERVAL apart, and a peer with more
	 * than MAX_PENDING_GET_BLOCKS waiting is flooding.
	 */
	private _handleGetBlocks(socket: WebSocket, data: unknown): void {
		const locator = (data as { locator?: unknown } | null)?.locator;
		if (
			!Array.isArray(locator) ||
			locator.length > MAX_LOCATOR_HASHES ||
			!locator.every((hash) => typeof hash === 'string' && HASH_PATTERN.test(hash))
		) {
			this._misbehaving(socket, 10, 'malformed GET_BLOCKS');
			return;
		}
		const state = this._peerState.get(socket);
		if (!state) return;
		if (state.pendingGetBlocks >= MAX_PENDING_GET_BLOCKS) {
			this._misbehaving(socket, 10, 'too many block requests');
			return;
		}
		state.pendingGetBlocks++;
		const now = Date.now();
		const sendAt = Math.max(now, state.nextBlocksAt);
		state.nextBlocksAt = sendAt + GET_BLOCKS_INTERVAL;
		const timer = setTimeout(() => {
			state.pendingGetBlocks--;
			if (this._isReady(socket)) this._sendBlocks(socket, locator as string[]);
		}, sendAt - now);
		timer.unref?.();
	}

	/** Up to SYNC_BATCH_SIZE blocks after the locator, and at most half the message limit. */
	private _sendBlocks(socket: WebSocket, locator: string[]): void {
		const candidates = this.blockchain.getBlocksAfter(locator, SYNC_BATCH_SIZE + 1);
		const parts: string[] = [];
		let bytes = 0;
		for (const block of candidates.slice(0, SYNC_BATCH_SIZE)) {
			const json = this._serializedBlock(block);
			if (parts.length > 0 && bytes + json.length > MAX_MESSAGE_BYTES / 2) break;
			parts.push(json);
			bytes += json.length;
		}
		const more = candidates.length > parts.length;
		// Same JSON as _send({ type: BLOCKS, data: { blocks, more } }), from cached block strings
		const message = `{"type":${JSON.stringify(MessageType.BLOCKS)},"data":{"blocks":[${parts.join(',')}],"more":${more}}}`;
		if (socket.readyState === WebSocket.OPEN) socket.send(message);
	}

	/** A block's JSON, cached: blocks never change, and sync sends the same ones repeatedly. */
	private _serializedBlock(block: Block): string {
		let json = this._blockJson.get(block.hash);
		if (json === undefined) {
			json = JSON.stringify(block);
			this._blockJson.set(block.hash, json);
			if (this._blockJson.size > BLOCK_JSON_CACHE_SIZE) {
				this._blockJson.delete(this._blockJson.keys().next().value as string);
			}
		}
		return json;
	}

	/** Bans from the ban list file that haven't expired (no file: none). */
	private _loadBans(): void {
		if (!this._banListPath || !fs.existsSync(this._banListPath)) return;
		try {
			const stored = JSON.parse(fs.readFileSync(this._banListPath, 'utf8')) as unknown;
			if (typeof stored !== 'object' || stored === null) return;
			const now = Date.now();
			for (const [key, expiry] of Object.entries(stored)) {
				if (typeof expiry === 'number' && expiry > now) this._banned.set(key, expiry);
			}
		} catch (error) {
			log.warn('ignoring unreadable ban list:', (error as Error).message);
		}
	}

	private _saveBans(): void {
		if (!this._banListPath) return;
		const now = Date.now();
		const current = Object.fromEntries([...this._banned].filter(([, expiry]) => expiry > now));
		try {
			fs.writeFileSync(this._banListPath, JSON.stringify(current, null, 2));
		} catch (error) {
			log.error('Error writing ban list:', error);
		}
	}

	private async _handleBlocks(socket: WebSocket, data: unknown): Promise<void> {
		const payload = data as { blocks?: unknown; more?: unknown } | null;
		if (!payload || !Array.isArray(payload.blocks) || payload.blocks.length > SYNC_BATCH_SIZE) {
			this._misbehaving(socket, 20, 'malformed BLOCKS');
			return;
		}
		let accepted = 0;
		let lastHash: string | undefined;
		for (const raw of payload.blocks) {
			let block: Block;
			try {
				block = Block.fromJSON(raw);
			} catch (error) {
				this._misbehaving(socket, 50, (error as Error).message);
				return;
			}
			lastHash = block.hash;
			if (this.blockchain.hasBlock(block.hash)) continue;
			try {
				await this.blockchain.addMinedBlock(block);
				accepted++;
			} catch (error) {
				this._blockRejected(socket, error as Error);
				return; // stop at the first bad block; don't ask this peer for more
			}
		}
		if (accepted > 0) {
			const tip = this.blockchain.getLatestBlock();
			log.info(
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
		let block: Block;
		try {
			block = Block.fromJSON(blockData);
		} catch (error) {
			log.warn('Error handling block message:', (error as Error).message);
			if (from) this._misbehaving(from, 50, (error as Error).message);
			return;
		}
		try {
			// Ignore blocks seen recently or already known (e.g. our own block echoed back)
			if (!this._markSeen(`b:${block.hash}`) || this.blockchain.hasBlock(block.hash)) return;
			// Unknown parent: we are missing blocks; fetch them from this peer
			if (!this.blockchain.hasBlock(block.previousHash)) {
				if (from) this._requestBlocks(from);
				return;
			}
			const outcome = await this.blockchain.addMinedBlock(block);
			const label = outcome === 'side' ? 'Stored side-branch block' : 'Accepted block';
			log.info(`${label} ${block.index} (${block.hash.slice(0, 16)}) from peer`);
			// Relay only accepted blocks, and not back to the sender
			this.broadcast({ type: MessageType.BLOCK, data: block }, from);
		} catch (error) {
			this._blockRejected(from, error as Error);
		}
	}

	private async handleTransactionMessage(txData: unknown, from?: WebSocket): Promise<void> {
		let transaction: Transaction;
		try {
			// fromJSON keeps every field, so the txid matches the sender's
			transaction = Transaction.fromJSON(txData);
		} catch (error) {
			log.warn('Error handling transaction message:', (error as Error).message);
			if (from) this._misbehaving(from, 20, (error as Error).message);
			return;
		}
		try {
			if (!this._markSeen(`t:${transaction.calculateHash()}`)) return;
			await this.blockchain.addTransaction(transaction);
			// Relay only accepted transactions, and not back to the sender
			this.broadcast({ type: MessageType.TRANSACTION, data: transaction }, from);
		} catch (error) {
			// Policy rejections (fee, conflicts, behind on blocks) are normal: no points
			log.debug('Transaction not accepted:', (error as Error).message);
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
			this._fillOutbound();
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

	private _handlePeersMessage(peerAddresses: unknown, from?: WebSocket): void {
		if (!Array.isArray(peerAddresses)) {
			if (from) this._misbehaving(from, 10, 'malformed PEERS');
			return;
		}

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
			log.error('Error writing peers.json:', error);
		}
	}

	getSockets(): WebSocket[] {
		return this.sockets;
	}

	getPeerInfo(): PeerInfo[] {
		const peers: PeerInfo[] = [];
		for (const socket of this.sockets) {
			const state = this._peerState.get(socket);
			if (!state?.version || !this._isReady(socket)) continue;
			const url = (socket as unknown as { url?: string }).url;
			const inbound = !url;
			let address = url ? this.normalizePeerUrl(url) : (state.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
			if (inbound && state.version.listenPort > 0) address = `${address}:${state.version.listenPort}`;
			peers.push({ address, inbound, startHeight: state.version.height });
		}
		return peers;
	}
}
