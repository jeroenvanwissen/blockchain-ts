// HTTP API (TASK-0016, wallet routes TASK-0017) against a real chain over real HTTP. Difficulty
// validation is off so blocks build instantly; real timers (fetch needs them).
import { ApiServer, isLoopback } from '../../api/ApiServer.js';
import { Block } from '../../blockchain/Block.js';
import type { Blockchain } from '../../blockchain/Blockchain.js';
import { Transaction } from '../../blockchain/Transaction.js';
import { minRelayFee } from '../../blockchain/fees.js';
import type { Wallet } from '../../blockchain/Wallet.js';
import { COIN, COIN_MATURITY, POW_BLOCK_REWARD } from '../../config.js';
import type { PeerInfo } from '../../networking/P2PServer.js';
import { makeTempDir, openChain, openWallet, removeTempDir } from './helpers.js';

const OPTIONS = { validateDifficulty: false, powCutoffBlock: 1000 };
const SPACING = 30_000;

/** Append `count` blocks (with the mempool) 30 s apart, never dated before now (transactions are). */
async function buildBlocks(chain: Blockchain, miner: string, count: number): Promise<void> {
	for (let i = 0; i < count; i++) {
		const block = chain.createBlockTemplate(miner, Math.max(chain.getLatestBlock().timestamp + SPACING, Date.now()));
		block.solve();
		await chain.addMinedBlock(block);
	}
}

