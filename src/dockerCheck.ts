// Docker image check (TASK-0043): `npm run docker:check [-- --no-build]`. Builds the image, runs a
// regtest node in a container and checks what an operator relies on:
// - the explorer and chain routes answer the host; wallet routes refuse it
// - the CLI inside the container reaches the wallet routes
// - native secp256k1 and a non-root user; the health check turns healthy
// - docker stop shuts down cleanly and saves the chainstate; the chain survives a restart
// Uses plain console output (a script, like smoke and e2e).
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const IMAGE = process.env.IMAGE || 'blockchain-ts:check';
const NAME = `blockchain-ts-check-${process.pid}`;
const VOLUME = `${NAME}-data`;
const TIMEOUT_MS = 90_000;

function step(message: string): void {
	console.log(`[docker] ${message}`);
}

async function docker(...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('docker', args, { maxBuffer: 64 * 1024 * 1024 });
	return stdout.trim();
}

/** `docker build`, with its output shown. */
function build(): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', ['build', '-t', IMAGE, '.'], { stdio: 'inherit' });
		child.once('error', reject);
		child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`docker build exited with ${code}`))));
	});
}

async function waitUntil(check: () => Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await check().catch(() => false)) return;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The host URL of the container's API (its published port changes on every start). */
async function apiUrl(): Promise<string> {
	const mapping = (await docker('port', NAME, '6001/tcp')).split('\n')[0]; // "127.0.0.1:49153"
	return `http://127.0.0.1:${mapping.slice(mapping.lastIndexOf(':') + 1)}`;
}

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

	step('docker stop: a clean shutdown that saves the chainstate');
	const stoppedAt = await height(api);
	await docker('stop', '-t', '30', NAME);
	const exitCode = await docker('inspect', '-f', '{{.State.ExitCode}}', NAME);
	const logs = await docker('logs', NAME);
	if (exitCode !== '0' || !logs.includes('Stopping blockchain node')) throw new Error(`unclean stop (exit ${exitCode})`);

	step('docker start: the same chain from the volume, starting from the saved chainstate');
	await docker('start', NAME);
	api = await apiUrl();
	await waitUntil(async () => (await height(api)) >= stoppedAt, `height ${stoppedAt} after the restart`);
	const restarted = (await docker('logs', NAME)).slice(logs.length);
	if (!new RegExp(`chainstate at height ${stoppedAt}; validated 0 newer block`).test(restarted)) {
		throw new Error(`the restart didn't start from the chainstate saved at height ${stoppedAt}`);
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
