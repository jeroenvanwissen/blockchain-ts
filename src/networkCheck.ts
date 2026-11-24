// Network check (TASK-0050): `npm run network:check [-- --no-build]`. Runs three regtest nodes as
// three machines: Docker containers on a network of their own, each with its own IP address and
// hostname, configured the way an operator would (SEED_NODES). A mines and stakes; B knows only A;
// C knows only B. Checks:
// - C finds A through B's PEERS and connects to it, without being told about A
// - all three agree on the tip, and a payment from A to a new address of C confirms at C
// - C, recreated without seed nodes but with its data volume, rejoins from its peers.json
// - no node logs a warning, an error or a misbehaving peer
// Uses plain console output (a script, like smoke and e2e).
import { apiUrl, build, docker, getJson, IMAGE, waitUntil } from './dockerHarness.js';

const PREFIX = `blockchain-ts-net-${process.pid}`;
const NETWORK = PREFIX;
const VOLUME_C = `${PREFIX}-c-data`;
const container = (host: string) => `${PREFIX}-${host}`;

function step(message: string): void {
	console.log(`[network] ${message}`);
}

/** Start `host` on the network, its API published on a free loopback port of this machine. */
async function startNode(host: string, env: Record<string, string>, args: string[], volume?: string): Promise<void> {
	await docker(
		'run', '-d', '--name', container(host), '--hostname', host, '--network', NETWORK, '--network-alias', host,
		...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
		...(volume ? ['-v', `${volume}:/data`] : []),
		'-p', '127.0.0.1::6001', IMAGE, '--regtest', ...args,
	);
}

interface Status {
	height: number;
	tip: string;
}

async function tips(apis: string[]): Promise<string[]> {
	return Promise.all(apis.map(async (api) => (await getJson<Status>(api, '/status')).tip));
}

async function main(): Promise<void> {
	if (!process.argv.includes('--no-build')) {
		step(`build ${IMAGE}`);
		await build();
	}
	await docker('network', 'create', NETWORK);

	step('start A (mines and stakes), B (seed node: A) and C (seed node: B), each its own machine');
	await startNode('a', {}, ['--mine', '--stake']);
	await startNode('b', { SEED_NODES: 'ws://a:5001' }, ['--stake']);
	await startNode('c', { SEED_NODES: 'ws://b:5001' }, [], VOLUME_C);
	const [apiA, apiB] = [await apiUrl(container('a')), await apiUrl(container('b'))];
	let apiC = await apiUrl(container('c'));
	const ipA = await docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`, container('a'));

	step(`C learns A's address from B and connects to it (A is ${ipA}; C was only told about B)`);
	const reachesA = async (api: string) => {
		const peers = await getJson<{ address: string }[]>(api, '/peers');
		return peers.some(({ address }) => address.startsWith('ws://a:') || address.includes(ipA));
	};
	await waitUntil(() => reachesA(apiC), 'C to connect to A', 120_000);

	step('all three agree on the tip');
	await waitUntil(async () => new Set(await tips([apiA, apiB, apiC])).size === 1, 'the tips to agree');

	step("A pays a new address of C with the CLI; the payment confirms at C");
	await waitUntil(async () => {
		const { spendable } = await getJson<{ spendable: string }>(apiA, `/addresses/${(await docker('exec', container('a'), 'cli', 'balance')).match(/^address: (\w+)$/m)![1]}`);
		return BigInt(spendable) >= 200_000_000n;
	}, "A's coins to mature");
	const addressC = await docker('exec', container('c'), 'cli', 'new-address');
	const txid = await docker('exec', container('a'), 'cli', 'send', addressC, '1.5');
	await waitUntil(async () => (await getJson<{ confirmations: number }>(apiC, `/transactions/${txid}`)).confirmations >= 1, 'the payment to confirm at C');
	const balanceC = await getJson<{ balance: string }>(apiC, `/addresses/${addressC}`);
	if (balanceC.balance !== '150000000') throw new Error(`C's new address holds ${balanceC.balance}, not 1.5 coins`);

	step('C, recreated without seed nodes from its data volume, rejoins from its peers.json');
	const known = await docker('exec', container('c'), 'cat', '/data/peers.json');
	await docker('rm', '-f', container('c'));
	await startNode('c', {}, [], VOLUME_C);
	apiC = await apiUrl(container('c'));
	await waitUntil(async () => (await getJson<unknown[]>(apiC, '/peers')).length > 0, 'C to reconnect');
	await waitUntil(async () => new Set(await tips([apiA, apiC])).size === 1, "C to follow A's tip again");

	step('no node logged a warning, an error or a misbehaving peer');
	for (const host of ['a', 'b', 'c']) {
		const problems = (await docker('logs', container(host))).split('\n').filter((line) => / (ERROR|WARN) |misbehaving|Banning/.test(line));
		if (problems.length > 0) throw new Error(`${host} logged problems:\n${problems.join('\n')}`);
	}

	const { height } = await getJson<Status>(apiA, '/status');
	step(`PASS: height ${height}; C's saved peers: ${known}`);
}

let failed = false;
main()
	.catch(async (error: Error) => {
		failed = true;
		console.error(`[network] FAIL: ${error.message}`);
		for (const host of ['a', 'b', 'c']) {
			console.error(`\n----- ${host} -----`);
			console.error((await docker('logs', '--tail', '20', container(host)).catch(() => '(no logs)')) || '(no logs)');
		}
	})
	.finally(async () => {
		await docker('rm', '-f', container('a'), container('b'), container('c')).catch(() => {});
		await docker('network', 'rm', NETWORK).catch(() => {});
		await docker('volume', 'rm', VOLUME_C).catch(() => {});
		process.exitCode = failed ? 1 : 0;
	});
