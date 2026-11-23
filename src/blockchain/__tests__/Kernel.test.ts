import { GENESIS_STAKE_MODIFIER, kernelHash, meetsKernelTarget, nextStakeModifier } from '../kernel.js';
import { targetToBits } from '../target.js';
import { NULL_HASH } from '../Transaction.js';

describe('kernel', () => {
	const base = ['ab'.repeat(32), 1_700_000_000_000, 'cd'.repeat(32), 1, 1_700_000_016_000] as const;

	it('should depend on every kernel input', () => {
		const reference = kernelHash(...base);
		const variants = [
			kernelHash('ef'.repeat(32), base[1], base[2], base[3], base[4]),
			kernelHash(base[0], base[1] + 1, base[2], base[3], base[4]),
			kernelHash(base[0], base[1], 'ee'.repeat(32), base[3], base[4]),
			kernelHash(base[0], base[1], base[2], base[3] + 1, base[4]),
			kernelHash(base[0], base[1], base[2], base[3], base[4] + 16_000),
		];
		expect(new Set([reference, ...variants]).size).toBe(6);
		expect(kernelHash(...base)).toBe(reference); // deterministic
	});

	it('should scale the effective target with the staked value', () => {
		const bits = targetToBits(1n << 200n);
		const hash = (3n << 200n).toString(16).padStart(64, '0');
		expect(meetsKernelTarget(hash, bits, 2n)).toBe(false);
		expect(meetsKernelTarget(hash, bits, 3n)).toBe(true);
		expect(meetsKernelTarget(hash, bits, 0n)).toBe(false);
	});

	it('should chain stake modifiers from the proof and the previous modifier', () => {
		expect(GENESIS_STAKE_MODIFIER).toBe(NULL_HASH);
		const first = nextStakeModifier('ab'.repeat(32), GENESIS_STAKE_MODIFIER);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(nextStakeModifier('ab'.repeat(32), GENESIS_STAKE_MODIFIER)).toBe(first);
		expect(nextStakeModifier('cd'.repeat(32), GENESIS_STAKE_MODIFIER)).not.toBe(first);
		expect(nextStakeModifier('ab'.repeat(32), first)).not.toBe(first);
	});
});
