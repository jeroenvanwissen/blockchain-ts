// Smoke check against the real runtime (native ESM, real filesystem, real protobuf).
// From an unrelated working directory and temp data dirs: node A mines, node B syncs from it
// and accepts A's next block live, then A restarts and keeps its chain. A fresh chain mines
// quickly until the retarget catches up, so heights are read from the logs, not assumed.
// Run with `npm run smoke`; --keep keeps the temp dir.
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const READY = /P2P Server listening/;
const TIMEOUT_MS = 30_000;
const NEXT_BLOCK_TIMEOUT_MS = 120_000; // up to a few target spacings once the retarget settles
const SELF = fileURLToPath(import.meta.url);
// index.ts under tsx, index.js when run from dist/
const ENTRY = path.join(path.dirname(SELF), `index${path.extname(SELF)}`);
const TSX_LOADER = import.meta.resolve('tsx');

interface NodeProcess {
	name: string;
	child: ChildProcess;
	output: () => string;
	exited: Promise<number | null>;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

function startNode(
	name: string,
	cwd: string,
	dataDir: string,
	port: number,
	extraArgs: string[] = [],
): NodeProcess {
	const args = ['--import', TSX_LOADER, ENTRY, '--data-dir', dataDir, ...extraArgs];
	const child = spawn(process.execPath, args, {
		cwd,
		env: { ...process.env, P2P_PORT: String(port), SEED_NODES: '' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let buffer = '';
	child.stdout?.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
	child.stderr?.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
	const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
	return { name, child, output: () => buffer, exited };
}

async function waitFor(
	node: NodeProcess,
	pattern: RegExp,
	what: string,
	timeoutMs = TIMEOUT_MS,
): Promise<RegExpMatchArray> {
	const deadline = Date.now() + timeoutMs;
	let hasExited = false;
	void node.exited.then(() => (hasExited = true));
	while (Date.now() < deadline) {
		const match = node.output().match(pattern);
		if (match) return match;
		if (hasExited) throw new Error(`${node.name} exited before ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`${node.name}: timed out waiting for ${what}`);
}

async function stopNode(node: NodeProcess): Promise<void> {
	if (node.child.exitCode !== null || node.child.signalCode !== null) return;
	node.child.kill('SIGINT');
	const timer = setTimeout(() => node.child.kill('SIGKILL'), 5_000);
	await node.exited;
	clearTimeout(timer);
}

function assertFile(file: string): void {
	if (!fs.existsSync(file)) throw new Error(`expected file missing: ${file}`);
}

function walletAddress(node: NodeProcess): string {
	const match = node.output().match(/Wallet initialized with address: (\S+)/);
	if (!match) throw new Error(`${node.name}: wallet address not logged`);
	return match[1];
}

function noLoadErrors(node: NodeProcess): void {
	if (/Error loading blockchain|Failed to load blockchain|\[Wallet\] /.test(node.output())) {
		throw new Error(`${node.name}: logged a load error`);
	}
}

/** The node logged that it mined this exact block. */
function assertMined(node: NodeProcess, height: string, hashPrefix: string): void {
	if (!node.output().includes(`mined block ${height} (${hashPrefix})`)) {
		throw new Error(`${node.name} did not mine block ${height} (${hashPrefix})`);
	}
}

function noErrors(node: NodeProcess): void {
	const line = node.output().split('\n').find((l) => /Error|rejected/.test(l));
	if (line) throw new Error(`${node.name}: logged an error: ${line.trim()}`);
}

async function main(): Promise<void> {
	const keep = process.argv.includes('--keep');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blockchain-ts-smoke-'));
	const cwd = path.join(root, 'cwd'); // deliberately not the repository root
	const dataA = path.join(root, 'node-a');
	const dataB = path.join(root, 'node-b');
	fs.mkdirSync(cwd);
	const [portA, portB] = [await freePort(), await freePort()];
	const running: NodeProcess[] = [];
	const step = (message: string) => console.log(`[smoke] ${message}`);

	try {
		step(`start mining node A on port ${portA} (data dir ${dataA}, cwd ${cwd})`);
		let nodeA = startNode('node A', cwd, dataA, portA, ['--mine']);
		running.push(nodeA);
		await waitFor(nodeA, READY, 'listening');
		noLoadErrors(nodeA);
		const address = walletAddress(nodeA);
		await waitFor(nodeA, /mined block 1 \(/, 'mining block 1');
		assertFile(path.join(dataA, 'wallet.dat'));
		assertFile(path.join(dataA, 'blocks', 'index.dat'));
		assertFile(path.join(dataA, 'blocks', 'blk00000.dat'));
		if (fs.existsSync(path.join(cwd, 'data'))) throw new Error('node wrote data into its cwd');

		step(`start node B on port ${portB} with --peers ws://127.0.0.1:${portA}; expect sync`);
		const nodeB = startNode('node B', cwd, dataB, portB, ['--peers', `ws://127.0.0.1:${portA}`]);
		running.push(nodeB);
		await waitFor(nodeB, READY, 'listening');
		await waitFor(nodeB, /Successfully connected to peer/, 'connecting to node A');
		const [, syncedHeight, syncedTip] = await waitFor(
			nodeB,
			/Synced chain from peer: height (\d+), tip (\w+)/,
			'sync',
		);
		assertMined(nodeA, syncedHeight, syncedTip);
		noLoadErrors(nodeB);

		step(`node B synced to height ${syncedHeight}; wait for it to accept a newer block live`);
		const [, relayedHeight, relayedHash] = await waitFor(
			nodeB,
			new RegExp(`Accepted block (\\d+) \\((\\w+)\\) from peer`),
			'relay',
			NEXT_BLOCK_TIMEOUT_MS,
		);
		assertMined(nodeA, relayedHeight, relayedHash);

		step('restart node A without mining; expect the same chain and wallet');
		await stopNode(nodeB);
		await stopNode(nodeA);
		const minedHeights = [...nodeA.output().matchAll(/mined block (\d+) \((\w+)\)/g)];
		const [, lastHeight, lastHash] = minedHeights[minedHeights.length - 1];
		nodeA = startNode('node A (restart)', cwd, dataA, portA);
		running.push(nodeA);
		await waitFor(nodeA, READY, 'listening');
		noLoadErrors(nodeA);
		await waitFor(
			nodeA,
			new RegExp(`Chain loaded: height ${lastHeight}, tip ${lastHash}`),
			'loading the mined chain',
		);
		if (walletAddress(nodeA) !== address) throw new Error('wallet changed across restart');

		running.forEach(noErrors);
		step('PASS');
	} catch (error) {
		console.error(`[smoke] FAIL: ${(error as Error).message}`);
		for (const node of running) {
			console.error(`\n----- ${node.name} output (last 40 lines) -----`);
			console.error(node.output().split('\n').slice(-40).join('\n'));
		}
		process.exitCode = 1;
	} finally {
		await Promise.all(running.map(stopNode));
		if (keep) step(`kept ${root}`);
		else fs.rmSync(root, { recursive: true, force: true });
	}
}

void main();
