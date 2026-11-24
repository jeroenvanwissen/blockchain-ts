// Command-line client for a running node's HTTP API: `npm run cli -- [options] <command>`.
// `restore-wallet` works offline on the data dir instead (with the node stopped).
import * as fs from 'fs';
import * as path from 'path';
import { readApiCookie } from './api/cookie.js';
import { formatCoins, parseCoins } from './blockchain/amount.js';
import { Wallet } from './blockchain/Wallet.js';
import { API_COOKIE_PATH, API_PORT, DATA_DIR, MIN_PASSPHRASE_LENGTH, WALLET_DATA_FILENAME } from './config.js';

const USAGE = `usage: npm run cli -- [--data-dir <dir>] [--api <url>] <command>

commands:
  status                                    chain status of the node
  balance                                   the wallet's primary address and its balance over
                                            all addresses
  new-address                               hand out a new receiving address (no passphrase
                                            needed)
  addresses                                 the wallet's addresses with their balances
  history [--limit <n>] [--before <position>]
                                            the wallet's transactions over all its addresses,
                                            newest first (pending ones on top): type, change,
                                            balance after, txid, recipients and fee
  send <address> <coins> [<address> <coins> ...]
                                            pay from the node's wallet plus the minimum fee;
                                            prints the txid (and the fee on stderr)
  encrypt-wallet                            encrypt the wallet key with a passphrase (asked for;
                                            read from stdin when it isn't a terminal); locks it
  unlock [--timeout <seconds>] [--staking-only]
                                            unlock an encrypted wallet (staking-only: can stake,
                                            can't send)
  lock                                      lock an encrypted wallet
  change-passphrase                         re-encrypt the wallet under a new passphrase (current
                                            and new are asked for; two stdin lines otherwise)
  staking                                   whether the node stakes, eligible outputs, the chance
                                            of a kernel per slot, and the last block it staked
  seed-phrase                               show the wallet's 24-word seed phrase (an encrypted
                                            wallet asks for its passphrase)
  restore-wallet [--encrypt]                with the node stopped: create the data dir's wallet
                                            from a seed phrase (asked for; read from stdin when
                                            it isn't a terminal), optionally encrypted at once;
                                            never replaces an existing wallet.dat

options:
  --data-dir <dir>   the node's data dir, for its api.cookie (default: the default data dir)
  --api <url>        the node's API (default: http://127.0.0.1:${API_PORT}, from P2P_PORT/API_PORT)`;

class UsageError extends Error {}

const SEED_PHRASE_WORDS = 24;

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
	addresses: number;
	balance: string;
	spendable: string;
	utxos: number;
	encrypted: boolean;
	locked: boolean;
	stakingOnly: boolean;
	unlockedUntil: string | null;
	seedPhrase: boolean;
}

interface AddressInfo {
	address: string;
	balance: string;
	spendable: string;
	utxos: number;
	index: number | null;
	primary: boolean;
}

interface WalletEntry {
	txid: string;
	type: string; // receive, send, self, mined, reward or stake
	amount: string; // net change to the wallet, negative for a payment (fee included)
	fee: string | null;
	addresses: string[]; // a payment's recipients, otherwise the wallet's addresses it paid
}

interface WalletHistory {
	total: number;
	transactions: (WalletEntry & { position: number; height: number; timestamp: number; balance: string; immature: boolean })[];
	pending: WalletEntry[];
}

interface StakingInfo {
	enabled: boolean;
	phase: string;
	locked: boolean;
	stakingOnly: boolean;
	eligibleOutputs: number;
	eligibleValue: string;
	chancePerSlot: number;
	expectedSeconds: number | null;
	stakedSinceStart: number;
	lastStaked: { height: number; hash: string; time: string } | null;
}

/** Seconds as "45 s", "12 min", "3.5 h" or "2.1 days". */
function formatDuration(seconds: number): string {
	if (seconds < 90) return `${Math.round(seconds)} s`;
	if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
	if (seconds < 48 * 3600) return `${(seconds / 3600).toFixed(1)} h`;
	return `${(seconds / 86_400).toFixed(1)} days`;
}

