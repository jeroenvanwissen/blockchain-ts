import { Mutex } from 'async-mutex';
import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import type { Block } from '../blockchain/Block.js';
import type { Blockchain } from '../blockchain/Blockchain.js';
import type { Transaction, TxOutput } from '../blockchain/Transaction.js';
import { isValidAddress } from '../blockchain/address.js';
import { outpointKey, type UTXO } from '../blockchain/UtxoSet.js';
import { WalletError, type Wallet, type WalletErrorCode } from '../blockchain/Wallet.js';
import { MAX_API_BODY_BYTES, MAX_TRANSACTION_OUTPUTS } from '../config.js';
import type { PeerInfo } from '../networking/P2PServer.js';
import { logger } from '../logger.js';

const log = logger('API');

export interface ApiOptions {
	host: string;
	port: number; // 0: the OS picks a free port (see `port()`)
	network: string; // network id reported by /status
}

/** Where /peers and /status get peer data (the node's P2PServer). */
export interface PeerSource {
	getPeerInfo(): PeerInfo[];
}

/** The node's wallet, for the /wallet routes. Without it those routes are 404. */
export interface WalletAccess {
	wallet: Wallet;
	token: string; // required as `Authorization: Bearer <token>` (the node's api.cookie)
	broadcast(transaction: Transaction): void;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const HEIGHT_PATTERN = /^\d{1,15}$/;
const MAX_ADDRESS_LENGTH = 64; // real addresses are 25 bytes in Base58, about 34 characters
const AMOUNT_PATTERN = /^\d{1,20}$/; // base units as a decimal string

interface Route {
	method: 'GET' | 'POST';
	pattern: RegExp;
	wallet?: boolean; // needs WalletAccess and its token
	handle: (params: string[], body: unknown) => unknown;
}

/**
 * HTTP API over the node's chain state: JSON responses, amounts as decimal strings. Chain
 * routes are public and read-only. /wallet routes act for the node's wallet: they answer only
 * loopback clients (even when API_HOST exposes the API) and require the token from the node's
 * api.cookie as a bearer token; browsers can't send that header cross-origin (no CORS), so
 * web pages can't use them. Input is validated before use (400),
 * unknown items are 404, wrong methods 405.
 */
export class ApiServer {
	private _server: http.Server | null = null;
	private readonly _sendLock = new Mutex(); // one payment at a time: coin selection reads the mempool
	private readonly _routes: Route[] = [
		{ method: 'GET', pattern: /^\/status$/, handle: () => this._status() },
		{ method: 'GET', pattern: /^\/blocks\/([^/]+)$/, handle: ([id]) => this._block(id) },
		{ method: 'GET', pattern: /^\/transactions\/([^/]+)$/, handle: ([txid]) => this._transaction(txid) },
		{ method: 'GET', pattern: /^\/addresses\/([^/]+)$/, handle: ([address]) => this._address(address) },
		{ method: 'GET', pattern: /^\/addresses\/([^/]+)\/utxos$/, handle: ([address]) => this._utxos(address) },
		{ method: 'GET', pattern: /^\/mempool$/, handle: () => this._mempool() },
		{ method: 'GET', pattern: /^\/peers$/, handle: () => this._peers.getPeerInfo() },
		{ method: 'GET', pattern: /^\/wallet$/, wallet: true, handle: () => this._walletInfo() },
		{ method: 'POST', pattern: /^\/wallet\/send$/, wallet: true, handle: (_, body) => this._sendPayment(body) },
		{ method: 'POST', pattern: /^\/wallet\/encrypt$/, wallet: true, handle: (_, body) => this._encrypt(body) },
		{ method: 'POST', pattern: /^\/wallet\/unlock$/, wallet: true, handle: (_, body) => this._unlock(body) },
		{ method: 'POST', pattern: /^\/wallet\/lock$/, wallet: true, handle: () => this._lock() },
	];

	constructor(
		private readonly _blockchain: Blockchain,
		private readonly _peers: PeerSource,
		private readonly _options: ApiOptions,
		private readonly _walletAccess?: WalletAccess,
	) {}

