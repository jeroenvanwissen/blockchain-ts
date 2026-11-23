import { AddressBook } from '../AddressBook.js';
import { ADDRESS_RETRY_BASE, MAX_ADDRESS_FAILURES } from '../../config.js';

/** Deterministic random numbers (a small LCG), so shuffles are reproducible. */
function seeded(seed = 1): () => number {
	let state = seed;
	return () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
}

const url = (i: number) => `ws://10.0.0.${i}:5001`;

describe('AddressBook', () => {
	it('should replace only an address that failed and never worked when full', () => {
		const book = new AddressBook(3, seeded());
		[1, 2, 3].forEach((i) => book.addLearned(url(i)));
		book.markSuccess(url(1), 1_000);

		expect(book.addLearned(url(4))).toBe(false); // nothing has failed: the flood waits
		book.markFailure(url(1), 2_000); // worked before: kept
		expect(book.addLearned(url(4))).toBe(false);

		book.markFailure(url(2), 2_000); // never worked and failed: replaceable
		expect(book.addLearned(url(4))).toBe(true);
		expect(book.has(url(2))).toBe(false);
		expect(book.size).toBe(3);
	});

	it(`should drop learned addresses after ${MAX_ADDRESS_FAILURES} failures in a row, but never configured ones`, () => {
		const book = new AddressBook(10, seeded());
		book.addLearned(url(1));
		book.addConfigured(url(2));

		for (let i = 1; i < MAX_ADDRESS_FAILURES; i++) expect(book.markFailure(url(1), i)).toBe(false);
		book.markSuccess(url(1), 100); // a success resets the count
		for (let i = 1; i < MAX_ADDRESS_FAILURES; i++) book.markFailure(url(1), 100 + i);
		expect(book.has(url(1))).toBe(true);
		expect(book.markFailure(url(1), 200)).toBe(true);
		expect(book.has(url(1))).toBe(false);

		for (let i = 0; i < 2 * MAX_ADDRESS_FAILURES; i++) book.markFailure(url(2), i);
		expect(book.has(url(2))).toBe(true);
	});

	it('should offer verified addresses first, in random order, and hold back failing ones until their wait passes', () => {
		const book = new AddressBook(20, seeded(7));
		for (let i = 1; i <= 8; i++) book.addLearned(url(i));
		[2, 5, 7].forEach((i) => book.markSuccess(url(i), 1_000));
		book.markFailure(url(8), 10_000); // waits ADDRESS_RETRY_BASE

		const now = 10_000 + ADDRESS_RETRY_BASE - 1;
		const candidates = book.candidates(now);
		expect(new Set(candidates.slice(0, 3))).toEqual(new Set([url(2), url(5), url(7)]));
		expect(new Set(candidates.slice(3))).toEqual(new Set([1, 3, 4, 6].map(url)));
		expect(book.candidates(now + 1)).toContain(url(8));

		// The order within a group is random: same addresses, different random source
		const order = (seed: number) => {
			const fresh = new AddressBook(20, seeded(seed));
			for (let i = 1; i <= 8; i++) fresh.addLearned(url(i));
			return fresh.candidates(0);
		};
		expect(order(7)).not.toEqual(order(99));
		expect(new Set(order(7))).toEqual(new Set(order(99)));
	});

	it('should share only configured and verified addresses, at most the requested number', () => {
		const book = new AddressBook(50, seeded());
		for (let i = 1; i <= 40; i++) book.addLearned(url(i));
		book.addConfigured(url(100));
		for (let i = 1; i <= 35; i++) book.markSuccess(url(i), 1);

		const shared = book.shareable(32);
		expect(shared).toHaveLength(32);
		for (const address of shared) expect([...Array.from({ length: 35 }, (_, i) => url(i + 1)), url(100)]).toContain(address);
		expect(book.shareable(100)).not.toContain(url(36)); // learned, never verified
	});

	it('should list verified and configured addresses first for saving', () => {
		const book = new AddressBook(10, seeded());
		book.addLearned(url(1));
		book.addLearned(url(2));
		book.addConfigured(url(3));
		book.markSuccess(url(2), 1);

		expect(book.all().slice(0, 2).sort()).toEqual([url(2), url(3)].sort());
		expect(book.all()[2]).toBe(url(1));
	});
});
