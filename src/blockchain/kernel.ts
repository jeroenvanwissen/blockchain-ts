import * as crypto from 'crypto';
import { bitsToTarget } from './target.js';
import { NULL_HASH } from './Transaction.js';

// Kernel proof of stake (Peercoin/BlackCoin v3 style). A UTXO may stake a block at time t when
//   sha256d(stakeModifier ‖ prevTxTime ‖ prevTxHash ‖ prevOutputIndex ‖ t) ≤ target(bits) × value
// The stake modifier changes every block and is unknown when the UTXO is created, so future
// kernels can't be precomputed.

/** Stake modifier before the first block (genesis). */
export const GENESIS_STAKE_MODIFIER = NULL_HASH;

function sha256d(data: Buffer): Buffer {
	const first = crypto.createHash('sha256').update(data).digest();
	return crypto.createHash('sha256').update(first).digest();
}

export function kernelHash(
	stakeModifier: string,
	prevTxTime: number,
	prevTxHash: string,
	prevOutputIndex: number,
	blockTime: number,
): string {
	const data = Buffer.alloc(32 + 8 + 32 + 4 + 8);
	Buffer.from(stakeModifier, 'hex').copy(data, 0);
	data.writeBigUInt64LE(BigInt(prevTxTime), 32);
	Buffer.from(prevTxHash, 'hex').copy(data, 40);
	data.writeUInt32LE(prevOutputIndex, 72);
	data.writeBigUInt64LE(BigInt(blockTime), 76);
	return sha256d(data).toString('hex');
}

/** Chances scale with the staked value: the effective target is target × value. */
export function meetsKernelTarget(hash: string, bits: number, value: bigint): boolean {
	return BigInt('0x' + hash) <= bitsToTarget(bits) * value;
}

/** Modifier after a block: sha256d(proof ‖ previous), proof = kernel hash (PoS) or block hash (PoW). */
export function nextStakeModifier(proof: string, previousModifier: string): string {
	return sha256d(Buffer.from(proof + previousModifier, 'hex')).toString('hex');
}
