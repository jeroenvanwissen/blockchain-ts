// Smoke check against the real runtime (native ESM, real filesystem, real protobuf).
// From an unrelated working directory and temp data dirs: node A mines, node B syncs from it
// and accepts A's next block live, both answer over the HTTP API and the CLI, then A restarts
// and keeps its chain. A fresh chain mines
// quickly until the retarget catches up, so heights are read from the logs, not assumed.
// Run with `npm run smoke`; --keep keeps the temp dir.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

		step('query both nodes over the HTTP API');
		await waitFor(nodeA, API_READY, 'API');
		await waitFor(nodeB, API_READY, 'API');
		const statusB = await apiGet<{ height: number; tip: string }>(nodeB, '/status');
		const blockA = await apiGet<{ hash: string }>(nodeA, `/blocks/${statusB.height}`);
		if (blockA.hash !== statusB.tip) throw new Error("B's tip is not A's block at that height");
		const balance = await apiGet<{ balance: string }>(nodeA, `/addresses/${address}`);
		if (BigInt(balance.balance) <= 0n) throw new Error("A's API reports no mining rewards");

		step('run the CLI against node A (status, and balance with its api.cookie)');
		const cliStatus = await runCli(['--api', apiUrl(nodeA), 'status']);
		if (cliStatus.code !== 0 || !/^height: \d+$/m.test(cliStatus.stdout)) {
			throw new Error(`cli status failed: ${cliStatus.stderr.trim()}`);
		}
		const cliBalance = await runCli(['--data-dir', dataA, '--api', apiUrl(nodeA), 'balance']);
		if (cliBalance.code !== 0 || !cliBalance.stdout.includes(`address: ${address}`)) {
			throw new Error(`cli balance failed: ${cliBalance.stderr.trim()}`);
		}
		const cookie = path.join(dataA, 'api.cookie');
		if ((fs.statSync(cookie).mode & 0o777) !== 0o600) throw new Error('api.cookie is not 0600');
		const token = fs.readFileSync(cookie, 'utf8').trim();
		if (nodeA.output().includes(token) || cliBalance.stdout.includes(token)) {
			throw new Error('the API token appeared in output');
		}

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
			console.error(lastLines(node));
		}
		process.exitCode = 1;
	} finally {
		await Promise.all(running.map(stopNode));
		if (keep) step(`kept ${root}`);
		else fs.rmSync(root, { recursive: true, force: true });
	}
}

void main();
