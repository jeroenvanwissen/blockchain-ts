import * as crypto from 'crypto';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { Blockchain, StorageError } from '../blockchain/Blockchain.js';
import { Transaction } from '../blockchain/Transaction.js';
import { Block } from '../blockchain/Block.js';
import fs from 'fs';
import {
	BAN_DURATION,
	BAN_SCORE,
	BLOCK_JSON_CACHE_SIZE,
	GET_BLOCKS_INTERVAL,
	HANDSHAKE_TIMEOUT,
	MAX_ADDRESSES_PER_MESSAGE,
	MAX_INBOUND_PEERS,
	MAX_INVENTORY,
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
import { AddressBook } from './AddressBook.js';

const log = logger('P2P');

export enum MessageType {
	VERSION = 'VERSION',
	VERACK = 'VERACK',
	GET_BLOCKS = 'GET_BLOCKS',
	BLOCKS = 'BLOCKS',
	BLOCK = 'BLOCK',
	TRANSACTION = 'TRANSACTION',
	PEERS = 'PEERS',
	MEMPOOL = 'MEMPOOL', // after the handshake: the txids of our pending transactions
	GET_TRANSACTIONS = 'GET_TRANSACTIONS', // the announced ones we lack; answered with TRANSACTION messages
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
	| { type: MessageType.PEERS; data: string[] }
	| { type: MessageType.MEMPOOL; data: { txids: string[] } }
	| { type: MessageType.GET_TRANSACTIONS; data: { txids: string[] } };

interface PeerState {
	versionReceived: boolean;
	verackReceived: boolean;
	isSelf: boolean;
	isDuplicate: boolean; // a second connection to a node we're connected to; being closed
	version?: VersionPayload; // the peer's VERSION, kept until its VERACK arrives
	remoteAddress?: string; // inbound connections: the peer's IP
	handshakeTimer: NodeJS.Timeout | null;
	score: number; // misbehavior points; BAN_SCORE gets the peer banned
	pendingGetBlocks: number; // block requests queued for this peer
	nextBlocksAt: number; // earliest time (ms) the next block batch may be sent
	caughtUp: boolean; // we have the peer's tip, or finished syncing from it
	inventoryReceived: boolean; // the peer's MEMPOOL arrived (one per connection)
	inventory: string[] | null; // its txids, kept until we have caught up
	announced: Set<string>; // txids in our MEMPOOL to it that it may still request
	requested: Set<string>; // txids we asked it for
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

/** The txid list of a MEMPOOL or GET_TRANSACTIONS message, or null if malformed. */
function parseTxids(data: unknown): string[] | null {
	const txids = (data as { txids?: unknown } | null)?.txids;
	if (!Array.isArray(txids) || txids.length > MAX_INVENTORY) return null;
	return txids.every((txid) => typeof txid === 'string' && HASH_PATTERN.test(txid)) ? (txids as string[]) : null;
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
	private readonly _addresses = new AddressBook(); // known peer addresses
	private _ownAddresses: Set<string>;
	private _peerBroadcastInterval: NodeJS.Timeout | null = null;
	private readonly _peerState = new Map<WebSocket, PeerState>();
	private readonly _nonce = crypto.randomBytes(8).toString('hex');
	private readonly _aliases = new Map<string, string>(); // address → nonce of the node it reached, after a duplicate
	private _server: WebSocketServer | null = null;
	private _isClosing = false;
	private readonly _seen = new Set<string>(); // recent `b:<hash>` / `t:<txid>`, oldest first
	private readonly _banned = new Map<string, number>(); // ban key → expiry (ms)
	private readonly _dialing = new Set<WebSocket>(); // outbound sockets not open yet
	// Peer address → its latest redial attempt, until a handshake with it completes: a peer that
	// accepts the connection and then refuses the handshake backs off like an unreachable one
	private readonly _redials = new Map<string, number>();
	private readonly _blockJson = new Map<string, string>(); // block hash → serialized block, oldest first
	private readonly _banListPath: string | undefined;

	private readonly _networkMagic: string;
	private readonly _externalPort: number; // announced in VERSION as the port peers dial

	constructor(
		private blockchain: Blockchain,
		private p2pPort: number,
		private peerDataPath: string,
		options: { networkMagic?: string; banListPath?: string; externalPort?: number } = {},
	) {
		this._networkMagic = options.networkMagic ?? NETWORK_MAGIC;
		this._externalPort = options.externalPort ?? p2pPort;
		this._banListPath = options.banListPath;
		this._loadBans();
		this.sockets = [];
		this.connectedPeers = new Set();
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
				const external = this._externalPort === this.p2pPort ? '' : ` (peers dial port ${this._externalPort})`;
				log.info(`P2P Server listening on 0.0.0.0:${this.p2pPort}${external}`);
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
		this._redials.clear();
		for (const state of this._peerState.values()) {
			if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
		}
		const server = this._server;
		this._server = null;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/**
	 * Dial these operator-given peers (CLI, seeds) and keep them as configured addresses, up to
	 * MAX_OUTBOUND_PEERS connections.
	 */
	connectToPeers(newPeers: string[]): void {
		for (const peer of newPeers) {
			const normalizedPeer = this.normalizePeerUrl(peer);
			if (!isValidPeerAddress(normalizedPeer)) {
				log.warn(`Invalid peer address, skipping: ${peer}`);
				continue;
			}
			if (this._ownAddresses.has(normalizedPeer) || this.isBanned(normalizedPeer)) continue;
			this._addresses.addConfigured(normalizedPeer);
			if (this._canDial(normalizedPeer)) this._dial(normalizedPeer);
		}
		this._persistPeers();
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
			this._addresses.has(url) &&
			!this._ownAddresses.has(url) &&
			!this.isBanned(url) &&
			!this._reachesConnectedNode(url) &&
			this._countPeers(false) < MAX_OUTBOUND_PEERS
		);
	}

	/** Whether `url` is known to reach a node we're already connected to (under another address). */
	private _reachesConnectedNode(url: string): boolean {
		const nonce = this._aliases.get(url);
		if (nonce === undefined) return false;
		if (this._readyPeerWithNonce(nonce)) return true;
		this._aliases.delete(url); // that node left (or restarted with a new nonce)
		return false;
	}

	private _readyPeerWithNonce(nonce: string, except?: WebSocket): WebSocket | undefined {
		return this.sockets.find((s) => s !== except && this._isReady(s) && this._peerState.get(s)?.version?.nonce === nonce);
	}

	/**
	 * One connection per node (TASK-0044). A node can be reachable under several addresses (a
	 * hostname and an IP), and two nodes may dial each other. When a second connection to a node
	 * (same VERSION nonce) completes its handshake, only a dialing side closes one, so both ends
	 * agree on the survivor: a node that dialed another twice closes its newer dial; when two
	 * nodes dialed each other, the one with the higher nonce closes its dial. The closed address
	 * isn't redialed while that node stays connected. Returns true if `socket` was closed.
	 */
	private _dropDuplicate(socket: WebSocket, nonce: string): boolean {
		const other = this._readyPeerWithNonce(nonce, socket);
		if (!other) return false;
		const outbound = !!(socket as unknown as { url?: string }).url;
		const otherOutbound = !!(other as unknown as { url?: string }).url;
		let drop: WebSocket | undefined;
		if (outbound && otherOutbound) drop = socket;
		else if (outbound !== otherOutbound && this._nonce > nonce) drop = outbound ? socket : other;
		if (!drop) return false; // the other node closes one
		const url = this.normalizePeerUrl((drop as unknown as { url: string }).url);
		this._peerState.get(drop)!.isDuplicate = true;
		this._aliases.set(url, nonce);
		log.info(`Disconnecting peer: already connected to this node (${url})`);
		drop.close();
		return drop === socket;
	}

	/** Open an outbound connection; `onFail` runs if it never opens. */
	private _dial(url: string, onFail?: () => void): void {
		this.connectedPeers.add(url); // connecting or connected
		this._addresses.markAttempt(url, Date.now());
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
			if (this._addresses.markFailure(url, Date.now())) {
				log.info(`Dropping peer address ${url} after repeated failures`);
				this._persistPeers();
			}
			onFail?.();
		});
		socket.on('close', () => {
			this._dialing.delete(socket);
			this.connectedPeers.delete(url);
		});
	}

	/**
	 * Top outbound connections up from the address book: verified addresses first, at random,
	 * so no peer decides whom this node dials. Runs at startup, after PEERS messages and with
	 * the peer broadcast.
	 */
	fillOutbound(): void {
		for (const peer of this._addresses.candidates(Date.now())) {
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
		if (url && this._addresses.remove(this.normalizePeerUrl(url))) this._persistPeers();
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
		if (error instanceof StorageError) {
			log.warn('Could not store a block from a peer:', error.message); // our disk, not the peer's fault
			return;
		}
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
			isDuplicate: false,
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
			caughtUp: false,
			inventoryReceived: false,
			inventory: null,
			announced: new Set(),
			requested: new Set(),
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
			if (url && !state.isSelf && !state.isDuplicate && !this._isClosing) {
				const peer = this.normalizePeerUrl(url);
				this.reconnectToPeer(peer, (this._redials.get(peer) ?? 0) + 1);
			}
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
		return !!state && state.versionReceived && state.verackReceived && !state.isSelf && !state.isDuplicate;
	}

	private _versionPayload(): VersionPayload {
		const tip = this.blockchain.getLatestBlock();
		return {
			magic: this._networkMagic,
			version: PROTOCOL_VERSION,
			genesisHash: this.blockchain.getHeader(0)!.hash,
			height: tip.index,
			tip: tip.hash,
			nonce: this._nonce,
			listenPort: this._externalPort, // what peers dial: P2P_EXTERNAL_PORT, or the port we listen on
		};
	}

	private _send(socket: WebSocket, message: Message): void {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
	}

	/**
	 * Redial a lost outbound peer with capped exponential backoff. The backoff starts over only
	 * after a completed handshake, so a peer that keeps refusing it (another protocol version,
	 * a ban) isn't redialed every second. After MAX_RECONNECT_ATTEMPTS the periodic outbound fill
	 * may still pick it up. Never redials banned peers or beyond the outbound limit.
	 */
	private reconnectToPeer(peer: string, attempt: number = 1): void {
		if (attempt > MAX_RECONNECT_ATTEMPTS) {
			this._redials.delete(peer);
			log.info(`Max reconnection attempts reached for peer: ${peer}`);
			return;
		}
		this._redials.set(peer, attempt);
		const delay = Math.min(RECONNECT_BASE_DELAY * 2 ** (attempt - 1), RECONNECT_MAX_DELAY);
		const timer = setTimeout(() => {
			if (!this._canDial(peer)) {
				this._redials.delete(peer);
				return;
			}
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
		log.debug(`Connected to ${this.normalizePeerUrl(peerAddress)}`);
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
				case MessageType.MEMPOOL: {
					const payload = data.data;
					enqueue(() => Promise.resolve(this._handleMempool(socket, payload))); // after any BLOCKS before it
					break;
				}
				case MessageType.GET_TRANSACTIONS:
					this._handleGetTransactions(socket, data.data);
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
		const dialed = (socket as unknown as { url?: string }).url;
		const address = dialed ? this.normalizePeerUrl(dialed) : undefined;
		// A peer on another network or chain will never be useful: forget its address
		const forget = () => {
			if (address && this._addresses.remove(address)) this._persistPeers();
		};
		if (!isVersionPayload(data)) return reject('malformed VERSION');
		if (data.magic !== this._networkMagic) {
			forget();
			return reject(`different network (${data.magic})`);
		}
		if (data.version !== PROTOCOL_VERSION) {
			if (address) this._addresses.markFailure(address, Date.now());
			return reject(`protocol version ${data.version}`);
		}
		if (data.genesisHash !== this.blockchain.getHeader(0)!.hash) {
			forget();
			return reject('different genesis block');
		}
		if (data.nonce === this._nonce) {
			state.isSelf = true;
			if (address) this._ownAddresses.add(address);
			forget();
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

	/**
	 * Handshake complete: share peers and our pending transactions' txids, and fetch blocks if
	 * the peer has a tip we don't.
	 */
	private _onReady(socket: WebSocket, version: VersionPayload): void {
		const state = this._peerState.get(socket);
		if (state?.handshakeTimer) {
			clearTimeout(state.handshakeTimer);
			state.handshakeTimer = null;
		}
		const dialed = (socket as unknown as { url?: string }).url;
		if (dialed) {
			this._redials.delete(this.normalizePeerUrl(dialed)); // a later loss starts the backoff over
			this._addresses.markSuccess(this.normalizePeerUrl(dialed), Date.now());
			this._persistPeers();
		}
		if (this._dropDuplicate(socket, version.nonce)) return;
		this._sendPeerList(socket);
		this._sendInventory(socket);
		if (!this.blockchain.hasBlock(version.tip)) this._requestBlocks(socket);
		else this._caughtUp(socket);
	}

	/**
	 * Tell a new peer which transactions we have pending (highest fee rates first), so a payment
	 * made while it was away or before it started still reaches it (TASK-0047).
	 */
	private _sendInventory(socket: WebSocket): void {
		const state = this._peerState.get(socket);
		const txids = this.blockchain.getMempoolInventory(MAX_INVENTORY);
		if (!state || txids.length === 0) return;
		state.announced = new Set(txids);
		this._send(socket, { type: MessageType.MEMPOOL, data: { txids } });
	}

	/**
	 * A peer's pending txids: request the ones we lack once we have caught up with its chain
	 * (until then their inputs may be in blocks we don't have yet). One MEMPOOL per connection.
	 */
	private _handleMempool(socket: WebSocket, data: unknown): void {
		const txids = parseTxids(data);
		if (!txids) {
			this._misbehaving(socket, 10, 'malformed MEMPOOL');
			return;
		}
		const state = this._peerState.get(socket);
		if (!state || state.inventoryReceived) return;
		state.inventoryReceived = true;
		if (state.caughtUp) this._requestMissing(socket, txids);
		else state.inventory = txids;
	}

	/** We have the peer's chain: request the announced transactions we don't have. */
	private _caughtUp(socket: WebSocket): void {
		const state = this._peerState.get(socket);
		if (!state || state.caughtUp) return;
		state.caughtUp = true;
		if (state.inventory) this._requestMissing(socket, state.inventory);
		state.inventory = null;
	}

	private _requestMissing(socket: WebSocket, txids: string[]): void {
		const state = this._peerState.get(socket);
		if (!state) return;
		const missing = txids.filter((txid) => !this.blockchain.hasTransaction(txid));
		if (missing.length === 0) return;
		state.requested = new Set(missing);
		this._send(socket, { type: MessageType.GET_TRANSACTIONS, data: { txids: missing } });
	}

	/** Send the requested transactions we announced to this peer and still have, each once. */
	private _handleGetTransactions(socket: WebSocket, data: unknown): void {
		const txids = parseTxids(data);
		if (!txids) {
			this._misbehaving(socket, 10, 'malformed GET_TRANSACTIONS');
			return;
		}
		const state = this._peerState.get(socket);
		if (!state) return;
		for (const txid of txids) {
			if (!state.announced.delete(txid)) continue; // never announced, or already sent
			const pending = this.blockchain.getPendingTransaction(txid);
			if (pending) this._send(socket, { type: MessageType.TRANSACTION, data: pending });
		}
	}

	/** Inbound peers tell us their listen port: remember host:port so others can reach them. */
	private _rememberListenAddress(state: PeerState, listenPort: number): void {
		if (!state.remoteAddress || listenPort === 0) return;
		let host = state.remoteAddress.replace(/^::ffff:/, '');
		if (host.includes(':')) host = `[${host}]`;
		const address = this.normalizePeerUrl(`${host}:${listenPort}`);
		if (!isValidPeerAddress(address) || this._ownAddresses.has(address)) return;
		if (this._addresses.addLearned(address)) this._persistPeers();
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
		const blocks: Block[] = [];
		let malformed: string | undefined;
		for (const raw of payload.blocks) {
			try {
				blocks.push(Block.fromJSON(raw));
			} catch (error) {
				malformed = (error as Error).message;
				break; // the blocks before it are still added
			}
		}
		// One lock and one database transaction for the batch (TASK-0054)
		let accepted = 0;
		let rejected: Error | undefined;
		try {
			if (blocks.length > 0) ({ added: accepted, rejected } = await this.blockchain.addBlocks(blocks));
		} catch (error) {
			this._blockRejected(socket, error as Error); // a storage failure: ours, not the peer's
			return;
		}
		if (accepted > 0) {
			const tip = this.blockchain.getLatestBlock();
			log.info(
				`Synced ${accepted} block(s) from peer: height ${tip.index}, tip ${tip.hash.slice(0, 16)}`,
			);
		}
		if (malformed !== undefined) {
			this._misbehaving(socket, 50, malformed);
			return;
		}
		if (rejected) {
			this._blockRejected(socket, rejected);
			return; // stop at the first bad block; don't ask this peer for more
		}
		const lastHash = blocks.at(-1)?.hash;
		if (payload.more === true && lastHash) {
			this._requestBlocks(socket, lastHash);
			return;
		}
		if (accepted > 0) {
			// Caught up: announce the new tip so peers that lack it can sync from us
			const tip = this.blockchain.getLatestBlock();
			this._markSeen(`b:${tip.hash}`);
			this.broadcast({ type: MessageType.BLOCK, data: tip }, socket);
		}
		this._caughtUp(socket);
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
			const txid = transaction.calculateHash();
			// One we requested is reconsidered even if seen before (e.g. rejected while we were behind)
			const requested = !!from && !!this._peerState.get(from)?.requested.delete(txid);
			if (!this._markSeen(`t:${txid}`) && !requested) return;
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

	/** Known peer addresses, verified and configured ones first. */
	getKnownPeers(): string[] {
		return this._addresses.all();
	}

	/** Startup addresses: operator-given ones (CLI, seeds) and the saved list (learned). */
	loadInitialPeers(configured: string[], learned: string[] = []): void {
		for (const [peers, add] of [
			[configured, (url: string) => this._addresses.addConfigured(url)],
			[learned, (url: string) => void this._addresses.addLearned(url)],
		] as const) {
			for (const peer of peers) {
				const normalized = this.normalizePeerUrl(peer);
				if (isValidPeerAddress(normalized) && !this._ownAddresses.has(normalized) && !this.isBanned(normalized)) {
					add(normalized);
				}
			}
		}
	}

	private _startPeerBroadcast(): void {
		if (this._peerBroadcastInterval) return;
		this._peerBroadcastInterval = setInterval(() => {
			this._broadcastPeerList();
			this.fillOutbound();
		}, PEER_BROADCAST_INTERVAL);
	}

	private _stopPeerBroadcast(): void {
		if (this._peerBroadcastInterval) {
			clearInterval(this._peerBroadcastInterval);
			this._peerBroadcastInterval = null;
		}
	}

	private _broadcastPeerList(): void {
		const peers = this._addresses.shareable(MAX_ADDRESSES_PER_MESSAGE);
		if (peers.length === 0) return;
		this.broadcast({ type: MessageType.PEERS, data: peers });
	}

	private _sendPeerList(socket: WebSocket): void {
		const peers = this._addresses.shareable(MAX_ADDRESSES_PER_MESSAGE);
		if (peers.length === 0) return;
		this._send(socket, { type: MessageType.PEERS, data: peers });
	}

	private _handlePeersMessage(peerAddresses: unknown, from?: WebSocket): void {
		if (!Array.isArray(peerAddresses)) {
			if (from) this._misbehaving(from, 10, 'malformed PEERS');
			return;
		}

		// Learn at most MAX_ADDRESSES_PER_MESSAGE; dialing is left to the random fill, so the
		// sender can't choose our outbound peers
		let learned = 0;
		for (const addr of peerAddresses.slice(0, MAX_ADDRESSES_PER_MESSAGE)) {
			if (typeof addr !== 'string') continue;
			const normalized = this.normalizePeerUrl(addr);
			if (!isValidPeerAddress(normalized) || this._ownAddresses.has(normalized) || this.isBanned(normalized)) continue;
			if (this._addresses.addLearned(normalized)) learned++;
		}
		if (learned > 0) {
			this._persistPeers();
			this.fillOutbound();
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
