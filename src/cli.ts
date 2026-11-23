// Command-line client for a running node's HTTP API: `npm run cli -- [options] <command>`.
import { readApiCookie } from './api/cookie.js';
import { formatCoins, parseCoins } from './blockchain/amount.js';
import { API_COOKIE_PATH, API_PORT } from './config.js';

const USAGE = `usage: npm run cli -- [--data-dir <dir>] [--api <url>] <command>

commands:
  status                                    chain status of the node
  balance                                   the node wallet's address and balance
  send <address> <coins> [<address> <coins> ...]
                                            pay from the node's wallet plus the minimum fee;
                                            prints the txid (and the fee on stderr)
  encrypt-wallet                            encrypt the wallet key with a passphrase (asked for;
                                            read from stdin when it isn't a terminal); locks it
  unlock [--timeout <seconds>] [--staking-only]
                                            unlock an encrypted wallet (staking-only: can stake,
                                            can't send)
  lock                                      lock an encrypted wallet

options:
  --data-dir <dir>   the node's data dir, for its api.cookie (default: the default data dir)
  --api <url>        the node's API (default: http://127.0.0.1:${API_PORT}, from P2P_PORT/API_PORT)`;

class UsageError extends Error {}

interface Status {
	network: string;
	height: number;
	tip: string;
	phase: string;
	peers: number;
	mempool: number;
}
interface WalletInfo {
	address: string;
	balance: string;
	spendable: string;
	utxos: number;
	encrypted: boolean;
	locked: boolean;
	stakingOnly: boolean;
	unlockedUntil: string | null;
}

function walletState(w: WalletInfo): string {
	if (!w.encrypted) return 'not encrypted';
	if (w.locked) return 'encrypted, locked';
	const scope = w.stakingOnly ? 'unlocked for staking only' : 'unlocked';
	return `encrypted, ${scope}${w.unlockedUntil ? ` until ${w.unlockedUntil}` : ''}`;
}

/** Read a passphrase without echo from a terminal, or the first line of stdin otherwise. */
async function readPassphrase(prompt: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of stdin as AsyncIterable<Buffer>) chunks.push(chunk);
		return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
	}
	process.stderr.write(prompt);
	return new Promise((resolve, reject) => {
		let input = '';
		const finish = (error?: Error) => {
			stdin.off('data', onData);
			stdin.setRawMode(false);
			stdin.pause();
			process.stderr.write('\n');
			if (error) reject(error);
			else resolve(input);
		};
		const onData = (data: string) => {
			for (const char of data) {
				if (char === '\r' || char === '\n') return finish();
				if (char === '\u0003') return finish(new Error('cancelled'));
				input = char === '\u007f' || char === '\b' ? input.slice(0, -1) : input + char;
			}
		};
		stdin.setRawMode(true);
		stdin.setEncoding('utf8');
		stdin.resume();
		stdin.on('data', onData);
	});
}

/** Split off --data-dir (read by config.ts) and --api; the rest is the command. */
function parseArgs(argv: string[]): { api: string; command: string[] } {
	let api = `http://127.0.0.1:${API_PORT}`;
	const command: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--data-dir' || argv[i] === '--api') {
			if (argv[i + 1] === undefined) throw new UsageError(`${argv[i]} needs a value`);
			if (argv[i] === '--api') api = argv[i + 1].replace(/\/$/, '');
			i++;
		} else {
			command.push(argv[i]);
		}
	}
	return { api, command };
}

async function request<T>(api: string, method: string, path: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = {};
	if (path.startsWith('/wallet')) {
		let token: string;
		try {
			token = readApiCookie(API_COOKIE_PATH);
		} catch {
			throw new Error(`no ${API_COOKIE_PATH}: start the node first, and pass the same --data-dir`);
		}
		headers.authorization = `Bearer ${token}`;
	}
	if (body !== undefined) headers['content-type'] = 'application/json';
	let res: Response;
	try {
		res = await fetch(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
	} catch {
		throw new Error(`no node API at ${api}: is the node running? (see --api)`);
	}
	const data = (await res.json()) as T & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
	return data;
}

async function run(argv: string[]): Promise<void> {
	const { api, command } = parseArgs(argv);
	const [name, ...rest] = command;
	switch (name) {
		case 'status': {
			const s = await request<Status>(api, 'GET', '/status');
			console.log(`network: ${s.network}\nheight: ${s.height}\ntip: ${s.tip}\nphase: ${s.phase}`);
			console.log(`peers: ${s.peers}\nmempool: ${s.mempool}`);
			return;
		}
		case 'balance': {
			const w = await request<WalletInfo>(api, 'GET', '/wallet');
			console.log(`address: ${w.address}`);
			console.log(`wallet: ${walletState(w)}`);
			console.log(`balance: ${formatCoins(BigInt(w.balance))}`);
			console.log(`spendable: ${formatCoins(BigInt(w.spendable))}`);
			console.log(`outputs: ${w.utxos}`);
			return;
		}
		case 'send': {
			if (rest.length === 0 || rest.length % 2 !== 0) throw new UsageError('send needs <address> <coins> pairs');
			const outputs = [];
			for (let i = 0; i < rest.length; i += 2) {
				outputs.push({ address: rest[i], amount: parseCoins(rest[i + 1]).toString() });
			}
			const { txid, fee } = await request<{ txid: string; fee: string }>(api, 'POST', '/wallet/send', { outputs });
			console.log(txid);
			console.error(`fee: ${formatCoins(BigInt(fee))}`);
			return;
		}
		case 'encrypt-wallet': {
			if (rest.length > 0) throw new UsageError('encrypt-wallet takes no arguments');
			const passphrase = await readPassphrase('New wallet passphrase: ');
			if (process.stdin.isTTY && (await readPassphrase('Repeat passphrase: ')) !== passphrase) {
				throw new Error('passphrases do not match');
			}
			const w = await request<WalletInfo>(api, 'POST', '/wallet/encrypt', { passphrase });
			console.log(`wallet: ${walletState(w)}`);
			console.log('Keep the passphrase safe: without it the wallet cannot be unlocked.');
			return;
		}
		case 'unlock': {
			let timeout = 0;
			let stakingOnly = false;
			for (let i = 0; i < rest.length; i++) {
				if (rest[i] === '--staking-only') stakingOnly = true;
				else if (rest[i] === '--timeout' && /^\d+$/.test(rest[i + 1] ?? '')) timeout = Number(rest[++i]);
				else throw new UsageError(`unlock: unexpected ${rest[i]}`);
			}
			const passphrase = await readPassphrase('Wallet passphrase: ');
			const w = await request<WalletInfo>(api, 'POST', '/wallet/unlock', { passphrase, timeout, stakingOnly });
			console.log(`wallet: ${walletState(w)}`);
			return;
		}
		case 'lock': {
			const w = await request<WalletInfo>(api, 'POST', '/wallet/lock', {});
			console.log(`wallet: ${walletState(w)}`);
			return;
		}
		default:
			throw new UsageError(name ? `unknown command: ${name}` : 'no command given');
	}
}

run(process.argv.slice(2)).catch((error: Error) => {
	if (error instanceof UsageError) {
		console.error(`${error.message}\n\n${USAGE}`);
		process.exitCode = 2;
	} else {
		console.error(`error: ${error.message}`);
		process.exitCode = 1;
	}
});
