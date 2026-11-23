import {
	ADDRESS_RETRY_BASE,
	ADDRESS_RETRY_MAX,
	MAX_ADDRESS_FAILURES,
	MAX_KNOWN_PEERS,
} from '../config.js';

/** Configured addresses come from the operator (CLI, seeds); learned ones from the network. */
export type AddressSource = 'configured' | 'learned';

interface AddressEntry {
	source: AddressSource;
	failures: number; // consecutive failed dials or handshakes
	lastAttempt: number; // ms, 0 = never dialed
	lastSuccess: number; // ms, 0 = never completed a handshake
}

/**
 * Peer addresses the node knows (TASK-0039). Learned addresses can't crowd out ones that work:
 * when the book is full, a new address only replaces one that has failed and never worked, and
 * learned addresses are dropped after MAX_ADDRESS_FAILURES failures in a row. Outbound peers
 * are chosen at random, verified addresses first, so whoever floods addresses can't decide
 * whom the node dials. Only configured or verified addresses are passed on to other peers.
 */
export class AddressBook {
	private readonly _entries = new Map<string, AddressEntry>();

	constructor(
		private readonly _capacity: number = MAX_KNOWN_PEERS,
		private readonly _random: () => number = Math.random,
	) {}

	get size(): number {
		return this._entries.size;
	}

	has(url: string): boolean {
		return this._entries.has(url);
	}

	/** An operator-given address: always kept, never evicted. */
	addConfigured(url: string): void {
		const entry = this._entries.get(url);
		if (entry) entry.source = 'configured';
		else this._entries.set(url, { source: 'configured', failures: 0, lastAttempt: 0, lastSuccess: 0 });
	}

	/**
	 * An address learned from a peer, an inbound connection or the saved list. When full, it
	 * replaces an address that has failed and never worked; otherwise it's ignored.
	 */
	addLearned(url: string): boolean {
		if (this._entries.has(url)) return false;
		if (this._entries.size >= this._capacity) {
			const victim = [...this._entries].find(([, e]) => e.source === 'learned' && e.failures > 0 && e.lastSuccess === 0);
			if (!victim) return false;
			this._entries.delete(victim[0]);
		}
		this._entries.set(url, { source: 'learned', failures: 0, lastAttempt: 0, lastSuccess: 0 });
		return true;
	}

	remove(url: string): boolean {
		return this._entries.delete(url);
	}

	/** A dial was started. */
	markAttempt(url: string, now: number): void {
		const entry = this._entries.get(url);
		if (entry) entry.lastAttempt = now;
	}

	/** The handshake completed: the address is verified. */
	markSuccess(url: string, now: number): void {
		const entry = this._entries.get(url);
		if (!entry) return;
		entry.failures = 0;
		entry.lastSuccess = now;
	}

	/** The dial or handshake failed. Returns true if the address was dropped. */
	markFailure(url: string, now: number): boolean {
		const entry = this._entries.get(url);
		if (!entry) return false;
		entry.failures++;
		entry.lastAttempt = now;
		if (entry.source === 'learned' && entry.failures >= MAX_ADDRESS_FAILURES) {
			this._entries.delete(url);
			return true;
		}
		return false;
	}

	/**
	 * Addresses worth dialing now: verified ones first, then untried and failing ones, each group
	 * in random order. Failing addresses wait ADDRESS_RETRY_BASE × 2^(failures−1), capped.
	 */
	candidates(now: number): string[] {
		const ready = [...this._entries].filter(([, e]) => {
			if (e.failures === 0) return true;
			const wait = Math.min(ADDRESS_RETRY_BASE * 2 ** (e.failures - 1), ADDRESS_RETRY_MAX);
			return now - e.lastAttempt >= wait;
		});
		const verified = ready.filter(([, e]) => e.lastSuccess > 0).map(([url]) => url);
		const other = ready.filter(([, e]) => e.lastSuccess === 0).map(([url]) => url);
		return [...this._shuffle(verified), ...this._shuffle(other)];
	}

	/** Addresses to pass on to peers: configured or verified ones, at most `max`, at random. */
	shareable(max: number): string[] {
		const known = [...this._entries].filter(([, e]) => e.source === 'configured' || e.lastSuccess > 0).map(([url]) => url);
		return this._shuffle(known).slice(0, max);
	}

	/** Every address, verified and configured ones first (for saving). */
	all(): string[] {
		const rank = (e: AddressEntry) => (e.lastSuccess > 0 || e.source === 'configured' ? 0 : 1);
		return [...this._entries].sort(([, a], [, b]) => rank(a) - rank(b)).map(([url]) => url);
	}

	private _shuffle(items: string[]): string[] {
		const result = [...items];
		for (let i = result.length - 1; i > 0; i--) {
			const j = Math.floor(this._random() * (i + 1));
			[result[i], result[j]] = [result[j], result[i]];
		}
		return result;
	}
}
