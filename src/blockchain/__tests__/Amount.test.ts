import { formatCoins, parseCoins } from '../amount.js';
import { COIN } from '../../config.js';

describe('coin amounts', () => {
	it('should parse whole and fractional coins into base units', () => {
		expect(parseCoins('1')).toBe(COIN);
		expect(parseCoins('0.5')).toBe(COIN / 2n);
		expect(parseCoins('12.00000001')).toBe(12n * COIN + 1n);
		expect(parseCoins('0')).toBe(0n);
	});

	it.each(['', '1.', '.5', '-1', '1e3', '0.000000001', '1,5', ' 1', 'abc'])(
		'should reject %p',
		(text) => {
			expect(() => parseCoins(text)).toThrow('invalid amount');
		},
	);

	it('should format base units as coins without trailing zeros', () => {
		expect(formatCoins(COIN)).toBe('1');
		expect(formatCoins(15n * COIN / 10n)).toBe('1.5');
		expect(formatCoins(1n)).toBe('0.00000001');
		expect(formatCoins(0n)).toBe('0');
		expect(formatCoins(parseCoins('123.456'))).toBe('123.456');
	});
});