	/** Start serving; resolves once listening, rejects if the port can't be bound. */
	listen(): Promise<void> {
		const server = http.createServer((req, res) => void this._handle(req, res));
		this._server = server;
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(this._options.port, this._options.host, () => {
				server.off('error', reject);
				resolve();
			});
		});
	}

	/** The bound port (differs from the option when it was 0). */
	port(): number {
		return (this._server?.address() as AddressInfo | null)?.port ?? this._options.port;
	}

	async close(): Promise<void> {
		const server = this._server;
		if (!server) return;
		this._server = null;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const headers: Record<string, string> = {};
		try {
			const { pathname } = new URL(req.url ?? '/', 'http://localhost');
			const matching = this._routes.filter((r) => r.pattern.test(pathname));
			if (matching.length === 0) throw new HttpError(404, 'not found');
			const route = matching.find((r) => r.method === req.method);
			if (!route) {
				headers.allow = matching.map((r) => r.method).join(', ');
				throw new HttpError(405, `use ${headers.allow}`);
			}
			if (route.wallet) {
				if (!this._walletAccess) throw new HttpError(404, 'this node has no wallet API');
				// Plain HTTP: the token (and a passphrase) must not cross a network, whatever API_HOST is
				if (!isLoopback(req.socket.remoteAddress)) {
					throw new HttpError(403, 'wallet routes only answer requests from this machine');
				}
				if (!this._isAuthorized(req, this._walletAccess.token)) {
					headers['www-authenticate'] = 'Bearer';
					throw new HttpError(401, 'missing or wrong API token (see api.cookie in the data dir)');
				}
			}
			const body = route.method === 'POST' ? await this._readJson(req) : undefined;
			const params = pathname.match(route.pattern)!.slice(1);
			this._send(res, 200, await route.handle(params, body));
		} catch (error) {
			if (error instanceof HttpError) return this._send(res, error.status, { error: error.message }, headers);
			log.error('request failed:', error);
			this._send(res, 500, { error: 'internal error' });
		}
	}

	private _send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
		const json = JSON.stringify(body);
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'content-length': Buffer.byteLength(json),
			...headers,
		});
		res.end(json);
	}

	/** Constant-time comparison of the bearer token (hashes make the lengths equal). */
	private _isAuthorized(req: http.IncomingMessage, token: string): boolean {
		const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
		if (!match) return false;
		const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
		return crypto.timingSafeEqual(digest(match[1]), digest(token));
	}

	private async _readJson(req: http.IncomingMessage): Promise<unknown> {
		if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) {
			throw new HttpError(415, 'send a JSON body (content-type: application/json)');
		}
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req as AsyncIterable<Buffer>) {
			size += chunk.length;
			if (size > MAX_API_BODY_BYTES) throw new HttpError(413, `body larger than ${MAX_API_BODY_BYTES} bytes`);
			chunks.push(chunk);
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
		} catch {
			throw new HttpError(400, 'body is not valid JSON');
		}
	}

	private _wallet(): Wallet {
		return this._walletAccess!.wallet;
	}

	/**
	 * POST /wallet/send { outputs: [{ address, amount }] }: pay from the node's wallet (plus the
	 * minimum relay fee), admit to the mempool, relay. Returns the txid and fee. Chain-side
	 * rejections (funds, mempool rules) are 422.
	 */
	/** GET /wallet: balances plus the encryption and lock state. */
	private _walletInfo() {
		const wallet = this._wallet();
		const until = wallet.unlockedUntil();
		return {
			...this._address(wallet.address),
			encrypted: wallet.isEncrypted(),
			locked: wallet.isLocked(),
			stakingOnly: wallet.isStakingOnly(),
			unlockedUntil: until === null ? null : new Date(until).toISOString(),
		};
	}

	/** Run a wallet operation, mapping its WalletError codes to responses. */
	private _walletCall<T>(operation: () => T): T {
		try {
			return operation();
		} catch (error) {
			if (error instanceof WalletError) throw new HttpError(WALLET_ERROR_STATUS[error.code], error.message);
			throw error;
		}
	}

	/** POST /wallet/encrypt { passphrase }: encrypt the key at rest; the wallet is locked afterwards. */
	private _encrypt(body: unknown) {
		const passphrase = parsePassphrase(body);
		this._walletCall(() => this._wallet().encrypt(passphrase));
		return this._walletInfo();
	}

	/**
	 * POST /wallet/unlock { passphrase, timeout?, stakingOnly? }: decrypt the key into memory,
	 * for `timeout` seconds (0 or absent: until locked or restarted), optionally for staking only.
	 */
	private _unlock(body: unknown) {
		const passphrase = parsePassphrase(body);
		const options = body as { timeout?: unknown; stakingOnly?: unknown };
		const timeout = options.timeout ?? 0;
		const stakingOnly = options.stakingOnly ?? false;
		if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 0) {
			throw new HttpError(400, 'timeout must be a whole number of seconds (0: no limit)');
		}
		if (typeof stakingOnly !== 'boolean') throw new HttpError(400, 'stakingOnly must be true or false');
		this._walletCall(() => this._wallet().unlock(passphrase, { timeoutMs: timeout * 1000, stakingOnly }));
		log.info(`wallet unlocked${stakingOnly ? ' for staking only' : ''}${timeout ? ` for ${timeout} s` : ''}`);
		return this._walletInfo();
	}

	/** POST /wallet/lock: wipe the key from memory. */
	private _lock() {
		this._walletCall(() => this._wallet().lock());
		log.info('wallet locked');
		return this._walletInfo();
	}

	private async _sendPayment(body: unknown) {
		const payTo = parsePayment(body);
		const wallet = this._wallet();
		if (wallet.isLocked()) throw new HttpError(423, 'wallet is locked: unlock it first (cli unlock)');
		if (wallet.isStakingOnly()) throw new HttpError(423, 'wallet is unlocked for staking only');
		const release = await this._sendLock.acquire();
		try {
			let payment: { transaction: Transaction; fee: bigint };
			try {
				payment = this._blockchain.createPayment(this._wallet(), payTo);
				await this._blockchain.addTransaction(payment.transaction);
			} catch (error) {
				throw new HttpError(422, (error as Error).message);
			}
			this._walletAccess!.broadcast(payment.transaction);
			const txid = payment.transaction.calculateHash();
			log.info(`sent ${txid.slice(0, 16)} from the wallet (fee ${payment.fee})`);
			return { txid, fee: payment.fee.toString() };
		} finally {
			release();
		}
	}

	private _status() {
		const tip = this._blockchain.getLatestBlock();
		return {
			network: this._options.network,
			height: tip.index,
			tip: tip.hash,
			work: this._blockchain.getChainWeight().toString(),
			phase: this._blockchain.isProofOfStakePhase() ? 'pos' : 'pow',
			medianTimePast: this._blockchain.getMedianTimePast(),
			mempool: this._blockchain.getPendingTransactions().length,
			peers: this._peers.getPeerInfo().length,
		};
	}

	private _block(id: string) {
		let found: { block: Block; height: number; isActive: boolean } | undefined;
		if (HEIGHT_PATTERN.test(id)) {
			const block = this._blockchain.getChain()[Number(id)];
			found = block && { block, height: Number(id), isActive: true };
		} else if (HASH_PATTERN.test(id)) {
			found = this._blockchain.getBlockByHash(id);
		} else {
			throw new HttpError(400, 'expected a block height or a 64-character hex hash');
		}
		if (!found) throw new HttpError(404, 'block not found');
		return {
			...found.block.toJSON(),
			proofOfStake: found.block.isProofOfStake(),
			active: found.isActive,
			confirmations: found.isActive ? this._confirmations(found.height) : 0,
		};
	}

	private _transaction(txid: string) {
		if (!HASH_PATTERN.test(txid)) throw new HttpError(400, 'expected a 64-character hex txid');
		const found = this._blockchain.findTransaction(txid);
		if (!found) throw new HttpError(404, 'transaction not found');
		const { transaction, block } = found;
		return {
			txid,
			...transaction.toJSON(),
			block: block?.hash ?? null,
			height: block?.index ?? null,
			confirmations: block ? this._confirmations(block.index) : 0,
		};
	}

	private _address(address: string) {
		this._checkAddress(address);
		const utxos = this._blockchain.getUTXOs(address);
		return {
			address,
			balance: sum(utxos).toString(),
			spendable: sum(this._blockchain.getSpendableUTXOs(address)).toString(),
			utxos: utxos.length,
		};
	}

	private _utxos(address: string) {
		this._checkAddress(address);
		const spendable = new Set(
			this._blockchain.getSpendableUTXOs(address).map((u) => outpointKey(u.txHash, u.outputIndex)),
		);
		return this._blockchain.getUTXOs(address).map((utxo) => ({
			txid: utxo.txHash,
			outputIndex: utxo.outputIndex,
			amount: utxo.output.amount.toString(),
			height: utxo.blockIndex,
			confirmations: this._confirmations(utxo.blockIndex),
			coinbase: utxo.isCoinbase,
			coinstake: utxo.isCoinstake,
			spendable: spendable.has(outpointKey(utxo.txHash, utxo.outputIndex)),
		}));
	}

	private _mempool() {
		const txids = this._blockchain.getPendingTransactions().map((tx) => tx.calculateHash());
		return { size: txids.length, bytes: this._blockchain.getMempoolBytes(), txids };
	}

	private _checkAddress(address: string): void {
		// Length check first: Base58 decoding is quadratic in the input length
		if (address.length > MAX_ADDRESS_LENGTH || !isValidAddress(address)) {
			throw new HttpError(400, 'invalid address');
		}
	}

	private _confirmations(height: number): number {
		return this._blockchain.getLatestBlock().index - height + 1;
	}
}

