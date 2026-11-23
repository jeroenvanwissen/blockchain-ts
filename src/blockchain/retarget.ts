import type { Block } from './Block.js';
import {
	MAX_RETARGET_SPACING,
	POS_LIMIT,
	POW_LIMIT,
	RETARGET_WINDOW,
	TARGET_SPACING,
} from '../config.js';
import { bitsToTarget, targetToBits } from './target.js';

/** Index of the last block at or below `from` of the given type; 0 (genesis) if none. */
function lastOfType(chain: readonly Block[], from: number, proofOfStake: boolean): number {
	for (let i = from; i > 0; i--) {
		if (chain[i].isProofOfStake() === proofOfStake) return i;
	}
	return 0;
}

/**
 * Compact target required for the block at `height`: a Peercoin-style per-block retarget
 * that moves the previous target of the same type toward TARGET_SPACING,
 *   next = prev × ((N − 1)·T + 2·actual) / ((N + 1)·T),   N = RETARGET_WINDOW,
 * where `actual` is the spacing of the last two blocks of that type (negative → T,
 * capped at MAX_RETARGET_SPACING). PoW and PoS retarget independently, each capped at its
 * limit. Reads only header data (timestamps, bits, type) of chain[0..height-1].
 */
export function requiredBits(chain: readonly Block[], height: number, proofOfStake: boolean): number {
	const limit = proofOfStake ? POS_LIMIT : POW_LIMIT;
	const prev = lastOfType(chain, height - 1, proofOfStake);
	if (prev === 0) return targetToBits(limit); // no earlier block of this type
	const prevPrev = lastOfType(chain, prev - 1, proofOfStake);
	if (prevPrev === 0) return targetToBits(limit); // only one earlier block of this type

	let actual = chain[prev].timestamp - chain[prevPrev].timestamp;
	if (actual < 0) actual = TARGET_SPACING;
	if (actual > MAX_RETARGET_SPACING) actual = MAX_RETARGET_SPACING;

	const n = BigInt(RETARGET_WINDOW);
	const spacing = BigInt(TARGET_SPACING);
	let target =
		(bitsToTarget(chain[prev].bits) * ((n - 1n) * spacing + 2n * BigInt(actual))) /
		((n + 1n) * spacing);
	if (target <= 0n || target > limit) target = limit;
	return targetToBits(target);
}
