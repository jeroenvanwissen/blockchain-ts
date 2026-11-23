// BIP32 hierarchical deterministic keys (TASK-0041): one seed yields every wallet key, so a
// backup made once covers addresses created later. Standard algorithm and master-key constant,
// checked against the BIP32 test vectors.
import * as crypto from 'crypto';
import { secp256k1 } from './secp256k1.js';

/** Child indexes from this value up are hardened: derivable only from the private key. */
export const HARDENED = 0x8000_0000;

export interface ExtendedPrivateKey {
	privateKey: Buffer; // 32 bytes
	chainCode: Buffer; // 32 bytes
}

export interface ExtendedPublicKey {
	publicKey: Buffer; // 33 bytes, compressed
	chainCode: Buffer;
}

function hmacSha512(key: Buffer | string, data: Buffer): { left: Buffer; right: Buffer } {
	const digest = crypto.createHmac('sha512', key).update(data).digest();
	return { left: digest.subarray(0, 32), right: Buffer.from(digest.subarray(32)) };
}

/** Master key from a seed. Throws for the (probability ~2^-127) seeds without a valid key. */
export function masterKey(seed: Buffer): ExtendedPrivateKey {
	const { left, right } = hmacSha512('Bitcoin seed', seed);
	if (!secp256k1.privateKeyVerify(left)) throw new Error('seed gives no valid master key');
	return { privateKey: Buffer.from(left), chainCode: right };
}

/**
 * Private child `index` (hardened when ≥ HARDENED). Returns null for the indexes BIP32 says to
 * skip (probability ~2^-127 each); the public derivation skips the same ones.
 */
export function derivePrivate(parent: ExtendedPrivateKey, index: number): ExtendedPrivateKey | null {
	const data = Buffer.alloc(37);
	if (index >= HARDENED) parent.privateKey.copy(data, 1);
	else Buffer.from(secp256k1.publicKeyCreate(parent.privateKey, true)).copy(data);
	data.writeUInt32BE(index, 33);
	const { left, right } = hmacSha512(parent.chainCode, data);
	try {
		// Tweaks the copy in place; throws when left ≥ n or the sum is zero
		return { privateKey: Buffer.from(secp256k1.privateKeyTweakAdd(Buffer.from(parent.privateKey), left)), chainCode: right };
	} catch {
		return null;
	} finally {
		data.fill(0);
	}
}

/** Public child `index` of a public key (non-hardened only); null for indexes BIP32 skips. */
export function derivePublic(parent: ExtendedPublicKey, index: number): ExtendedPublicKey | null {
	if (!Number.isInteger(index) || index < 0 || index >= HARDENED) {
		throw new Error('public derivation needs a non-hardened index');
	}
	const data = Buffer.alloc(37);
	parent.publicKey.copy(data);
	data.writeUInt32BE(index, 33);
	const { left, right } = hmacSha512(parent.chainCode, data);
	try {
		return { publicKey: Buffer.from(secp256k1.publicKeyTweakAdd(parent.publicKey, left, true)), chainCode: right };
	} catch {
		return null;
	}
}

/** The public half of an extended private key. */
export function neuter(key: ExtendedPrivateKey): ExtendedPublicKey {
	return { publicKey: Buffer.from(secp256k1.publicKeyCreate(key.privateKey, true)), chainCode: key.chainCode };
}

/** Follow a path of child indexes from `key`; throws if one must be skipped. */
export function derivePath(key: ExtendedPrivateKey, path: number[]): ExtendedPrivateKey {
	let current = key;
	for (const index of path) {
		const child = derivePrivate(current, index);
		if (!child) throw new Error(`index ${index} gives no valid key`);
		current = child;
	}
	return current;
}
