// Seed phrases (TASK-0049): new wallets have a 24-word BIP39 phrase that restores every
// address; wallets from before keep working without one. Real files in a temp dir.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import protobuf from 'protobufjs';
import { addressFromPublicKey } from '../../blockchain/address.js';
import { MnemonicError } from '../../blockchain/bip39.js';
import { HARDENED, derivePath, derivePublic, masterKey, neuter } from '../../blockchain/hd.js';
import { WALLET_SCHEMA } from '../../blockchain/protoSchemas.js';
import { secp256k1 } from '../../blockchain/secp256k1.js';
import { Wallet, WalletError } from '../../blockchain/Wallet.js';
import { makeTempDir, removeTempDir } from './helpers.js';

const PASSPHRASE = 'seed phrase test passphrase';
const walletType = () => protobuf.parse(WALLET_SCHEMA).root.lookupType('WalletData');
const stored = (file: string) => walletType().toObject(walletType().decode(fs.readFileSync(file))) as Record<string, unknown>;
const write = (file: string, fields: Record<string, unknown>) =>
	fs.writeFileSync(file, walletType().encode(walletType().fromObject(fields)).finish(), { mode: 0o600 });

function expectWalletError(action: () => unknown, code: string): void {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(WalletError);
		expect((error as WalletError).code).toBe(code);
		return;
	}
	throw new Error(`expected WalletError ${code}`);
}

