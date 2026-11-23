import * as crypto from 'crypto';
import { addressFromPublicKey, base58Decode, isValidAddress } from '../address.js';
import { secp256k1 } from '../secp256k1.js';
import { NULL_HASH, Transaction } from '../Transaction.js';
import { COIN } from '../../config.js';

// secp256k1 group order, for building a high-S (malleated) signature
const CURVE_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

// Loosely typed JSON wire form, for tests that corrupt it
type Wire = {
	inputs: Record<string, unknown>[];
	outputs?: Record<string, unknown>[];
	timestamp: unknown;
};

function newKey(): { privateKey: Buffer; publicKey: Buffer; address: string } {
	let privateKey: Buffer;
	do {
		privateKey = crypto.randomBytes(32);
	} while (!secp256k1.privateKeyVerify(privateKey));
	const publicKey = Buffer.from(secp256k1.publicKeyCreate(privateKey, true));
	return { privateKey, publicKey, address: addressFromPublicKey(publicKey) };
}

function spend(to: string, amount = 5n * COIN): Transaction {
	return new Transaction(
		[{ previousTx: 'ab'.repeat(32), outputIndex: 1, publicKey: '', signature: '' }],
		[{ address: to, amount }],
		1_700_000_000_000,
	);
}

describe('Transaction', () => {
	describe('hashing', () => {
		it('should keep the txid unchanged when the transaction is signed', () => {
			const key = newKey();
			const tx = spend(key.address);
			const unsignedTxid = tx.calculateHash();
			const unsignedWitnessHash = tx.witnessHash();

			tx.signTransaction(key.privateKey);

			expect(tx.calculateHash()).toBe(unsignedTxid);
			expect(tx.witnessHash()).not.toBe(unsignedWitnessHash);
		});

		it('should give coinbases at different heights different txids', () => {
			const address = newKey().address;
			const a = Transaction.coinbase(address, 10n * COIN, 1, 1_700_000_000_000);
			const b = Transaction.coinbase(address, 10n * COIN, 2, 1_700_000_000_000);
			expect(a.calculateHash()).not.toBe(b.calculateHash());
		});

		it('should refuse to encode amounts outside uint64', () => {
			const address = newKey().address;
			expect(() => spend(address, -1n).calculateHash()).toThrow('output amount out of range');
			expect(() => spend(address, 1n << 64n).calculateHash()).toThrow('output amount out of range');
		});

		it('should refuse to encode a non-hex previous transaction hash', () => {
			const tx = spend(newKey().address);
			tx.inputs[0].previousTx = 'not-a-hash';
			expect(() => tx.calculateHash()).toThrow('invalid previous transaction hash');
		});
	});

	describe('signatures', () => {
		it('should validate a correctly signed transaction', () => {
			const key = newKey();
			const tx = spend(key.address);
			tx.signTransaction(key.privateKey);

			expect(tx.inputs[0].publicKey).toBe(key.publicKey.toString('hex'));
			expect(tx.isValid()).toBe(true);
			expect(() => tx.validate()).not.toThrow();
		});

		it('should invalidate the signature when an output changes after signing', () => {
			const key = newKey();
			const tx = spend(key.address);
			tx.signTransaction(key.privateKey);

			tx.outputs[0].amount += 1n;

			expect(tx.isValid()).toBe(false);
			expect(() => tx.validate()).toThrow('invalid input signature');
		});

		it('should invalidate the signature when the spent outpoint changes after signing', () => {
			const key = newKey();
			const tx = spend(key.address);
			tx.signTransaction(key.privateKey);

			tx.inputs[0].outputIndex = 2;

			expect(tx.isValid()).toBe(false);
		});

		it('should reject a signature checked against a different public key', () => {
			const key = newKey();
			const tx = spend(key.address);
			tx.signTransaction(key.privateKey);

			tx.inputs[0].publicKey = newKey().publicKey.toString('hex');

			expect(tx.isValid()).toBe(false);
		});

		it('should reject a high-S (malleated) signature', () => {
			const key = newKey();
			const tx = spend(key.address);
			tx.signTransaction(key.privateKey);
			const sig = tx.inputs[0].signature;
			const s = BigInt('0x' + sig.slice(64));
			tx.inputs[0].signature = sig.slice(0, 64) + (CURVE_ORDER - s).toString(16).padStart(64, '0');

			expect(tx.isValid()).toBe(false);
		});

		it('should bind each signature to its input position', () => {
			const key = newKey();
			const tx = new Transaction(
				[
					{ previousTx: 'ab'.repeat(32), outputIndex: 0, publicKey: '', signature: '' },
					{ previousTx: 'cd'.repeat(32), outputIndex: 0, publicKey: '', signature: '' },
				],
				[{ address: key.address, amount: COIN }],
			);
			tx.signTransaction(key.privateKey);

			const [first, second] = tx.inputs.map((i) => i.signature);
			tx.inputs[0].signature = second;
			tx.inputs[1].signature = first;

			expect(tx.isValid()).toBe(false);
		});
	});

	describe('JSON wire format', () => {
		it('should round-trip with the same txid, witness hash and bigint amounts', () => {
			const key = newKey();
			const tx = spend(key.address, (1n << 60n) + 7n); // beyond Number.MAX_SAFE_INTEGER
			tx.signTransaction(key.privateKey);

			const received = Transaction.fromJSON(JSON.parse(JSON.stringify(tx)));

			expect(received.calculateHash()).toBe(tx.calculateHash());
			expect(received.witnessHash()).toBe(tx.witnessHash());
			expect(received.outputs[0].amount).toBe((1n << 60n) + 7n);
			expect(received.isValid()).toBe(true);
		});

		it.each([
			['a numeric amount', (o: Wire) => (o.outputs![0].amount = 5)],
			['a negative amount', (o: Wire) => (o.outputs![0].amount = '-5')],
			['an amount above uint64', (o: Wire) => (o.outputs![0].amount = (1n << 64n).toString())],
			['a non-hex previous hash', (o: Wire) => (o.inputs[0].previousTx = 'zz'.repeat(32))],
			['a fractional timestamp', (o: Wire) => (o.timestamp = 1.5)],
			['a missing outputs array', (o: Wire) => delete o.outputs],
			['a malformed signature', (o: Wire) => (o.inputs[0].signature = 'abc')],
		])('should reject %s', (_name, mutate) => {
			const key = newKey();
			const tx = spend(key.address);
			tx.signTransaction(key.privateKey);
			const wire = JSON.parse(JSON.stringify(tx)) as Wire;
			mutate(wire);

			expect(() => Transaction.fromJSON(wire)).toThrow('malformed transaction');
		});
	});

	describe('classification', () => {
		it('should recognise coinbase and coinstake shapes', () => {
			const address = newKey().address;
			const coinbase = Transaction.coinbase(address, COIN, 5);
			const coinstake = new Transaction(
				[{ previousTx: 'ab'.repeat(32), outputIndex: 0, publicKey: '', signature: '' }],
				[
					{ address, amount: 0n },
					{ address, amount: COIN },
				],
			);

			expect(coinbase.isCoinbase()).toBe(true);
			expect(coinbase.isCoinStake()).toBe(false);
			expect(coinbase.inputs[0].previousTx).toBe(NULL_HASH);
			expect(coinstake.isCoinbase()).toBe(false);
			expect(coinstake.isCoinStake()).toBe(true);
		});

		it('should reject a non-coinbase spending the null outpoint', () => {
			const key = newKey();
			const tx = new Transaction(
				[{ previousTx: NULL_HASH, outputIndex: 0, publicKey: '', signature: '' }],
				[
					{ address: key.address, amount: COIN },
					{ address: key.address, amount: COIN },
				],
			);
			tx.signTransaction(key.privateKey);

			expect(() => tx.validate()).toThrow('only a coinbase may spend the null outpoint');
		});
	});
});

describe('address', () => {
	it('should derive the standard P2PKH address (private key 1 test vector)', () => {
		const publicKey = Buffer.from(
			'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
			'hex',
		);
		expect(addressFromPublicKey(publicKey)).toBe('1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH');
	});

	it('should validate checksums and reject malformed addresses', () => {
		const address = newKey().address;
		const lastChar = address.slice(-1) === '1' ? '2' : '1';

		expect(isValidAddress(address)).toBe(true);
		expect(isValidAddress(address.slice(0, -1) + lastChar)).toBe(false);
		expect(isValidAddress('0OIl')).toBe(false); // characters outside Base58
		expect(isValidAddress('genesis')).toBe(false);
		expect(base58Decode('0')).toBeNull();
	});
});
