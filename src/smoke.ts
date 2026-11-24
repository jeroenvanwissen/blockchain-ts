// Smoke check against the real runtime (native ESM, real filesystem, real protobuf).
// From an unrelated working directory and temp data dirs: node A mines, node B syncs from it
// and accepts A's next block live, both answer over the HTTP API and the CLI, A's wallet is
// encrypted, then A restarts with its chain and a locked wallet that the CLI unlocks. A fresh chain mines
// quickly until the retarget catches up, so heights are read from the logs, not assumed.
// Run with `npm run smoke`; --keep keeps the temp dir.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import protobuf from 'protobufjs';
import { WALLET_SCHEMA } from './blockchain/protoSchemas.js';
import {
	API_READY,
	apiGet,
	apiUrl,
	freePort,
	lastLines,
	noLoadErrors,
	READY,
	runCli,
	startNode,
	stopNode,
	waitFor,
	walletAddress,
	type NodeProcess,
} from './nodeHarness.js';

const NEXT_BLOCK_TIMEOUT_MS = 120_000; // up to a few target spacings once the retarget settles
const PASSPHRASE = 'smoke test passphrase';

/** The private key stored in a wallet file (empty once encrypted). */
function storedSeed(file: string): Buffer {
	const type = protobuf.parse(WALLET_SCHEMA).root.lookupType('WalletData');
	const { seed } = type.decode(fs.readFileSync(file)) as unknown as { seed?: Uint8Array };
	return Buffer.from(seed ?? []);
}

function assertFile(file: string): void {
	if (!fs.existsSync(file)) throw new Error(`expected file missing: ${file}`);
}

/** The node logged that it mined this exact block. */
function assertMined(node: NodeProcess, height: string, hashPrefix: string): void {
	if (!node.output().includes(`mined block ${height} (${hashPrefix})`)) {
		throw new Error(`${node.name} did not mine block ${height} (${hashPrefix})`);
	}
}