/** A timestamp (ms) as local "YYYY-MM-DD HH:MM:SS". */
function formatTime(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** One line of `history`: fixed-width columns, then the txid and notes. */
function historyRow(height: string, time: string, type: string, amount: string, balance: string, txid: string, note = ''): string {
	const columns = `${height.padStart(7)}  ${time.padEnd(19)}  ${type.padEnd(7)}  ${amount.padStart(16)}  ${balance.padStart(16)}`;
	return `${columns}  ${txid}${note ? `  ${note}` : ''}`;
}

/** Where a history entry paid, its fee and whether its coins are spendable yet. */
function historyNote(entry: WalletEntry & { immature?: boolean }): string {
	const notes: string[] = [];
	const [first, ...more] = entry.addresses;
	if (first) notes.push(`to ${first}${more.length > 0 ? ` +${more.length} more` : ''}`);
	if (entry.fee !== null) notes.push(`fee ${formatCoins(BigInt(entry.fee))}`);
	if (entry.immature) notes.push('immature');
	return notes.join(', ');
}

/** Base units as coins with a sign: "+1.5", "-0.25", "0". */
function signedCoins(amount: string): string {
	const value = BigInt(amount);
	return `${value > 0n ? '+' : ''}${formatCoins(value)}`;
}

function walletState(w: WalletInfo): string {
	if (!w.encrypted) return 'not encrypted';
	if (w.locked) return 'encrypted, locked';
	const scope = w.stakingOnly ? 'unlocked for staking only' : 'unlocked';
	return `encrypted, ${scope}${w.unlockedUntil ? ` until ${w.unlockedUntil}` : ''}`;
}

let stdinLines: string[] | null = null; // piped input, one passphrase per line

/** Read a passphrase without echo from a terminal, or the next line of stdin otherwise. */
async function readPassphrase(prompt: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		if (!stdinLines) {
			const chunks: Buffer[] = [];
			for await (const chunk of stdin as AsyncIterable<Buffer>) chunks.push(chunk);
			stdinLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
		}
		return stdinLines.shift() ?? '';
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

/**
 * Read a 24-word seed phrase over as many lines as it takes (not echoed on a terminal), plain
 * or numbered as `cli seed-phrase` prints it. Stops early at an empty line or the end of input.
 */
async function readSeedPhrase(): Promise<string> {
	const words: string[] = [];
	while (words.length < SEED_PHRASE_WORDS) {
		const prompt = words.length === 0 ? 'Seed phrase (24 words, not shown; Enter after any of them): ' : `${SEED_PHRASE_WORDS - words.length} more word(s): `;
		const tokens = (await readPassphrase(prompt)).split(/\s+/).filter((token) => token && !/^\d+[.)]?$/.test(token));
		if (tokens.length === 0) break;
		words.push(...tokens);
	}
	return words.join(' ');
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
			console.log(`addresses: ${w.addresses}`);
			console.log(`wallet: ${walletState(w)}`);
			console.log(`balance: ${formatCoins(BigInt(w.balance))}`);
			console.log(`spendable: ${formatCoins(BigInt(w.spendable))}`);
			console.log(`outputs: ${w.utxos}`);
			console.log(`backup: ${w.seedPhrase ? 'seed phrase (cli seed-phrase)' : 'copy wallet.dat (no seed phrase)'}`);
			return;
		}
		case 'new-address': {
			if (rest.length > 0) throw new UsageError('new-address takes no arguments');
			const { address } = await request<{ address: string }>(api, 'POST', '/wallet/addresses', {});
			console.log(address);
			return;
		}
		case 'addresses': {
			if (rest.length > 0) throw new UsageError('addresses takes no arguments');
			const list = await request<AddressInfo[]>(api, 'GET', '/wallet/addresses');
			for (const a of list) {
				const note = a.primary ? '  (primary)' : a.index === null ? '' : `  #${a.index}`;
				console.log(`${a.address}  ${formatCoins(BigInt(a.balance)).padStart(16)}${note}`);
			}
			return;
		}
		case 'history': {
			const query = new URLSearchParams();
			for (let i = 0; i < rest.length; i++) {
				if ((rest[i] === '--limit' || rest[i] === '--before') && /^\d+$/.test(rest[i + 1] ?? '')) {
					query.set(rest[i].slice(2), rest[++i]);
				} else {
					throw new UsageError(`history: unexpected ${rest[i]}`);
				}
			}
			const path = query.size > 0 ? `/wallet/transactions?${query.toString()}` : '/wallet/transactions';
			const h = await request<WalletHistory>(api, 'GET', path);
			if (h.total === 0 && h.pending.length === 0) {
				console.log('no transactions yet');
				return;
			}
			console.log(historyRow('height', 'time', 'type', 'amount', 'balance', 'txid'));
			if (!query.has('before')) {
				for (const p of h.pending) console.log(historyRow('pending', '', p.type, signedCoins(p.amount), '', p.txid, historyNote(p)));
			}
			for (const t of h.transactions) {
				const balance = formatCoins(BigInt(t.balance));
				console.log(historyRow(String(t.height), formatTime(t.timestamp), t.type, signedCoins(t.amount), balance, t.txid, historyNote(t)));
			}
			const oldest = h.transactions[h.transactions.length - 1];
			if (oldest && oldest.position > 0) console.log(`${oldest.position} older: history --before ${oldest.position}`);
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
		case 'staking': {
			const s = await request<StakingInfo>(api, 'GET', '/wallet/staking');
			console.log(`staking: ${s.enabled ? 'enabled' : 'disabled (start the node with --stake)'}, phase ${s.phase}`);
			if (s.locked) console.log('wallet: locked; unlock it to stake (cli unlock --staking-only)');
			console.log(`eligible: ${s.eligibleOutputs} output(s), ${formatCoins(BigInt(s.eligibleValue))} coins`);
			const expected = s.expectedSeconds === null ? '' : `, expected in ${formatDuration(s.expectedSeconds)}`;
			console.log(`kernel chance per slot: ${(s.chancePerSlot * 100).toFixed(2)}%${expected}`);
			console.log(`staked since start: ${s.stakedSinceStart}`);
			console.log(`last staked: ${s.lastStaked ? `block ${s.lastStaked.height} at ${s.lastStaked.time}` : 'none in the last 10,000 blocks'}`);
			return;
		}
		case 'seed-phrase': {
			if (rest.length > 0) throw new UsageError('seed-phrase takes no arguments');
			const w = await request<WalletInfo>(api, 'GET', '/wallet');
			const body = w.encrypted && w.seedPhrase ? { passphrase: await readPassphrase('Wallet passphrase: ') } : {};
			const { phrase } = await request<{ phrase: string }>(api, 'POST', '/wallet/seed-phrase', body);
			const words = phrase.split(' ');
			for (let row = 0; row < words.length; row += 4) {
				console.log(words.slice(row, row + 4).map((word, i) => `${String(row + i + 1).padStart(2)}. ${word.padEnd(9)}`).join('  ').trimEnd());
			}
			console.error("Write the words down in order and keep them offline: anyone who has them can spend this wallet's coins.");
			console.error('`cli restore-wallet` recreates the wallet from them on any node.');
			return;
		}
		case 'restore-wallet': {
			const encrypt = rest.includes('--encrypt');
			if (rest.some((arg) => arg !== '--encrypt')) throw new UsageError('restore-wallet takes only --encrypt');
			const walletPath = path.join(DATA_DIR, WALLET_DATA_FILENAME);
			if (fs.existsSync(walletPath)) {
				throw new Error(`${walletPath} already exists: stop the node and move it away first (it may hold the keys to coins)`);
			}
			const phrase = await readSeedPhrase();
			let passphrase: string | undefined;
			if (encrypt) {
				passphrase = await readPassphrase('New wallet passphrase: ');
				if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
				if (process.stdin.isTTY && (await readPassphrase('Repeat passphrase: ')) !== passphrase) {
					throw new Error('passphrases do not match');
				}
			}
			const wallet = Wallet.restore(phrase, walletPath, passphrase);
			console.log(`restored ${walletPath}`);
			console.log(`primary address: ${wallet.address}`);
			console.log(`wallet: ${encrypt ? 'encrypted, locked' : 'not encrypted (cli encrypt-wallet once the node runs)'}`);
			console.error('Start the node: it finds the addresses in use as it syncs the chain.');
			return;
		}
		case 'change-passphrase': {
			if (rest.length > 0) throw new UsageError('change-passphrase takes no arguments');
			const passphrase = await readPassphrase('Current passphrase: ');
			const newPassphrase = await readPassphrase('New passphrase: ');
			if (process.stdin.isTTY && (await readPassphrase('Repeat new passphrase: ')) !== newPassphrase) {
				throw new Error('passphrases do not match');
			}
			const w = await request<WalletInfo>(api, 'POST', '/wallet/passphrase', { passphrase, newPassphrase });
			console.log(`wallet: ${walletState(w)}`);
			console.log('Passphrase changed; backups made under the old passphrase were deleted.');
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
