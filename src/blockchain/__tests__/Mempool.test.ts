import { Mempool, type MempoolEntry } from '../Mempool.js';
import type { Transaction } from '../Transaction.js';

let next = 0;
/** An entry spending the given outpoints (only inputs matter to the mempool). */
function entry(fee: bigint, size: number, spends: string[] = [`${(next++).toString(16).padStart(64, '0')}:0`]): MempoolEntry {
	const inputs = spends.map((outpoint) => {
		const [previousTx, index] = outpoint.split(':');
		return { previousTx, outputIndex: Number(index), publicKey: '', signature: '' };
	});
	return { transaction: { inputs } as unknown as Transaction, txid: `tx${next++}`, fee, size };
}

describe('Mempool', () => {
	it('should reject a second spend of an outpoint and a duplicate, until the first is removed', () => {
		const pool = new Mempool(10_000);
		const first = entry(100n, 100, ['aa:0']);
		pool.add(first);

		expect(() => pool.add(entry(500n, 100, ['aa:0']))).toThrow('utxo already spent by pending transaction');
		expect(() => pool.add(first)).toThrow('transaction already in mempool');
		expect(pool.isSpent('aa', 0)).toBe(true);

		pool.remove(first.txid);
		expect(pool.isSpent('aa', 0)).toBe(false);
		expect(() => pool.add(entry(500n, 100, ['aa:0']))).not.toThrow();
	});

	it('should evict the lowest fee rates for a better-paying newcomer when full', () => {
		const pool = new Mempool(300);
		const low = entry(100n, 100); // 1 per byte
		const mid = entry(200n, 100); // 2 per byte
		const high = entry(300n, 100); // 3 per byte
		[low, mid, high].forEach((e) => pool.add(e));

		const better = entry(250n, 100); // 2.5 per byte: displaces only `low`
		expect(pool.add(better)).toEqual([low.txid]);
		expect(pool.bytes).toBe(300);
		expect(pool.get(low.txid)).toBeUndefined();

		// Not better than anything that would have to go: rejected, nothing evicted
		expect(() => pool.add(entry(200n, 100))).toThrow('fee rate is too low');
		expect(() => pool.add(entry(10_000n, 400))).toThrow('larger than the mempool');
		expect(pool.count).toBe(3);
	});

	it('should evict several small entries to fit a large one, only if it pays a higher rate than each', () => {
		const pool = new Mempool(300);
		const small = [entry(100n, 100), entry(110n, 100), entry(500n, 100)];
		small.forEach((e) => pool.add(e));

		expect(pool.add(entry(400n, 200))).toEqual([small[0].txid, small[1].txid]); // 2 per byte
		expect(pool.bytes).toBe(300);
	});

	it('should select the highest fee rates first, ties in arrival order, within count and size', () => {
		const pool = new Mempool(10_000);
		const a = entry(100n, 100); // 1
		const b = entry(400n, 100); // 4
		const c = entry(400n, 100); // 4, after b
		const big = entry(3000n, 1000); // 3, but too large for a 350-byte budget
		const d = entry(200n, 100); // 2
		[a, b, c, big, d].forEach((e) => pool.add(e));

		expect(pool.select(10, 10_000).map((e) => e.txid)).toEqual([b, c, big, d, a].map((e) => e.txid));
		expect(pool.select(2, 10_000).map((e) => e.txid)).toEqual([b.txid, c.txid]);
		expect(pool.select(10, 350).map((e) => e.txid)).toEqual([b.txid, c.txid, d.txid]); // skips big
		expect(pool.transactions()).toHaveLength(5); // selection doesn't remove anything
	});
});
