// Docker helpers for the scripts that check the image: docker:check and network:check.
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const IMAGE = process.env.IMAGE || 'blockchain-ts:check';

/** Run a docker command; resolves with its trimmed stdout, rejects if it fails. */
export async function docker(...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('docker', args, { maxBuffer: 64 * 1024 * 1024 });
	return stdout.trim();
}

/** `docker build -t IMAGE .`, with its output shown. */
export function build(): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', ['build', '-t', IMAGE, '.'], { stdio: 'inherit' });
		child.once('error', reject);
		child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`docker build exited with ${code}`))));
	});
}

/** Poll `check` (errors count as false) until it holds, or throw after `timeoutMs`. */
export async function waitUntil(check: () => Promise<boolean>, what: string, timeoutMs = 90_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check().catch(() => false)) return;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The host URL of a container's API, published with `-p 127.0.0.1::6001` (the port changes on every start). */
export async function apiUrl(container: string): Promise<string> {
	const mapping = (await docker('port', container, '6001/tcp')).split('\n')[0]; // "127.0.0.1:49153"
	return `http://127.0.0.1:${mapping.slice(mapping.lastIndexOf(':') + 1)}`;
}

/** GET a JSON route of a node's API. */
export async function getJson<T>(api: string, route: string): Promise<T> {
	const res = await fetch(`${api}${route}`);
	if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
	return (await res.json()) as T;
}
