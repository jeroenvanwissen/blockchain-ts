/**
 * Leveled logging for the node: `logger(scope)` returns debug/info/warn/error functions that
 * write `<ISO time> LEVEL [scope] message` lines; debug and info go to stdout, warn and error to
 * stderr. The level comes from the LOG_LEVEL env var (debug, info, warn or error; default info,
 * so debug output is off). Never pass key material, wallet contents or the API token.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
	debug(message: string, ...details: unknown[]): void;
	info(message: string, ...details: unknown[]): void;
	warn(message: string, ...details: unknown[]): void;
	error(message: string, ...details: unknown[]): void;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function parseLevel(value: string | undefined): LogLevel {
	const level = value?.trim().toLowerCase();
	return level && level in RANK ? (level as LogLevel) : 'info';
}

let threshold: LogLevel = parseLevel(process.env.LOG_LEVEL);

/** Change the level at runtime (tests, tooling). */
export function setLogLevel(level: LogLevel): void {
	threshold = level;
}

export function getLogLevel(): LogLevel {
	return threshold;
}

export function logger(scope: string): Logger {
	const write = (level: LogLevel) => (message: string, ...details: unknown[]) => {
		if (RANK[level] < RANK[threshold]) return;
		const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
		if (RANK[level] >= RANK.warn) console.error(line, ...details);
		else console.log(line, ...details);
	};
	return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}
