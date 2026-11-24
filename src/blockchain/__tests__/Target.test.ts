import { Block, merkleRoot } from '../Block.js';
import { requiredBits } from '../retarget.js';
import { bitsToTarget, blockWork, MAX_TARGET_BITS, POS_LIMIT_BITS, POW_LIMIT_BITS, targetToBits } from '../target.js';
import { NULL_HASH, Transaction } from '../Transaction.js';
import { COIN, POS_LIMIT, POW_CUTOFF_BLOCK, POW_LIMIT, RETARGET_WINDOW, STAKE_MIN_AGE, TARGET_SPACING } from '../../config.js';

const ADDRESS = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
const EASY_BITS = targetToBits((1n << 252n) - 1n); // ~16 hashes per block

function coinstake(height: number): Transaction {
	return new Transaction(
		[{ previousTx: 'ab'.repeat(32), outputIndex: height, publicKey: '', signature: '' }],
		[
			{ address: ADDRESS, amount: 0n },
			{ address: ADDRESS, amount: 100n * COIN },
		],
	);
}

/** Header-only chain: each block carries the target the retarget requires for it. */
function simulate(spacings: number[], kinds: ('pow' | 'pos')[] = []): Block[] {
	const chain = [new Block(1_700_000_000_000, [Transaction.coinbase('genesis', 0n, 0)], NULL_HASH)];
	spacings.forEach((spacing, i) => {
		const height = chain.length;
		const isPos = kinds[i] === 'pos';
		const prev = chain[height - 1];
		const txs = [Transaction.coinbase(ADDRESS, 10n * COIN, height)];
		if (isPos) txs.push(coinstake(height));
		chain.push(
			new Block(prev.timestamp + spacing, txs, prev.hash, 0, requiredBits(chain, height, isPos), height),
		);
	});
	return chain;
}

const ratio = (a: number, b: number): number =>
	Number((bitsToTarget(a) * 1_000_000n) / bitsToTarget(b)) / 1_000_000;

describe('compact targets', () => {
	it('should match Bitcoin nBits test vectors', () => {
		expect(bitsToTarget(0x1d00ffff)).toBe(0xffffn << 208n);
		expect(targetToBits(0xffffn << 208n)).toBe(0x1d00ffff);
		expect(targetToBits(bitsToTarget(0x1b0404cb))).toBe(0x1b0404cb);
		expect(bitsToTarget(0x03123456)).toBe(0x123456n);
	});

	it('should keep the mantissa positive and reject negative encodings', () => {
		expect(targetToBits(0x80n)).toBe(0x02008000);
		expect(bitsToTarget(0x02008000)).toBe(0x80n);
		expect(bitsToTarget(0x04923456)).toBe(0n); // sign bit set
	});

	it('should never decode to more than the encoded target', () => {
		for (const target of [POW_LIMIT, POS_LIMIT, (1n << 200n) + 12345n, 999n]) {
			expect(bitsToTarget(targetToBits(target))).toBeLessThanOrEqual(target);
		}
	});

	it('should compute work as 2^256 / (target + 1)', () => {
		expect(blockWork(MAX_TARGET_BITS)).toBe(1n);
		expect(blockWork(EASY_BITS)).toBe(16n);
		expect(blockWork(POW_LIMIT_BITS)).toBe(65537n); // limit after compact rounding
	});
});

describe('block header', () => {
	function solvedBlock(): Block {
		const block = new Block(
			1_700_000_000_000,
			[Transaction.coinbase(ADDRESS, 10n * COIN, 1)],
			'cd'.repeat(32),
			0,
			EASY_BITS,
			1,
		);
		block.solve();
		return block;
	}

	it('should hash the header so that solve() meets the target', () => {
		const block = solvedBlock();
		expect(block.hash).toBe(Block.hashHeader(block.headerPrefix(), block.nonce));
		expect(block.meetsTarget()).toBe(true);
		expect(block.isValid()).toBe(true);
	});

	it.each([
		['a transaction', (b: Block) => (b.transactions[0].outputs[0].amount += 1n)],
		['the timestamp', (b: Block) => (b.timestamp += 1)],
		['the bits', (b: Block) => (b.bits = MAX_TARGET_BITS)],
		['the previous hash', (b: Block) => (b.previousHash = 'ef'.repeat(32))],
	])('should invalidate the hash when %s changes', (_what, tamper) => {
		const block = solvedBlock();
		tamper(block);
		expect(block.calculateHash()).not.toBe(block.hash);
		expect(block.isValid()).toBe(false);
	});

	it('should build the merkle root from witness hashes, in order', () => {
		const [a, b, c] = [1, 2, 3].map((h) => Transaction.coinbase(ADDRESS, COIN, h));
		expect(merkleRoot([a])).toBe(a.witnessHash());
		expect(merkleRoot([a, b])).not.toBe(merkleRoot([b, a]));
		expect(merkleRoot([a, b, c])).toBe(merkleRoot([a, b, c, c])); // odd level duplicates
		expect(merkleRoot([])).toBe(NULL_HASH);
	});

	it('should round-trip through JSON and reject a hash that does not match', () => {
		const block = solvedBlock();
		const wire = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
		expect(Block.fromJSON(wire).hash).toBe(block.hash);

		wire.nonce = (wire.nonce as number) + 1;
		expect(() => Block.fromJSON(wire)).toThrow('malformed block: hash does not match header');
	});
});

