import * as crypto from 'crypto';
import { ENGLISH_WORDLIST } from './bip39Wordlist.js';

/**
 * BIP39 mnemonics with the English word list. Entropy of 16 to 32 bytes is followed by the first
 * bits of its SHA-256 (one per 4 bytes) and written as one word per 11 bits, so 32 bytes make 24
 * words. The BIP32 seed is PBKDF2-HMAC-SHA512 of the words (2048 rounds, salt "mnemonic" plus an
 * optional passphrase).
 */

const WORD_INDEX = new Map(ENGLISH_WORDLIST.map((word, index) => [word, index]));
const SEED_ROUNDS = 2048;

/** A phrase that isn't a valid BIP39 mnemonic; the message says why without repeating it. */
export class MnemonicError extends Error {}

function bitString(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(2).padStart(8, '0')).join('');
}

/** The words for `entropy` (16 to 32 bytes, a multiple of 4). */
export function entropyToMnemonic(entropy: Uint8Array): string {
	if (entropy.length < 16 || entropy.length > 32 || entropy.length % 4 !== 0) {
		throw new Error('entropy must be 16 to 32 bytes, a multiple of 4');
	}
	const checksum = bitString(crypto.createHash('sha256').update(entropy).digest()).slice(0, entropy.length / 4);
	const bits = bitString(entropy) + checksum;
	const words: string[] = [];
	for (let i = 0; i < bits.length; i += 11) words.push(ENGLISH_WORDLIST[parseInt(bits.slice(i, i + 11), 2)]);
	return words.join(' ');
}

/** The words of a phrase, normalized: lower case, single spaces (NFKD, as BIP39 hashes them). */
export function mnemonicWords(phrase: string): string[] {
	return phrase.normalize('NFKD').toLowerCase().split(/\s+/).filter((word) => word.length > 0);
}

/** The entropy a mnemonic encodes; throws a MnemonicError for a wrong count, word or checksum. */
export function mnemonicToEntropy(phrase: string): Buffer {
	const words = mnemonicWords(phrase);
	if (words.length < 12 || words.length > 24 || words.length % 3 !== 0) {
		throw new MnemonicError(`expected 12, 15, 18, 21 or 24 words, got ${words.length}`);
	}
	let bits = '';
	words.forEach((word, i) => {
		const index = WORD_INDEX.get(word);
		if (index === undefined) throw new MnemonicError(`word ${i + 1} is not in the BIP39 English word list`);
		bits += index.toString(2).padStart(11, '0');
	});
	const entropy = Buffer.alloc((bits.length - words.length / 3) / 8); // 3 words = 32 bits + 1 checksum bit
	for (let i = 0; i < entropy.length; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
	if (entropyToMnemonic(entropy) !== words.join(' ')) {
		entropy.fill(0);
		throw new MnemonicError("the words don't match their checksum: check their spelling and order");
	}
	return entropy;
}

/** The 64-byte BIP32 seed for a mnemonic (and optional BIP39 passphrase). */
export function mnemonicToSeed(phrase: string, passphrase = ''): Buffer {
	const salt = `mnemonic${passphrase.normalize('NFKD')}`;
	return crypto.pbkdf2Sync(mnemonicWords(phrase).join(' '), salt, SEED_ROUNDS, 64, 'sha512');
}
