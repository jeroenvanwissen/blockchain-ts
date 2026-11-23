import * as crypto from 'crypto';

// Base58Check P2PKH-style addresses: version byte 0x00 + RIPEMD160(SHA256(publicKey)) + checksum.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ADDRESS_VERSION = 0x00;
const ADDRESS_LENGTH = 25; // version (1) + hash160 (20) + checksum (4)

function sha256(data: Buffer): Buffer {
	return crypto.createHash('sha256').update(data).digest();
}

export function hash160(data: Buffer): Buffer {
	return crypto.createHash('ripemd160').update(sha256(data)).digest();
}

export function base58Encode(buffer: Buffer): string {
	let num = BigInt('0x' + (buffer.toString('hex') || '0'));
	let result = '';
	while (num > 0n) {
		result = ALPHABET[Number(num % 58n)] + result;
		num /= 58n;
	}
	for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
		result = ALPHABET[0] + result;
	}
	return result;
}

/** Decode Base58; returns null for characters outside the alphabet. */
export function base58Decode(str: string): Buffer | null {
	let num = 0n;
	for (const char of str) {
		const digit = ALPHABET.indexOf(char);
		if (digit < 0) return null;
		num = num * 58n + BigInt(digit);
	}
	let hex = num === 0n ? '' : num.toString(16);
	if (hex.length % 2) hex = '0' + hex;
	let leadingZeros = 0;
	while (leadingZeros < str.length && str[leadingZeros] === ALPHABET[0]) leadingZeros++;
	return Buffer.concat([Buffer.alloc(leadingZeros), Buffer.from(hex, 'hex')]);
}

function checksum(payload: Buffer): Buffer {
	return sha256(sha256(payload)).subarray(0, 4);
}

export function addressFromPublicKey(publicKey: Buffer): string {
	const payload = Buffer.concat([Buffer.from([ADDRESS_VERSION]), hash160(publicKey)]);
	return base58Encode(Buffer.concat([payload, checksum(payload)]));
}

export function isValidAddress(address: string): boolean {
	const decoded = base58Decode(address);
	if (!decoded || decoded.length !== ADDRESS_LENGTH || decoded[0] !== ADDRESS_VERSION) {
		return false;
	}
	return checksum(decoded.subarray(0, 21)).equals(decoded.subarray(21));
}