describe('retarget', () => {
	const T = TARGET_SPACING;

	it('should start at the limit for the first two blocks of a type', () => {
		const chain = simulate([T, T]);
		expect(chain[1].bits).toBe(POW_LIMIT_BITS);
		expect(chain[2].bits).toBe(POW_LIMIT_BITS);
	});

	it('should keep the target steady when blocks arrive on schedule', () => {
		const chain = simulate(new Array<number>(20).fill(T));
		const last = chain[chain.length - 1].bits;
		expect(ratio(last, POW_LIMIT_BITS)).toBeGreaterThan(0.999);
	});

	it('should tighten smoothly (a few percent per block) when blocks come twice as fast', () => {
		const chain = simulate(new Array<number>(30).fill(T / 2));
		const n = RETARGET_WINDOW;
		const expected = (n - 1 + 1) / (n + 1); // ((N−1)T + 2·T/2) / ((N+1)T) = 16/17 ≈ 0.94
		for (let i = 4; i < chain.length; i++) {
			expect(ratio(chain[i].bits, chain[i - 1].bits)).toBeCloseTo(expected, 3);
		}
		expect(ratio(chain[chain.length - 1].bits, POW_LIMIT_BITS)).toBeLessThan(0.25);
	});

	it('should loosen when blocks are slow, never beyond the limit', () => {
		const fast = new Array<number>(20).fill(T / 4);
		const slow = new Array<number>(30).fill(T * 2);
		const chain = simulate([...fast, ...slow]);
		// From block f+2 on, each target is computed from a 2T spacing:
		// ((N−1)T + 2·2T) / ((N+1)T) = 19/17 per block
		const f = fast.length;
		const n = RETARGET_WINDOW;
		const step = (n - 1 + 4) / (n + 1);
		expect(ratio(chain[f + 6].bits, chain[f + 2].bits)).toBeCloseTo(step ** 4, 2);
		for (const block of chain) {
			expect(bitsToTarget(block.bits)).toBeLessThanOrEqual(POW_LIMIT);
		}
		expect(chain[chain.length - 1].bits).toBe(POW_LIMIT_BITS);
	});

	it('should cap long gaps at MAX_RETARGET_SPACING and treat negative spacing as on-target', () => {
		const tight = simulate(new Array<number>(20).fill(T / 4));
		const base = tight[tight.length - 1].bits;
		const after = (spacing: number) => {
			const chain = [...tight];
			const prev = chain[chain.length - 1];
			const coinbase = Transaction.coinbase(ADDRESS, COIN, chain.length);
			chain.push(new Block(prev.timestamp + spacing, [coinbase], prev.hash, 0, base, chain.length));
			return requiredBits(chain, chain.length, false);
		};
		expect(after(100 * T)).toBe(after(10 * T)); // capped
		expect(ratio(after(-T), base)).toBeCloseTo(ratio(after(T), base), 6); // negative → T
	});

	it('should retarget PoW and PoS independently', () => {
		// Pattern [pow, pos, pos]: PoW blocks are exactly T apart, PoS blocks average T/2
		const s = T / 10;
		const kinds: ('pow' | 'pos')[] = [];
		const spacings: number[] = [];
		for (let i = 0; i < 12; i++) {
			kinds.push('pow', 'pos', 'pos');
			spacings.push(T - 2 * s, s, s);
		}
		const chain = simulate(spacings, kinds);
		const pos = chain.filter((b) => b.isProofOfStake());
		const pow = chain.filter((b, i) => i > 0 && b.isProofOfWork());

		expect(pos[0].bits).toBe(POS_LIMIT_BITS);
		expect(ratio(pow[pow.length - 1].bits, POW_LIMIT_BITS)).toBeGreaterThan(0.999);
		expect(ratio(pos[pos.length - 1].bits, POS_LIMIT_BITS)).toBeLessThan(0.9);
	});

	it('should depend only on header data', () => {
		const chain = simulate(new Array<number>(12).fill(T / 3));
		const first = requiredBits(chain, chain.length, false);
		const copy = chain.map((b) => Block.fromJSON(JSON.parse(JSON.stringify(b))));
		expect(requiredBits(copy, copy.length, false)).toBe(first);
	});
});

describe('PoW phase length (TASK-0051)', () => {
	/** The PoW phase mined at a constant hash rate, each block taking its expected time under the retarget. */
	function powPhase(hashesPerSecond: number): Block[] {
		const chain = [new Block(1_700_000_000_000, [Transaction.coinbase('genesis', 0n, 0)], NULL_HASH)];
		for (let height = 1; height <= POW_CUTOFF_BLOCK; height++) {
			const bits = requiredBits(chain, height, false);
			const ms = Math.max(1, Math.round((Number(blockWork(bits)) / hashesPerSecond) * 1000));
			const prev = chain[height - 1];
			const coinbase = Transaction.coinbase(ADDRESS, 10n * COIN, height);
			chain.push(new Block(prev.timestamp + ms, [coinbase], prev.hash, 0, bits, height));
		}
		return chain;
	}

	// A slow JavaScript miner to a fast native one: the faster, the longer the first blocks come quickly
	it.each([
		['10 kH/s', 1e4],
		['1 MH/s', 1e6],
		['1 GH/s', 1e9],
	])('should outlast the stake age at %s, so the first coins can stake when it ends', (_, hashesPerSecond) => {
		const chain = powPhase(hashesPerSecond);
		const length = chain[POW_CUTOFF_BLOCK].timestamp - chain[1].timestamp;
		expect(length).toBeGreaterThan(STAKE_MIN_AGE * 1000); // block 1's coinbase is old enough to stake
	});
});