describe('HTTP API', () => {
	let dir: string;
	let chain: Blockchain;
	let miner: Wallet;
	let api: ApiServer;
	let peers: PeerInfo[];
	let broadcasts: Transaction[];
	const TOKEN = 'test-token';

	async function get(path: string, init?: RequestInit) {
		const res = await fetch(`http://127.0.0.1:${api.port()}${path}`, init);
		return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
	}

	function send(body: unknown, headers: Record<string, string> = {}) {
		return get('/wallet/send', {
			method: 'POST',
			headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
			body: typeof body === 'string' ? body : JSON.stringify(body),
		});
	}

	beforeEach(async () => {
		jest.spyOn(console, 'log').mockImplementation(() => {});
		dir = makeTempDir();
		chain = openChain(dir, OPTIONS);
		miner = openWallet(dir, 'miner');
		await buildBlocks(chain, miner.address, COIN_MATURITY + 2);
		peers = [];
		broadcasts = [];
		api = new ApiServer(
			chain,
			{ getPeerInfo: () => peers },
			{ host: '127.0.0.1', port: 0, network: 'test-net' },
			{ wallet: miner, token: TOKEN, broadcast: (tx) => broadcasts.push(tx) },
		);
		await api.listen();
	});

	afterEach(async () => {
		await api.close();
		removeTempDir(dir);
		jest.restoreAllMocks();
	});

	it('should report the chain status', async () => {
		peers.push({ address: 'ws://127.0.0.1:5002', inbound: false, startHeight: 3 });

		const { status, body } = await get('/status');

		expect(status).toBe(200);
		expect(body).toEqual({
			network: 'test-net',
			height: COIN_MATURITY + 2,
			tip: chain.getLatestBlock().hash,
			work: chain.getChainWeight().toString(),
			phase: 'pow',
			medianTimePast: chain.getMedianTimePast(),
			mempool: 0,
			peers: 1,
		});
		expect((await get('/peers')).body).toEqual(peers);
	});

	it('should return a block by height or hash, including side branches', async () => {
		const block = chain.getChain()[3];

		const byHeight = await get('/blocks/3');
		const byHash = await get(`/blocks/${block.hash}`);

		expect(byHeight.body).toEqual(byHash.body);
		expect(byHeight.body).toMatchObject({
			hash: block.hash,
			index: 3,
			proofOfStake: false,
			active: true,
			confirmations: COIN_MATURITY + 2 - 3 + 1,
		});
		const [coinbase] = byHeight.body.transactions as { outputs: { amount: string }[] }[];
		expect(coinbase.outputs[0].amount).toBe(POW_BLOCK_REWARD.toString()); // decimal string

		// A block on the tip's grandparent with the same bits as the block it competes with:
		// less work than the tip, so it stays a side branch
		const branch = chain.getChain().slice(0, -2);
		const parent = branch[branch.length - 1];
		const timestamp = parent.timestamp + SPACING + 1;
		const side = new Block(
			timestamp,
			[Transaction.coinbase(miner.address, POW_BLOCK_REWARD, branch.length, timestamp)],
			parent.hash,
			0,
			chain.getChain()[branch.length].bits,
			branch.length,
		);
		side.solve();
		await expect(chain.addMinedBlock(side)).resolves.toBe('side');
		expect((await get(`/blocks/${side.hash}`)).body).toMatchObject({ active: false, confirmations: 0 });
	});

	it('should return a transaction from the mempool and then from its block', async () => {
		const recipient = openWallet(dir, 'recipient');
		const payment = chain.createTransaction(miner.address, recipient.address, COIN, miner);
		await chain.addTransaction(payment);
		const txid = payment.calculateHash();

		const pending = await get(`/transactions/${txid}`);
		expect(pending.body).toMatchObject({ txid, block: null, height: null, confirmations: 0 });
		expect((pending.body.outputs as { amount: string }[])[0]).toEqual({
			address: recipient.address,
			amount: COIN.toString(),
		});
		expect((await get('/mempool')).body).toEqual({ size: 1, bytes: payment.size(), txids: [txid] });

		await buildBlocks(chain, miner.address, 1);

		const confirmed = await get(`/transactions/${txid}`);
		expect(confirmed.body).toMatchObject({
			txid,
			block: chain.getLatestBlock().hash,
			height: chain.getLatestBlock().index,
			confirmations: 1,
		});
		expect((await get('/mempool')).body).toEqual({ size: 0, bytes: 0, txids: [] });
	});

	it('should report balances and outputs, separating immature coinbases', async () => {
		const recipient = openWallet(dir, 'recipient');
		await chain.addTransaction(chain.createTransaction(miner.address, recipient.address, COIN, miner));
		await buildBlocks(chain, miner.address, 1);

		expect((await get(`/addresses/${recipient.address}`)).body).toEqual({
			address: recipient.address,
			balance: COIN.toString(),
			spendable: COIN.toString(),
			utxos: 1,
		});

		const summary = (await get(`/addresses/${miner.address}`)).body;
		const utxos = (await get(`/addresses/${miner.address}/utxos`)).body as unknown as {
			amount: string;
			coinbase: boolean;
			spendable: boolean;
			confirmations: number;
		}[];
		const total = (filter: (u: (typeof utxos)[number]) => boolean) =>
			utxos.filter(filter).reduce((sum, u) => sum + BigInt(u.amount), 0n).toString();
		expect(summary.utxos).toBe(utxos.length);
		expect(summary.balance).toBe(total(() => true));
		expect(summary.spendable).toBe(total((u) => u.spendable));
		// The newest coinbases haven't matured (spendable from COIN_MATURITY confirmations)
		const immature = utxos.filter((u) => u.coinbase && u.confirmations < COIN_MATURITY);
		expect(immature.length).toBeGreaterThan(0);
		expect(immature.every((u) => !u.spendable)).toBe(true);
	});

	it('should reject listen() when the port is taken, so the node can carry on without it', async () => {
		const second = new ApiServer(chain, { getPeerInfo: () => [] }, { host: '127.0.0.1', port: api.port(), network: 'x' });

		await expect(second.listen()).rejects.toThrow('EADDRINUSE');
		await second.close();
		expect((await get('/status')).status).toBe(200); // the first one still serves
	});

	it('should reject malformed input, unknown items and other methods', async () => {
		const unknownHash = 'ab'.repeat(32);
		const cases: [string, number][] = [
			['/blocks/xyz', 400],
			['/blocks/-1', 400],
			[`/blocks/${unknownHash}`, 404],
			['/blocks/999999', 404],
			['/transactions/1234', 400],
			[`/transactions/${unknownHash}`, 404],
			['/addresses/not-an-address', 400],
			[`/addresses/${'1'.repeat(5000)}`, 400],
			['/nope', 404],
		];
		for (const [path, expected] of cases) {
			const { status, body } = await get(path);
			expect({ path, status }).toEqual({ path, status: expected });
			expect(typeof body.error).toBe('string');
		}

		const post = await get('/status', { method: 'POST' });
		expect(post.status).toBe(405);
		expect(post.headers.get('allow')).toBe('GET');
	});

	describe('wallet routes', () => {
		it('should require the API token', async () => {
			const missing = await get('/wallet');
			expect(missing.status).toBe(401);
			expect(missing.headers.get('www-authenticate')).toBe('Bearer');
			expect((await get('/wallet', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
			expect((await send({ outputs: [] }, { authorization: '' })).status).toBe(401);

			const wallet = await get('/wallet', { headers: { authorization: `Bearer ${TOKEN}` } });
			expect(wallet.status).toBe(200);
			expect(wallet.body).toEqual({
				...(await get(`/addresses/${miner.address}`)).body,
				encrypted: false,
				locked: false,
				stakingOnly: false,
				unlockedUntil: null,
			});
		});

		it('should pay several outputs with change back to the wallet, and relay the payment', async () => {
			const [r1, r2] = [openWallet(dir, 'r1'), openWallet(dir, 'r2')];

			const { status, body } = await send({
				outputs: [
					{ address: r1.address, amount: COIN.toString() },
					{ address: r2.address, amount: (2n * COIN).toString() },
				],
			});

			expect(status).toBe(200);
			const txid = body.txid as string;
			expect(chain.getPendingTransactions().map((tx) => tx.calculateHash())).toEqual([txid]);
			expect(broadcasts.map((tx) => tx.calculateHash())).toEqual([txid]);
			const [payment] = broadcasts;
			expect(payment.outputs.slice(0, 2)).toEqual([
				{ address: r1.address, amount: COIN },
				{ address: r2.address, amount: 2n * COIN },
			]);
			// The minimum relay fee for its size, reported and left out of the change
			const fee = minRelayFee(payment.size());
			expect(body.fee).toBe(fee.toString());
			const inputTotal = POW_BLOCK_REWARD * BigInt(payment.inputs.length);
			expect(payment.outputs[2]).toEqual({ address: miner.address, amount: inputTotal - 3n * COIN - fee });

			// The next block's coinbase claims the fee
			await buildBlocks(chain, miner.address, 1);
			expect(chain.getBalance(r2.address)).toBe(2n * COIN);
			expect(chain.getLatestBlock().transactions[0].outputs[0].amount).toBe(POW_BLOCK_REWARD + fee);
		});

		it('should reject malformed payments (400) and unaffordable ones (422)', async () => {
			const to = openWallet(dir, 'to').address;
			const cases: [unknown, number, string][] = [
				['{not json', 400, 'not valid JSON'],
				[{}, 400, 'expected { outputs'],
				[{ outputs: [] }, 400, 'expected { outputs'],
				[{ outputs: [{ address: 'nope', amount: '1' }] }, 400, 'output 0: invalid address'],
				[{ outputs: [{ address: to, amount: '1.5' }] }, 400, 'output 0: amount'],
				[{ outputs: [{ address: to, amount: '0' }] }, 400, 'output 0: amount'],
				[{ outputs: [{ address: to, amount: 5 }] }, 400, 'output 0: amount'],
				[{ outputs: [{ address: to, amount: (1000n * COIN).toString() }] }, 422, 'Insufficient funds'],
			];
			for (const [body, status, error] of cases) {
				const res = await send(body);
				expect({ body, status: res.status }).toEqual({ body, status });
				expect(res.body.error).toContain(error);
			}
			expect((await send({ outputs: [] }, { 'content-type': 'text/plain' })).status).toBe(415);
			expect(chain.getPendingTransactions()).toHaveLength(0);
			expect(broadcasts).toHaveLength(0);
		});

		it('should encrypt, unlock and lock the wallet, and refuse payments while locked or staking-only', async () => {
			const post = (route: string, body: unknown) =>
				get(route, {
					method: 'POST',
					headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
					body: JSON.stringify(body),
				});
			const payment = { outputs: [{ address: openWallet(dir, 'to').address, amount: COIN.toString() }] };
			const passphrase = 'correct horse battery';

			expect((await post('/wallet/lock', {})).status).toBe(409); // not encrypted yet
			expect((await post('/wallet/encrypt', { passphrase: 'short' })).status).toBe(400);
			const encrypted = await post('/wallet/encrypt', { passphrase });
			expect(encrypted.body).toMatchObject({ address: miner.address, encrypted: true, locked: true });
			expect((await post('/wallet/encrypt', { passphrase })).status).toBe(409);

			expect((await send(payment)).status).toBe(423);
			expect((await post('/wallet/unlock', { passphrase: 'wrong passphrase' })).status).toBe(403);
			expect((await post('/wallet/unlock', { passphrase, timeout: -1 })).status).toBe(400);

			const stakingOnly = await post('/wallet/unlock', { passphrase, stakingOnly: true });
			expect(stakingOnly.body).toMatchObject({ locked: false, stakingOnly: true, unlockedUntil: null });
			const refused = await send(payment);
			expect(refused.status).toBe(423);
			expect(refused.body.error).toContain('staking only');

			const unlocked = await post('/wallet/unlock', { passphrase, timeout: 60 });
			expect(unlocked.body).toMatchObject({ locked: false, stakingOnly: false });
			expect(typeof unlocked.body.unlockedUntil).toBe('string');
			expect((await send(payment)).status).toBe(200);

			expect((await post('/wallet/lock', {})).body).toMatchObject({ locked: true });
			expect((await send(payment)).status).toBe(423);

			// Change the passphrase: wrong current 403, weak new 400, then only the new one unlocks
			expect((await post('/wallet/passphrase', { passphrase: 'nope nope nope', newPassphrase: 'fresh passphrase' })).status).toBe(403);
			expect((await post('/wallet/passphrase', { passphrase, newPassphrase: 'short' })).status).toBe(400);
			expect((await post('/wallet/passphrase', { passphrase })).status).toBe(400);
			expect((await post('/wallet/passphrase', { passphrase, newPassphrase: 'fresh passphrase' })).status).toBe(200);
			expect((await post('/wallet/unlock', { passphrase })).status).toBe(403);
			expect((await post('/wallet/unlock', { passphrase: 'fresh passphrase' })).status).toBe(200);
		});

		it('should refuse wallet routes to clients on other machines, even with the token', async () => {
			// What a request from 10.0.0.5 looks like to the handler when API_HOST exposes the API
			const remote = async (url: string) => {
				let status = 0;
				const res = { writeHead: (code: number) => (status = code), end: () => {} };
				const req = { method: 'GET', url, headers: { authorization: `Bearer ${TOKEN}` }, socket: { remoteAddress: '10.0.0.5' } };
				await api['_handle'](req as never, res as never);
				return status;
			};

			expect(await remote('/wallet')).toBe(403);
			expect(await remote('/status')).toBe(200); // chain routes stay public
		});

		it('should treat only 127.0.0.0/8 and ::1 as loopback', () => {
			for (const address of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) expect(isLoopback(address)).toBe(true);
			for (const address of ['10.0.0.5', '::ffff:10.0.0.5', '192.168.1.2', 'fe80::1', '127.0.0.1.example', undefined]) {
				expect(isLoopback(address)).toBe(false);
			}
		});

		it('should answer 405 for the wrong method and 404 on a node without wallet access', async () => {
			const wrongMethod = await get('/wallet/send', { headers: { authorization: `Bearer ${TOKEN}` } });
			expect(wrongMethod.status).toBe(405);
			expect(wrongMethod.headers.get('allow')).toBe('POST');

			const plain = new ApiServer(chain, { getPeerInfo: () => [] }, { host: '127.0.0.1', port: 0, network: 'x' });
			await plain.listen();
			try {
				const res = await fetch(`http://127.0.0.1:${plain.port()}/wallet`);
				expect(res.status).toBe(404);
			} finally {
				await plain.close();
			}
		});
	});
});