function noErrors(node: NodeProcess): void {
	// Any warning or error from the node's logger, plus older message wording
	const line = node.output().split('\n').find((l) => / (?:WARN |ERROR) \[|Error|rejected/.test(l));
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
			/Synced \d+ block\(s\) from peer: height (\d+), tip (\w+)/,
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

		step('query both nodes over the HTTP API, and load the block explorer');
		await waitFor(nodeA, API_READY, 'API');
		await waitFor(nodeB, API_READY, 'API');
		const statusB = await apiGet<{ height: number; tip: string }>(nodeB, '/status');
		const blockA = await apiGet<{ hash: string }>(nodeA, `/blocks/${statusB.height}`);
		if (blockA.hash !== statusB.tip) throw new Error("B's tip is not A's block at that height");
		const balance = await apiGet<{ balance: string }>(nodeA, `/addresses/${address}`);
		if (BigInt(balance.balance) <= 0n) throw new Error("A's API reports no mining rewards");
		for (const [route, type] of [['/', 'text/html'], ['/explorer/app.js', 'text/javascript'], ['/explorer/style.css', 'text/css']]) {
			const res = await fetch(`${apiUrl(nodeA)}${route}`);
			if (!res.ok || !res.headers.get('content-type')?.startsWith(type) || !res.headers.get('content-security-policy')) {
				throw new Error(`the block explorer's ${route} is not served (HTTP ${res.status})`);
			}
		}

		step('run the CLI against node A (status, and balance with its api.cookie)');
		const cliStatus = await runCli(['--api', apiUrl(nodeA), 'status']);
		if (cliStatus.code !== 0 || !/^height: \d+$/m.test(cliStatus.stdout)) {
			throw new Error(`cli status failed: ${cliStatus.stderr.trim()}`);
		}
		const cliBalance = await runCli(['--data-dir', dataA, '--api', apiUrl(nodeA), 'balance']);
		if (cliBalance.code !== 0 || !cliBalance.stdout.includes(`address: ${address}`)) {
			throw new Error(`cli balance failed: ${cliBalance.stderr.trim()}`);
		}
		const newAddress = await runCli(['--data-dir', dataA, '--api', apiUrl(nodeA), 'new-address']);
		const created = newAddress.stdout.trim();
		const listed = await runCli(['--data-dir', dataA, '--api', apiUrl(nodeA), 'addresses']);
		if (newAddress.code !== 0 || created === address || !listed.stdout.includes(created) || !listed.stdout.includes(address)) {
			throw new Error(`cli new-address or addresses failed: ${newAddress.stderr.trim()} ${listed.stderr.trim()}`);
		}
		const cookie = path.join(dataA, 'api.cookie');
		if ((fs.statSync(cookie).mode & 0o777) !== 0o600) throw new Error('api.cookie is not 0600');
		const token = fs.readFileSync(cookie, 'utf8').trim();
		if (nodeA.output().includes(token) || cliBalance.stdout.includes(token)) {
			throw new Error('the API token appeared in output');
		}

		step("encrypt A's wallet with the CLI; the unencrypted seed must leave the disk");
		const walletFile = path.join(dataA, 'wallet.dat');
		const plainSeed = storedSeed(walletFile);
		const encrypted = await runCli(['--data-dir', dataA, '--api', apiUrl(nodeA), 'encrypt-wallet'], `${PASSPHRASE}\n`);
		if (encrypted.code !== 0 || !encrypted.stdout.includes('wallet: encrypted, locked')) {
			throw new Error(`cli encrypt-wallet failed: ${encrypted.stderr.trim()}`);
		}
		if (plainSeed.length !== 32 || fs.readFileSync(walletFile).includes(plainSeed)) {
			throw new Error('the unencrypted seed is still in wallet.dat');
		}
		if (fs.readdirSync(dataA).some((f) => f.startsWith('wallet.dat.') && f.endsWith('.backup'))) {
			throw new Error('unencrypted wallet backups were left behind');
		}

		step('a second node on A\'s P2P port must exit instead of running without peers');
		const duplicate = startNode('duplicate', cwd, path.join(root, 'node-dup'), portA);
		running.push(duplicate);
		const exitCode = await duplicate.exited;
		if (exitCode !== 1 || !duplicate.output().includes(`P2P server could not listen on port ${portA}`)) {
			throw new Error(`a node on a taken P2P port exited with ${String(exitCode)}: ${lastLines(duplicate, 5)}`);
		}
		running.splice(running.indexOf(duplicate), 1); // its error line is the expected outcome

		step('stop node A with SIGTERM and restart it without mining; expect the same chain and wallet');
		await stopNode(nodeB);
		await stopNode(nodeA, 'SIGTERM'); // what systemd and Docker send: must save the chainstate
		assertFile(path.join(dataA, 'blocks', 'mempool.json')); // and the pending transactions (none here)
		if (!nodeA.output().includes('saved 0 pending transaction(s)')) throw new Error("A didn't report saving its mempool");
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
		// A saved its chainstate on shutdown: the restart starts from it instead of revalidating
		await waitFor(nodeA, /chainstate at height \d+; validated 0 newer block\(s\)/, 'starting from the saved chainstate');
		if (walletAddress(nodeA) !== address) throw new Error('wallet changed across restart');

		step('the address and wallet histories match after the restart; the restarted wallet is locked: the CLI unlocks it (staking only) and locks it');
		await waitFor(nodeA, API_READY, 'API');
		// The address history is rebuilt from the chain at startup: it must end at the balance
		const history = await apiGet<{ total: number; transactions: { balance: string }[] }>(nodeA, `/addresses/${address}/transactions?limit=1`);
		const restartedBalance = (await apiGet<{ balance: string }>(nodeA, `/addresses/${address}`)).balance;
		if (history.total === 0 || history.transactions[0].balance !== restartedBalance) {
			throw new Error(`A's address history doesn't match its balance after the restart (${history.total} entries)`);
		}
		const cli = (args: string[], input?: string) => runCli(['--data-dir', dataA, '--api', apiUrl(nodeA), ...args], input);
		const restartedWallet = (await cli(['balance'])).stdout;
		if (!restartedWallet.includes('wallet: encrypted, locked')) throw new Error('wallet not locked after restart');
		// The wallet history (all addresses, needs no unlock) is rebuilt too: its newest balance is the wallet's
		const walletHistory = await cli(['history', '--limit', '2']);
		const newest = /^\s+\d+\s+\S+ \S+\s+mined\s+\+[\d.]+\s+([\d.]+)\s+[0-9a-f]{64}/m.exec(walletHistory.stdout);
		if (walletHistory.code !== 0 || !newest || !restartedWallet.includes(`balance: ${newest[1]}\n`)) {
			throw new Error(`cli history doesn't end at the wallet balance: ${walletHistory.stdout.trim()} ${walletHistory.stderr.trim()}`);
		}
		if (!(await cli(['addresses'])).stdout.includes(created)) throw new Error('the new address is gone after restart');
		const wrong = await cli(['unlock'], 'not the passphrase\n');
		if (wrong.code === 0 || !wrong.stderr.includes('wrong passphrase')) throw new Error('a wrong passphrase unlocked the wallet');
		const unlocked = await cli(['unlock', '--staking-only'], `${PASSPHRASE}\n`);
		if (!unlocked.stdout.includes('wallet: encrypted, unlocked for staking only')) {
			throw new Error(`cli unlock failed: ${unlocked.stdout.trim()} ${unlocked.stderr.trim()}`);
		}
		if (!(await cli(['lock'])).stdout.includes('wallet: encrypted, locked')) throw new Error('cli lock failed');
		const changed = await cli(['change-passphrase'], `${PASSPHRASE}\n${PASSPHRASE} changed\n`);
		if (changed.code !== 0 || !(await cli(['unlock'], `${PASSPHRASE} changed\n`)).stdout.includes('wallet: encrypted, unlocked')) {
			throw new Error(`cli change-passphrase failed: ${changed.stderr.trim()}`);
		}
		if (running.some((node) => node.output().includes(PASSPHRASE))) throw new Error('the passphrase appeared in output');

		running.forEach(noErrors);
		step('PASS');
	} catch (error) {
		console.error(`[smoke] FAIL: ${(error as Error).message}`);
		for (const node of running) {
			console.error(`\n----- ${node.name} output (last 40 lines) -----`);
			console.error(lastLines(node));
		}
		process.exitCode = 1;
	} finally {
		await Promise.all(running.map((node) => stopNode(node)));
		if (keep) step(`kept ${root}`);
		else fs.rmSync(root, { recursive: true, force: true });
	}
}

void main();
