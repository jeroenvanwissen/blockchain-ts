import { MIN_RELAY_FEE_PER_KB } from '../config.js';

/** Smallest fee the mempool accepts for a transaction of `size` bytes (rounded up). */
export function minRelayFee(size: number, perKb: bigint = MIN_RELAY_FEE_PER_KB): bigint {
	return (BigInt(size) * perKb + 999n) / 1000n;
}
