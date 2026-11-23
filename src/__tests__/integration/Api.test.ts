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
import * as path from 'path';
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
			{ wallet: miner, token: TOKEN, broadcast: (tx) => broadcasts.push(tx), staking: { isRunning: () => true, stakedCount: () => 3 } },
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
			unspent: null, // not confirmed yet
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

	it('should show what each input spends, the fee, and which outputs are unspent', async () => {
		const recipient = openWallet(dir, 'recipient');
		const payment = chain.createTransaction(miner.address, recipient.address, COIN, miner);
		await chain.addTransaction(payment);
		await buildBlocks(chain, miner.address, 1);
		const spentTxid = payment.inputs[0].previousTx;

		const { body } = await get(`/transactions/${payment.calculateHash()}`);

		expect(body).toMatchObject({ coinbase: false, coinstake: false, size: payment.size(), fee: minRelayFee(payment.size()).toString() });
		expect((body.inputs as { spent: unknown }[])[0].spent).toEqual({ address: miner.address, amount: POW_BLOCK_REWARD.toString() });
		expect((body.outputs as { unspent: boolean }[]).map((o) => o.unspent)).toEqual([true, true]);
		const spentTx = (await get(`/transactions/${spentTxid}`)).body;
		expect(spentTx).toMatchObject({ coinbase: true, fee: null });
		expect((spentTx.inputs as { spent: unknown }[])[0].spent).toBeNull();
		expect((spentTx.outputs as { unspent: boolean }[])[0].unspent).toBe(false); // the payment spent it
	});

	it('should list block summaries newest first, page by height, and describe a block', async () => {
		const tip = chain.getLatestBlock().index;

		const latest = (await get('/blocks?limit=3')).body as unknown as { height: number; hash: string; producer: string; transactions: number; size: number }[];
		expect(latest.map((b) => b.height)).toEqual([tip, tip - 1, tip - 2]);
		expect(latest[0]).toMatchObject({ hash: chain.getLatestBlock().hash, producer: miner.address, transactions: 1, proofOfStake: false });
		expect(latest[0].size).toBe(chain.getLatestBlock().size());
		expect(((await get('/blocks?before=2&limit=5')).body as unknown as { height: number }[]).map((b) => b.height)).toEqual([1, 0]);
		expect(((await get('/blocks')).body as unknown as unknown[]).length).toBe(Math.min(20, tip + 1));
		for (const query of ['limit=0', 'limit=101', 'limit=x', 'before=-1']) expect((await get(`/blocks?${query}`)).status).toBe(400);

		const block = (await get('/blocks/3')).body;
		expect(block).toMatchObject({ producer: miner.address, nextHash: chain.getChain()[4].hash, size: chain.getChain()[3].size() });
		expect((block.transactions as { txid: string }[])[0].txid).toBe(chain.getChain()[3].transactions[0].calculateHash());
		expect((await get(`/blocks/${tip}`)).body.nextHash).toBeNull();
	});

	it('should serve the block explorer with a strict content security policy', async () => {
		expect((await fetch(`http://127.0.0.1:${api.port()}/`)).status).toBe(404); // no explorerDir
		const explorer = new ApiServer(
			chain,
			{ getPeerInfo: () => [] },
			{ host: '127.0.0.1', port: 0, network: 'x', explorerDir: path.resolve('src/api/explorer') },
		);
		await explorer.listen();
		try {
			const url = (route: string) => `http://127.0.0.1:${explorer.port()}${route}`;
			const page = await fetch(url('/'));
			expect(page.status).toBe(200);
			expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
			expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
			expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
			expect(page.headers.get('x-content-type-options')).toBe('nosniff');
			expect(await page.text()).toContain('/explorer/app.js');
			expect((await fetch(url('/explorer/app.js'))).headers.get('content-type')).toBe('text/javascript; charset=utf-8');
			expect((await fetch(url('/explorer/style.css'))).headers.get('content-type')).toBe('text/css; charset=utf-8');
			for (const route of ['/explorer/index.html', '/explorer/missing.js', '/explorer/../package.json', '/explorer/%2e%2e%2fpackage.json']) {
				expect((await fetch(url(route))).status).toBe(404);
			}
		} finally {
			await explorer.close();
		}
	});

	it('should page an address\'s transactions newest first, with pending ones and totals', async () => {
		const recipient = openWallet(dir, 'recipient');
		for (let i = 0; i < 3; i++) {
			await chain.addTransaction(chain.createTransaction(miner.address, recipient.address, COIN, miner));
			await buildBlocks(chain, miner.address, 1);
		}
		const pending = chain.createTransaction(miner.address, recipient.address, 2n * COIN, miner);
		await chain.addTransaction(pending);
		type Page = { total: number; transactions: { position: number; received: string; balance: string; height: number }[]; pending: unknown[] };

		const first = (await get(`/addresses/${recipient.address}/transactions?limit=2`)).body as unknown as Page;
		expect(first.total).toBe(3);
		expect(first.transactions.map((t) => [t.position, t.received, t.balance])).toEqual([
			[2, COIN.toString(), (3n * COIN).toString()],
			[1, COIN.toString(), (2n * COIN).toString()],
		]);
		expect(first.transactions[0].height).toBe(chain.getLatestBlock().index);
		expect(first.pending).toEqual([{ txid: pending.calculateHash(), received: (2n * COIN).toString(), sent: '0' }]);
		const older = (await get(`/addresses/${recipient.address}/transactions?before=1`)).body as unknown as Page;
		expect(older.transactions.map((t) => t.position)).toEqual([0]);

		const summary = (await get(`/addresses/${recipient.address}`)).body;
		expect(summary).toMatchObject({ transactions: 3, totalReceived: (3n * COIN).toString(), totalSent: '0' });
		const unused = (await get(`/addresses/${openWallet(dir, 'unused').address}/transactions`)).body as unknown as Page;
		expect(unused).toMatchObject({ total: 0, transactions: [], pending: [] });
		for (const query of ['before=-1', 'before=x', 'limit=0', 'limit=101']) {
			expect((await get(`/addresses/${recipient.address}/transactions?${query}`)).status).toBe(400);
		}
		expect((await get('/addresses/nope/transactions')).status).toBe(400);
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
			transactions: 1,
			totalReceived: COIN.toString(),
			totalSent: '0',
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
			const { address, balance, spendable, utxos } = (await get(`/addresses/${miner.address}`)).body;
			expect(wallet.body).toEqual({
				address, // all coins are on the primary address
				balance,
				spendable,
				utxos,
				addresses: 1,
				encrypted: false,
				locked: false,
				stakingOnly: false,
				unlockedUntil: null,
			});
		});

		it('should hand out new addresses and list them with their balances', async () => {
			const auth = { authorization: `Bearer ${TOKEN}` };
			const create = (headers: Record<string, string>) =>
				get('/wallet/addresses', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
			expect((await create({})).status).toBe(401);

			const created = await create(auth);
			expect(created.status).toBe(200);
			const address = created.body.address as string;
			expect(miner.owns(address)).toBe(true);
			await buildBlocks(chain, address, 1); // a reward to the new address

			const list = (await get('/wallet/addresses', { headers: auth })).body as unknown as {
				address: string;
				balance: string;
				index: number | null;
				primary: boolean;
			}[];
			expect(list.map((entry) => [entry.address, entry.index, entry.primary])).toEqual([
				[miner.address, 0, true],
				[address, 1, false],
			]);
			expect(list[1].balance).toBe(POW_BLOCK_REWARD.toString());
			const wallet = (await get('/wallet', { headers: auth })).body;
			expect(wallet.addresses).toBe(2);
			expect(wallet.balance).toBe((BigInt(list[0].balance) + POW_BLOCK_REWARD).toString());
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

		it('should report staking status behind the token', async () => {
			expect((await get('/wallet/staking')).status).toBe(401);
			const { status, body } = await get('/wallet/staking', { headers: { authorization: `Bearer ${TOKEN}` } });

			expect(status).toBe(200);
			expect(body).toEqual({
				enabled: true,
				phase: 'pow', // this chain stays in the PoW phase
				locked: false,
				stakingOnly: false,
				eligibleOutputs: chain.getStakeableUTXOs(miner.addresses(), Date.now()).length,
				eligibleValue: expect.any(String) as string,
				chancePerSlot: 0,
				expectedSeconds: null,
				stakedSinceStart: 3,
				lastStaked: null,
			});
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
