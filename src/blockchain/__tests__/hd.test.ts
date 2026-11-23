import { HARDENED, derivePath, derivePrivate, derivePublic, masterKey, neuter } from '../hd.js';

const hex = (buffer: Buffer) => buffer.toString('hex');

// BIP32 test vector 1 (seed 000102030405060708090a0b0c0d0e0f)
const SEED = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const VECTOR: { path: number[]; chainCode: string; privateKey: string; publicKey: string }[] = [
	{
		path: [],
		chainCode: '873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508',
		privateKey: 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35',
		publicKey: '0339a36013301597daef41fbe593a02cc513d0b55527ec2df1050e2e8ff49c85c2',
	},
	{
		path: [HARDENED],
		chainCode: '47fdacbd0f1097043b78c63c20c34ef4ed9a111d980047ad16282c7ae6236141',
		privateKey: 'edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea',
		publicKey: '035a784662a4a20a65bf6aab9ae98a6c068a81c52e4b032c0fb5400c706cfccc56',
	},
	{
		path: [HARDENED, 1],
		chainCode: '2a7857631386ba23dacac34180dd1983734e444fdbf774041578e9b6adb37c19',
		privateKey: '3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368',
		publicKey: '03501e454bf00751f24b1b489aa925215d66af2234e3891c3b21a52bedb3cd711c',
	},
	{
		path: [HARDENED, 1, HARDENED + 2],
		chainCode: '04466b9cc8e161e966409ca52986c584f07e9dc81f735db683c3ff6ec7b1503f',
		privateKey: 'cbce0d719ecf7431d88e6a89fa1483e02e35092af60c042b1df2ff59fa424dca',
		publicKey: '0357bfe1e341d01c69fe5654309956cbea516822fba8a601743a012a7896ee8dc2',
	},
];

describe('BIP32 derivation', () => {
	it.each(VECTOR)('should match test vector 1 at $path', ({ path, chainCode, privateKey, publicKey }) => {
		const key = derivePath(masterKey(SEED), path);
		expect(hex(key.chainCode)).toBe(chainCode);
		expect(hex(key.privateKey)).toBe(privateKey);
		expect(hex(neuter(key).publicKey)).toBe(publicKey);
	});

	it('should derive the same public children from the public parent as from the private one', () => {
		const account = derivePath(masterKey(SEED), [HARDENED]);
		for (const index of [0, 1, 2, 1000]) {
			const fromPrivate = neuter(derivePrivate(account, index)!);
			const fromPublic = derivePublic(neuter(account), index)!;
			expect(hex(fromPublic.publicKey)).toBe(hex(fromPrivate.publicKey));
			expect(hex(fromPublic.chainCode)).toBe(hex(fromPrivate.chainCode));
		}
	});

	it('should refuse hardened public derivation and leave the parent key unchanged', () => {
		const master = masterKey(SEED);
		const before = hex(master.privateKey);
		derivePrivate(master, 5);
		expect(hex(master.privateKey)).toBe(before);
		expect(() => derivePublic(neuter(master), HARDENED)).toThrow('non-hardened');
	});
});
