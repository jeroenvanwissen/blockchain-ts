// Docker image check (TASK-0043): `npm run docker:check [-- --no-build]`. Builds the image, runs a
// regtest node in a container and checks what an operator relies on:
// - the explorer and chain routes answer the host; wallet routes refuse it
// - the CLI inside the container reaches the wallet routes
// - native secp256k1 and a non-root user; the health check turns healthy
// - docker stop shuts down cleanly; the chain survives a restart, from the chain database
// Uses plain console output (a script, like smoke and e2e).
import { apiUrl as containerApiUrl, build, docker, IMAGE, waitUntil } from './dockerHarness.js';

const NAME = `blockchain-ts-check-${process.pid}`;
const VOLUME = `${NAME}-data`;

function step(message: string): void {
	console.log(`[docker] ${message}`);
}

const apiUrl = () => containerApiUrl(NAME);

async function height(api: string): Promise<number> {
	const res = await fetch(`${api}/status`);
	return ((await res.json()) as { height: number }).height;
}

async function main(): Promise<void> {
	if (!process.argv.includes('--no-build')) {
		step(`build ${IMAGE}`);
		await build();
	}

	step('run a regtest node that mines, its data in a volume');
	await docker(
		'run', '-d', '--name', NAME, '-v', `${VOLUME}:/data`, '-p', '127.0.0.1::6001',
		'--health-interval', '2s', IMAGE, '--regtest', '--mine',
	);
	let api = await apiUrl();
	await waitUntil(async () => (await height(api)) >= 3, 'the node to mine 3 blocks');

	step('the explorer and chain routes answer the host; wallet routes refuse it');
	const page = await fetch(`${api}/`);
	if (!page.ok || !page.headers.get('content-type')?.startsWith('text/html')) throw new Error(`explorer: HTTP ${page.status}`);
	const status = (await (await fetch(`${api}/status`)).json()) as { network: string };
	if (!status.network.endsWith('/regtest')) throw new Error(`unexpected network ${status.network}`);
	const wallet = await fetch(`${api}/wallet`);
	if (wallet.status !== 403) throw new Error(`wallet route answered the host with HTTP ${wallet.status}, not 403`);

	step('the CLI inside the container reaches the wallet routes');
	const balance = await docker('exec', NAME, 'cli', 'balance');
	if (!/^balance: [\d.]+$/m.test(balance) || !/^address: 1\w+$/m.test(balance)) throw new Error(`cli balance: ${balance}`);
	const address = await docker('exec', NAME, 'cli', 'new-address');
	if (!/^1\w{25,34}$/.test(address)) throw new Error(`cli new-address: ${address}`);

	step('native secp256k1, a non-root user, and a healthy health check');
	await docker('exec', NAME, 'node', '-e', "require('/app/node_modules/secp256k1/bindings')");
	const uid = await docker('exec', NAME, 'id', '-u');
	if (uid === '0') throw new Error('the node runs as root');
	await waitUntil(async () => (await docker('inspect', '-f', '{{.State.Health.Status}}', NAME)) === 'healthy', 'healthy');

	step('docker stop: a clean shutdown');
	const stoppedAt = await height(api);
	await docker('stop', '-t', '30', NAME);
	const exitCode = await docker('inspect', '-f', '{{.State.ExitCode}}', NAME);
	const logs = await docker('logs', NAME);
	if (exitCode !== '0' || !logs.includes('Stopping blockchain node')) throw new Error(`unclean stop (exit ${exitCode})`);

	step('docker start: the same chain from the volume, starting from the chain database');
	await docker('start', NAME);
	api = await apiUrl();
	await waitUntil(async () => (await height(api)) >= stoppedAt, `height ${stoppedAt} after the restart`);
	const restarted = (await docker('logs', NAME)).slice(logs.length);
	if (!new RegExp(`chain database at height ${stoppedAt}; validated 0 newer block`).test(restarted)) {
		throw new Error(`the restart didn't start from the chain database at height ${stoppedAt}`);
	}
	if (!(await docker('exec', NAME, 'cli', 'addresses')).includes(address)) throw new Error('the new address is gone');
	const problems = (await docker('logs', NAME)).split('\n').filter((line) => / (ERROR|WARN) /.test(line));
	if (problems.length > 0) throw new Error(`the node logged problems:\n${problems.join('\n')}`);

	step(`PASS: height ${await height(api)}`);
}

let failed = false;
main()
	.catch(async (error: Error) => {
		failed = true;
		console.error(`[docker] FAIL: ${error.message}`);
		console.error((await docker('logs', '--tail', '30', NAME).catch(() => '(no logs)')) || '(no logs)');
	})
	.finally(async () => {
		await docker('rm', '-f', NAME).catch(() => {});
		await docker('volume', 'rm', VOLUME).catch(() => {});
		process.exitCode = failed ? 1 : 0;
	});
