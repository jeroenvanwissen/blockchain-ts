// Helpers for scripts that drive real node processes (npm run smoke, npm run e2e).
// Not imported by Jest tests (uses import.meta).
import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import { fileURLToPath } from 'url';

export const READY = /P2P Server listening/;
export const API_READY = /API listening on (http:\/\/\S+)/;
export const TIMEOUT_MS = 30_000;

const SELF = fileURLToPath(import.meta.url);
// index.ts under tsx, index.js when run from dist/
const ENTRY = path.join(path.dirname(SELF), `index${path.extname(SELF)}`);
const TSX_LOADER = import.meta.resolve('tsx');

export interface NodeProcess {
	name: string;
	port: number;
	child: ChildProcess;
	output: () => string;
	exited: Promise<number | null>;
}

export function freePort(): Promise<number> {
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

export function startNode(
	name: string,
	cwd: string,
	dataDir: string,
	port: number,
	extraArgs: string[] = [],
): NodeProcess {
	const args = ['--import', TSX_LOADER, ENTRY, '--data-dir', dataDir, ...extraArgs];
	const child = spawn(process.execPath, args, {
		cwd,
		// API_PORT=0: the node picks a free API port and logs it (see apiUrl)
		env: { ...process.env, P2P_PORT: String(port), API_PORT: '0', SEED_NODES: '' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let buffer = '';
	child.stdout?.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
	child.stderr?.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
	const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
	return { name, port, child, output: () => buffer, exited };
}

export async function waitFor(
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

/** Poll an arbitrary condition. */
export async function waitUntil(
	condition: () => boolean | Promise<boolean>,
	what: string,
	timeoutMs = TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`timed out waiting for ${what}`);
}

export async function stopNode(node: NodeProcess): Promise<void> {
	if (node.child.exitCode !== null || node.child.signalCode !== null) return;
	node.child.kill('SIGINT');
	const timer = setTimeout(() => node.child.kill('SIGKILL'), 5_000);
	await node.exited;
	clearTimeout(timer);
}

/** Base URL of the node's HTTP API, from its startup log. */
export function apiUrl(node: NodeProcess): string {
	const match = node.output().match(API_READY);
	if (!match) throw new Error(`${node.name}: API not listening yet`);
	return match[1];
}

/** GET a path from the node's API; throws on a non-2xx status. */
export async function apiGet<T>(node: NodeProcess, path: string): Promise<T> {
	const res = await fetch(`${apiUrl(node)}${path}`, { signal: AbortSignal.timeout(5_000) });
	if (!res.ok) throw new Error(`${node.name}: GET ${path} returned ${res.status}`);
	return (await res.json()) as T;
}

export function walletAddress(node: NodeProcess): string {
	const match = node.output().match(/Wallet initialized with address: (\S+)/);
	if (!match) throw new Error(`${node.name}: wallet address not logged`);
	return match[1];
}

export function noLoadErrors(node: NodeProcess): void {
	if (/Error loading blockchain|Failed to load blockchain|\[Wallet\] /.test(node.output())) {
		throw new Error(`${node.name}: logged a load error`);
	}
}

export function lastLines(node: NodeProcess, count = 40): string {
	return node.output().split('\n').slice(-count).join('\n');
}