/** 127.0.0.0/8 and ::1, including IPv4-mapped IPv6 forms. */
export function isLoopback(address: string | undefined): boolean {
	if (!address) return false;
	const ip = address.replace(/^::ffff:/i, '');
	return ip === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

/** HTTP status for each wallet state error. */
const WALLET_ERROR_STATUS: Record<WalletErrorCode, number> = {
	locked: 423,
	'staking-only': 423,
	'not-encrypted': 409,
	'already-encrypted': 409,
	'wrong-passphrase': 403,
	'weak-passphrase': 400,
};

function parsePassphrase(body: unknown): string {
	const passphrase = (body as { passphrase?: unknown } | null)?.passphrase;
	if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > 1024) {
		throw new HttpError(400, 'expected { passphrase } (1 to 1024 characters)');
	}
	return passphrase;
}

/** Validate a /wallet/send body (400 on anything malformed). */
function parsePayment(body: unknown): TxOutput[] {
	const outputs = (body as { outputs?: unknown } | null)?.outputs;
	const maxRecipients = MAX_TRANSACTION_OUTPUTS - 1;
	if (!Array.isArray(outputs) || outputs.length === 0 || outputs.length > maxRecipients) {
		throw new HttpError(400, `expected { outputs: [{ address, amount }] } with 1 to ${maxRecipients} outputs`);
	}
	return outputs.map((output: unknown, i) => {
		const { address, amount } = (output ?? {}) as { address?: unknown; amount?: unknown };
		if (typeof address !== 'string' || address.length > MAX_ADDRESS_LENGTH || !isValidAddress(address)) {
			throw new HttpError(400, `output ${i}: invalid address`);
		}
		if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount) || BigInt(amount) === 0n) {
			throw new HttpError(400, `output ${i}: amount must be a positive decimal string of base units`);
		}
		return { address, amount: BigInt(amount) };
	});
}

function sum(utxos: UTXO[]): bigint {
	return utxos.reduce((total, utxo) => total + utxo.output.amount, 0n);
}
