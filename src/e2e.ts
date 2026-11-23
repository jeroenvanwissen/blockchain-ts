// End-to-end scenario with real node processes on the regression-test network (--regtest:
// 20 PoW blocks, no minimum stake age). Run with `npm run e2e` (a few minutes); --keep keeps
// the temp dir.
//
//   1. A mines and stakes; B and C join through A. An in-process harness peer (H) follows the
//      network to check the final chain independently.
//   2. A's wallet pays C through the CLI (`send`): 12 separate coins, so C has enough outputs
//      to keep staking alone (each staked output waits 10 confirmations).
//   3. After block 20 the chain is proof of stake; A and C both stake.
//   4. C is partitioned (restarted on a new port with no peers) and stakes alone.
//   5. C reconnects: one side reorganizes and all tips converge.
//   6. A restarts and the network converges again; C's CLI reports the payment.
// Node tips and balances are read from each node's HTTP API.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseCoins } from './blockchain/amount.js';
import { Blockchain } from './blockchain/Blockchain.js';
import {
	COIN,
	REGTEST_NETWORK_MAGIC,
	REGTEST_POW_CUTOFF_BLOCK,
	REGTEST_STAKE_MIN_AGE,
} from './config.js';
import { P2PServer } from './networking/P2PServer.js';
import {
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
	waitUntil,
	walletAddress,
	type NodeProcess,
} from './nodeHarness.js';

const PHASE_TIMEOUT_MS = 180_000;
const PAYMENT_OUTPUTS = 12; // 1 coin each

const step = (message: string) => console.log(`[e2e] ${message}`);

const status = (node: NodeProcess) => apiGet<{ height: number; tip: string }>(node, '/status');

function countMatches(node: NodeProcess, pattern: RegExp): number {
	return [...node.output().matchAll(new RegExp(pattern.source, 'g'))].length;
}

