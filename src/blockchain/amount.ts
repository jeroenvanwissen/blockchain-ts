import { COIN } from '../config.js';

const DECIMALS = COIN.toString().length - 1; // COIN = 10^8

/** Parse a coin amount such as "1", "0.5" or "12.00000001" into base units. Throws otherwise. */
export function parseCoins(text: string): bigint {
	const match = new RegExp(`^(\\d{1,12})(?:\\.(\\d{1,${DECIMALS}}))?$`).exec(text);
	if (!match) throw new Error(`invalid amount "${text}": use coins with up to ${DECIMALS} decimals`);
	const [, whole, fraction = ''] = match;
	return BigInt(whole) * COIN + BigInt(fraction.padEnd(DECIMALS, '0'));
}

/** Base units as coins without trailing zeros, e.g. 150000000n → "1.5". */
export function formatCoins(amount: bigint): string {
	const sign = amount < 0n ? '-' : '';
	const abs = amount < 0n ? -amount : amount;
	const fraction = (abs % COIN).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
	return `${sign}${abs / COIN}${fraction ? `.${fraction}` : ''}`;
}
