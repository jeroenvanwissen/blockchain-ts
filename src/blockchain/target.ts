import { POS_LIMIT, POW_LIMIT } from '../config.js';

// Compact ("bits") encoding of 256-bit targets, as in Bitcoin's nBits: one size byte
// (length of the target in bytes) and a 3-byte mantissa. Decoding truncates, so
// bitsToTarget(targetToBits(t)) <= t.

const TWO_256 = 1n << 256n;

export function bitsToTarget(bits: number): bigint {
	const size = bits >>> 24;
	const mantissa = BigInt(bits & 0x007fffff);
	if (bits & 0x00800000) return 0n; // negative targets are invalid
	return size <= 3 ? mantissa >> BigInt(8 * (3 - size)) : mantissa << BigInt(8 * (size - 3));
}

export function targetToBits(target: bigint): number {
	if (target <= 0n) return 0;
	let size = Math.ceil(target.toString(16).length / 2);
	let mantissa = size <= 3 ? target << BigInt(8 * (3 - size)) : target >> BigInt(8 * (size - 3));
	// The mantissa's top bit is a sign bit: shift it out of the way
	if (mantissa & 0x800000n) {
		mantissa >>= 8n;
		size += 1;
	}
	return ((size << 24) | Number(mantissa)) >>> 0;
}

/** Expected number of hashes to find a block at this target: 2^256 / (target + 1). */
export function blockWork(bits: number): bigint {
	const target = bitsToTarget(bits);
	return target > 0n ? TWO_256 / (target + 1n) : 0n;
}

/** Target as 64 lowercase hex chars, comparable to a block hash with string comparison. */
export function targetHex(bits: number): string {
	return bitsToTarget(bits).toString(16).padStart(64, '0');
}

export const POW_LIMIT_BITS = targetToBits(POW_LIMIT);
export const POS_LIMIT_BITS = targetToBits(POS_LIMIT);
/** Easiest encodable target; used only when difficulty validation is off (tests). */
export const MAX_TARGET_BITS = targetToBits(TWO_256 - 1n);