async function main(): Promise<void> {
	const keep = process.argv.includes('--keep');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blockchain-ts-e2e-'));
	const dirs = { a: 'node-a', b: 'node-b', c: 'node-c', h: 'harness', cwd: 'cwd' };
	for (const [key, name] of Object.entries(dirs)) {
		dirs[key as keyof typeof dirs] = path.join(root, name);
	}
	fs.mkdirSync(dirs.cwd);
	const regtest = ['--regtest'];
	const running: NodeProcess[] = [];
	const start = (name: string, dataDir: string, port: number, args: string[]) => {
		const node = startNode(name, dirs.cwd, dataDir, port, [...regtest, ...args]);
		running.push(node);
		return node;
	};

	// In-process harness peer: follows the network and submits the payment
	const harnessChain = new Blockchain({
		blocksDir: path.join(dirs.h, 'blocks'),
		powCutoffBlock: REGTEST_POW_CUTOFF_BLOCK,
		minStakeAge: REGTEST_STAKE_MIN_AGE,
	});
	const harness = new P2PServer(harnessChain, await freePort(), path.join(dirs.h, 'peers.json'), {
		networkMagic: REGTEST_NETWORK_MAGIC,
	});
	const tipsOf = async (nodes: NodeProcess[]) =>
		Promise.all(nodes.map((node) => status(node).then((s) => s.tip)));
	/** All nodes report the same tip; a node that can't be queried (restarting) counts as no. */
	const agree = async (nodes: NodeProcess[]) => {
		try {
			return new Set(await tipsOf(nodes)).size === 1;
		} catch {
			return false;
		}
	};

	try {
		const [portA, portB] = [await freePort(), await freePort()];
		step(`start A (mine + stake) on ${portA}, B and C (stake) through A`);
		let nodeA = start('A', dirs.a, portA, ['--mine', '--stake']);
		await waitFor(nodeA, READY, 'A listening');
		const nodeB = start('B', dirs.b, portB, ['--stake', '--peers', `ws://127.0.0.1:${portA}`]);
		let nodeC = start('C', dirs.c, await freePort(), ['--stake', '--peers', `ws://127.0.0.1:${portA}`]);
		await waitFor(nodeB, READY, 'B listening');
		await waitFor(nodeC, READY, 'C listening');
		await harness.listen();
		harness.connectToPeers([`ws://127.0.0.1:${portA}`]);

		step(`pay C ${PAYMENT_OUTPUTS} separate coins from A's wallet with the CLI once A can afford it`);
		const addressA = walletAddress(nodeA);
		const addressC = walletAddress(nodeC);
		const paymentTotal = BigInt(PAYMENT_OUTPUTS) * COIN;
		await waitUntil(
			() =>
				apiGet<{ spendable: string }>(nodeA, `/addresses/${addressA}`)
					.then((a) => BigInt(a.spendable) >= paymentTotal)
					.catch(() => false),
			"A's coins to mature",
			PHASE_TIMEOUT_MS,
		);
		const pairs = Array.from({ length: PAYMENT_OUTPUTS }, () => [addressC, '1']).flat();
		const sent = await runCli(['--data-dir', dirs.a, '--api', apiUrl(nodeA), 'send', ...pairs]);
		if (sent.code !== 0) throw new Error(`cli send failed: ${sent.stderr.trim()}`);
		const txid = sent.stdout.trim();
		const isConfirmed = () => !!harnessChain.findTransaction(txid)?.block;
		await waitUntil(isConfirmed, 'the payment to be confirmed', PHASE_TIMEOUT_MS);

		step(`wait for proof of stake after block ${REGTEST_POW_CUTOFF_BLOCK}, staked by both A and C`);
		await waitFor(nodeA, /\[Staking\] staked block/, 'A staking', PHASE_TIMEOUT_MS);
		await waitFor(nodeC, /\[Staking\] staked block/, 'C staking', PHASE_TIMEOUT_MS);

		step('partition C: restart it on a new port with no peers; it keeps staking alone');
		await stopNode(nodeC);
		fs.rmSync(path.join(dirs.c, 'peers.json'), { force: true });
		nodeC = start('C (partitioned)', dirs.c, await freePort(), ['--stake']);
		await waitFor(nodeC, READY, 'C listening');
		await waitUntil(() => countMatches(nodeC, /\[Staking\] staked block/) >= 2, 'C staking 2 blocks alone', PHASE_TIMEOUT_MS);
		const forkedTips = await tipsOf([nodeA, nodeC]);
		if (forkedTips[0] === forkedTips[1]) throw new Error('A and C did not diverge while partitioned');

		step('reconnect C through A; expect a reorg and converging tips');
		await stopNode(nodeC);
		nodeC = start('C (reconnected)', dirs.c, await freePort(), ['--stake', '--peers', `ws://127.0.0.1:${portA}`]);
		await waitFor(nodeC, READY, 'C listening');
		await waitUntil(() => agree([nodeA, nodeB, nodeC]), 'A, B and C to agree', PHASE_TIMEOUT_MS);
		if (!running.some((node) => /\[Blockchain\] reorganized/.test(node.output()))) {
			throw new Error('no node reorganized after the partition');
		}

		step('restart A; expect it to load its chain and converge again');
		await stopNode(nodeA);
		nodeA = start('A (restarted)', dirs.a, portA, ['--mine', '--stake']);
		await waitFor(nodeA, READY, 'A listening');
		await waitFor(nodeA, /Chain loaded: height \d+/, 'A loading its chain');
		await waitUntil(() => agree([nodeA, nodeB, nodeC]), 'convergence after restart', PHASE_TIMEOUT_MS);

		step('check the converged chain');
		harness.connectToPeers([`ws://127.0.0.1:${portA}`]);
		await waitUntil(
			async () => (await tipsOf([nodeA]).catch(() => ['']))[0] === harnessChain.getLatestBlock().hash,
			'the harness to follow',
			PHASE_TIMEOUT_MS,
		);
		if (!isConfirmed()) throw new Error('payment not in the converged chain');
		if (harnessChain.getBalance(addressC) < paymentTotal) throw new Error('C lost its payment');
		const stakingA = await runCli(['--data-dir', dirs.a, '--api', apiUrl(nodeA), 'staking']);
		if (!/^staking: enabled/m.test(stakingA.stdout) || !/^last staked: block \d+/m.test(stakingA.stdout)) {
			throw new Error(`A's CLI doesn't report its staking: ${stakingA.stdout.trim()} ${stakingA.stderr.trim()}`);
		}
		const balanceC = await runCli(['--data-dir', dirs.c, '--api', apiUrl(nodeC), 'balance']);
		const reported = /^balance: ([\d.]+)$/m.exec(balanceC.stdout);
		if (!reported || parseCoins(reported[1]) < paymentTotal) {
			throw new Error(`C's CLI reports less than its payment: ${balanceC.stdout.trim()} ${balanceC.stderr.trim()}`);
		}
		if (!harnessChain.isChainValid()) throw new Error('converged chain is not valid');
		running.filter((node) => node.child.exitCode === null).forEach(noLoadErrors);
		const penalizing = running.find((node) => /Peer misbehaving|Banning peer/.test(node.output()));
		if (penalizing) throw new Error(`${penalizing.name} penalized an honest peer`);
		const posBlocks = harnessChain.getChain().filter((block) => block.isProofOfStake()).length;
		step(`PASS: height ${harnessChain.getLatestBlock().index}, ${posBlocks} PoS blocks`);
	} catch (error) {
		console.error(`[e2e] FAIL: ${(error as Error).message}`);
		for (const node of running.filter((n) => n.child.exitCode === null)) {
			const tip = await status(node).catch(() => undefined);
			console.error(`\n----- ${node.name}: height ${tip?.height ?? '?'}, tip ${tip?.tip.slice(0, 16) ?? '?'} -----`);
			console.error(lastLines(node));
		}
		process.exitCode = 1;
	} finally {
		await harness.close();
		await Promise.all(running.map((node) => stopNode(node)));
		if (keep) step(`kept ${root}`);
		else fs.rmSync(root, { recursive: true, force: true });
	}
}

void main();
