import * as http from 'http';
import type { AddressInfo } from 'net';
import type { Block } from '../blockchain/Block.js';
import type { Blockchain } from '../blockchain/Blockchain.js';
import { isValidAddress } from '../blockchain/address.js';
import { outpointKey, type UTXO } from '../blockchain/UtxoSet.js';
import type { PeerInfo } from '../networking/P2PServer.js';

export interface ApiOptions {
	host: string;
	port: number; // 0: the OS picks a free port (see `port()`)
	network: string; // network id reported by /status
}

/** Where /peers and /status get peer data (the node's P2PServer). */
export interface PeerSource {
	getPeerInfo(): PeerInfo[];
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

interface Route {
	pattern: RegExp;
	handle: (params: string[]) => unknown;
}

/**
 * Read-only HTTP API over the node's chain state: GET only, JSON responses, amounts as decimal
 * strings. Path parameters are validated before use (400), unknown items are 404.
 */
export class ApiServer {
	private _server: http.Server | null = null;
	private readonly _routes: Route[] = [
		{ pattern: /^\/status$/, handle: () => this._status() },
		{ pattern: /^\/blocks\/([^/]+)$/, handle: ([id]) => this._block(id) },
		{ pattern: /^\/transactions\/([^/]+)$/, handle: ([txid]) => this._transaction(txid) },
		{ pattern: /^\/addresses\/([^/]+)$/, handle: ([address]) => this._address(address) },
		{ pattern: /^\/addresses\/([^/]+)\/utxos$/, handle: ([address]) => this._utxos(address) },
		{ pattern: /^\/mempool$/, handle: () => this._mempool() },
		{ pattern: /^\/peers$/, handle: () => this._peers.getPeerInfo() },
	];

	constructor(
		private readonly _blockchain: Blockchain,
		private readonly _peers: PeerSource,
		private readonly _options: ApiOptions,
	) {}

	/** Start serving; resolves once listening, rejects if the port can't be bound. */
	listen(): Promise<void> {
		const server = http.createServer((req, res) => this._handle(req, res));
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

	private _handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		try {
			if (req.method !== 'GET') throw new HttpError(405, 'only GET is supported');
			const { pathname } = new URL(req.url ?? '/', 'http://localhost');
			for (const route of this._routes) {
				const match = pathname.match(route.pattern);
				if (match) return this._send(res, 200, route.handle(match.slice(1)));
			}
			throw new HttpError(404, 'not found');
		} catch (error) {
			if (error instanceof HttpError) return this._send(res, error.status, { error: error.message });
			console.error('[API] request failed:', error);
			this._send(res, 500, { error: 'internal error' });
		}
	}

	private _send(res: http.ServerResponse, status: number, body: unknown): void {
		const json = JSON.stringify(body);
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'content-length': Buffer.byteLength(json),
			...(status === 405 ? { allow: 'GET' } : {}),
		});
		res.end(json);
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
		return { size: txids.length, txids };
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

function sum(utxos: UTXO[]): bigint {
	return utxos.reduce((total, utxo) => total + utxo.output.amount, 0n);
}