describe('Wallet seed phrase', () => {
	let dir: string;
	const file = (name: string) => path.join(dir, name);

	beforeEach(() => {
		jest.spyOn(console, 'log').mockImplementation(() => {});
		dir = makeTempDir();
	});

	afterEach(() => {
		jest.restoreAllMocks();
		removeTempDir(dir);
	});

	it('should restore the same addresses and keys from the 24 words', () => {
		const original = new Wallet(file('original.dat'));
		const handedOut = [original.newAddress(), original.newAddress()];
		const phrase = original.seedPhrase();
		expect(original.hasSeedPhrase()).toBe(true);
		expect(phrase.split(' ')).toHaveLength(24);
		expect(stored(file('original.dat')).seedFormat).toBe(1);

		const restored = Wallet.restore(phrase, file('restored.dat'));

		expect(restored.address).toBe(original.address);
		for (const address of handedOut) expect(restored.owns(address)).toBe(true); // in the lookahead
		expect(restored.addresses().slice(0, 21)).toEqual(original.addresses().slice(0, 21));
		const digest = crypto.randomBytes(32);
		expect(restored.signDigest(digest, handedOut[1])).toBe(original.signDigest(digest, handedOut[1]));
		expect(restored.seedPhrase()).toBe(phrase);
		expect(new Wallet(file('restored.dat')).address).toBe(original.address); // as saved
	});

	it('should restore straight into an encrypted wallet without writing the seed unencrypted', () => {
		const original = new Wallet(file('original.dat'));
		const phrase = original.seedPhrase();
		expect(() => Wallet.restore(phrase, file('weak.dat'), 'short')).toThrow(WalletError);
		expect(fs.existsSync(file('weak.dat'))).toBe(false); // nothing written

		const restored = Wallet.restore(phrase, file('restored.dat'), PASSPHRASE);

		expect(restored.isLocked()).toBe(true);
		expect(stored(file('restored.dat')).seed).toBeUndefined();
		const entropy = Buffer.from(stored(file('original.dat')).seed as Uint8Array); // the unencrypted original's
		expect(entropy).toHaveLength(32);
		expect(fs.readFileSync(file('restored.dat')).includes(entropy)).toBe(false);
		const reloaded = new Wallet(file('restored.dat'));
		reloaded.unlock(PASSPHRASE);
		expect(reloaded.address).toBe(original.address);
		expect(reloaded.seedPhrase(PASSPHRASE)).toBe(phrase);
	});

	it('should refuse words that are not a 24-word phrase, and never replace a wallet file', () => {
		const phrase = new Wallet(file('original.dat')).seedPhrase();
		const words = phrase.split(' ');
		const reversed = [...words].reverse().join(' ');

		expect(() => Wallet.restore(words.slice(0, 12).join(' '), file('a.dat'))).toThrow('expected 24 words, got 12');
		expect(() => Wallet.restore(reversed, file('a.dat'))).toThrow(MnemonicError);
		expect(fs.existsSync(file('a.dat'))).toBe(false);

		const before = fs.readFileSync(file('original.dat'));
		const other = new Wallet(file('other.dat')).seedPhrase();
		expect(() => Wallet.restore(other, file('original.dat'))).toThrow('already exists');
		expect(fs.readFileSync(file('original.dat')).equals(before)).toBe(true);
	});

	it("should show an encrypted wallet's phrase only with its passphrase, and leave it locked", () => {
		const wallet = new Wallet(file('wallet.dat'));
		const phrase = wallet.seedPhrase();
		wallet.encrypt(PASSPHRASE);
		expect(stored(file('wallet.dat')).seed).toBeUndefined(); // the entropy is only in the encrypted part

		expectWalletError(() => wallet.seedPhrase(), 'wrong-passphrase');
		expectWalletError(() => wallet.seedPhrase('not the passphrase'), 'wrong-passphrase');
		expect(wallet.seedPhrase(PASSPHRASE)).toBe(phrase);
		expect(wallet.isLocked()).toBe(true);

		const reloaded = new Wallet(file('wallet.dat'));
		reloaded.unlock(PASSPHRASE, { stakingOnly: true });
		expectWalletError(() => reloaded.seedPhrase(), 'wrong-passphrase'); // needed even while unlocked
		expect(reloaded.seedPhrase(PASSPHRASE)).toBe(phrase);
		expect(reloaded.isStakingOnly()).toBe(true);
	});

	it('should keep a wallet with a raw seed (before seed phrases) working, without a phrase', () => {
		// A wallet as TASK-0041 wrote it: a raw BIP32 seed, no seed format
		const seed = crypto.randomBytes(32);
		const account = derivePath(masterKey(seed), [HARDENED]);
		const receive = derivePublic(derivePublic(neuter(account), 0)!, 0)!; // m/0'/0/0: the primary address
		write(file('raw.dat'), {
			seed,
			accountPublicKey: neuter(account).publicKey,
			accountChainCode: account.chainCode,
			receiveCount: 1,
		});

		const wallet = new Wallet(file('raw.dat'));
		expect(wallet.address).toBe(addressFromPublicKey(receive.publicKey));
		expect(wallet.hasSeedPhrase()).toBe(false);
		expectWalletError(() => wallet.seedPhrase(), 'no-seed-phrase');

		wallet.encrypt(PASSPHRASE);
		const reloaded = new Wallet(file('raw.dat'));
		reloaded.unlock(PASSPHRASE);
		expect(reloaded.address).toBe(wallet.address);
		const digest = crypto.randomBytes(32);
		const signature = Buffer.from(reloaded.signDigest(digest), 'hex');
		expect(secp256k1.ecdsaVerify(signature, digest, receive.publicKey)).toBe(true);
		expect(stored(file('raw.dat')).seedFormat).toBeUndefined();
	});

	it('should not offer a phrase for a wallet whose primary address is an older single key', () => {
		const privateKey = crypto.randomBytes(32);
		const publicKey = Buffer.from(secp256k1.publicKeyCreate(privateKey, true));
		write(file('legacy.dat'), { privateKey, publicKey, address: addressFromPublicKey(publicKey) });

		const wallet = new Wallet(file('legacy.dat')); // upgraded: gets a seed for more addresses

		expect(wallet.address).toBe(addressFromPublicKey(publicKey));
		expect(wallet.hasSeedPhrase()).toBe(false);
		expect(() => wallet.seedPhrase()).toThrow('older single key');
	});

	it('should find a used address after up to 100 unused ones, but not further', () => {
		const original = new Wallet(file('original.dat'));
		const handedOut = Array.from({ length: 130 }, () => original.newAddress()); // indexes 1 to 130
		const phrase = original.seedPhrase();
		const near = Wallet.restore(phrase, file('near.dat'));
		expect(near.discoverUsedAddresses((address) => address === handedOut[99])).toBe(100); // index 100: 99 unused before it
		expect(near.owns(handedOut[119])).toBe(true); // the lookahead moved past it

		const far = Wallet.restore(phrase, file('far.dat'));
		expect(far.discoverUsedAddresses((address) => address === handedOut[101])).toBe(0); // 101 unused before it
		expect(far.issuedCount()).toBe(1);
	});

	it('should find used addresses past the lookahead after a restore', () => {
		const original = new Wallet(file('original.dat'));
		const handedOut = Array.from({ length: 45 }, () => original.newAddress()); // indexes 1 to 45
		const used = new Set([handedOut[4], handedOut[24], handedOut[43]]); // indexes 5, 25 and 44
		const restored = Wallet.restore(original.seedPhrase(), file('restored.dat'));
		expect(restored.owns(handedOut[43])).toBe(false); // beyond the 20-address lookahead

		expect(restored.discoverUsedAddresses((address) => used.has(address))).toBe(44);

		expect(restored.issuedCount()).toBe(45);
		for (const address of handedOut) expect(restored.owns(address)).toBe(true);
		expect(restored.discoverUsedAddresses((address) => used.has(address))).toBe(0);
		expect(new Wallet(file('restored.dat')).issuedCount()).toBe(45); // saved
	});
});
