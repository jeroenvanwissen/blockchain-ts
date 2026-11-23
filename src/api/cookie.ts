import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * Write a fresh random API token to `file` (0600) and return it. The node calls this at every
 * start, so a token stops working when the node restarts. Never log the token.
 */
export function writeApiCookie(file: string): string {
	const token = crypto.randomBytes(32).toString('hex');
	fs.writeFileSync(file, token, { mode: 0o600 });
	fs.chmodSync(file, 0o600); // `mode` only applies when the file is created
	return token;
}

export function readApiCookie(file: string): string {
	return fs.readFileSync(file, 'utf8').trim();
}
