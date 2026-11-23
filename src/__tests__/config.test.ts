import { jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';

jest.mock('os', () => ({
	homedir: jest.fn(() => '/home/testuser'),
}));

// Re-import after mock setup — getDefaultDataDir reads os.homedir() on each call
import { getDefaultDataDir } from '../config.js';

const mockHomedir = os.homedir as jest.MockedFunction<typeof os.homedir>;

describe('getDefaultDataDir', () => {
	const originalPlatform = process.platform;

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: originalPlatform });
		mockHomedir.mockReturnValue('/home/testuser');
		delete process.env.APPDATA;
	});

	it('should return macOS path on darwin', () => {
		Object.defineProperty(process, 'platform', { value: 'darwin' });

		const result = getDefaultDataDir();

		expect(result).toBe(
			path.join('/home/testuser', 'Library', 'Application Support', 'blockchain-ts'),
		);
	});

	it('should return Linux path on linux', () => {
		Object.defineProperty(process, 'platform', { value: 'linux' });

		const result = getDefaultDataDir();

		expect(result).toBe(path.join('/home/testuser', '.blockchain-ts'));
	});

	it('should return Windows path using APPDATA on win32', () => {
		Object.defineProperty(process, 'platform', { value: 'win32' });
		process.env.APPDATA = 'C:\\Users\\testuser\\AppData\\Roaming';

		const result = getDefaultDataDir();

		expect(result).toBe(
			path.join('C:\\Users\\testuser\\AppData\\Roaming', 'blockchain-ts'),
		);
	});

	it('should fall back to homedir on win32 when APPDATA is not set', () => {
		Object.defineProperty(process, 'platform', { value: 'win32' });
		delete process.env.APPDATA;

		const result = getDefaultDataDir();

		expect(result).toBe(
			path.join('/home/testuser', 'AppData', 'Roaming', 'blockchain-ts'),
		);
	});

	it('should return Linux-style path on unknown platforms', () => {
		Object.defineProperty(process, 'platform', { value: 'freebsd' });

		const result = getDefaultDataDir();

		expect(result).toBe(path.join('/home/testuser', '.blockchain-ts'));
	});

	it('should handle paths with spaces', () => {
		Object.defineProperty(process, 'platform', { value: 'darwin' });
		mockHomedir.mockReturnValue('/Users/test user');

		const result = getDefaultDataDir();

		expect(result).toBe(
			path.join('/Users/test user', 'Library', 'Application Support', 'blockchain-ts'),
		);
	});
});

describe('API settings', () => {
	const savedEnv = process.env;

	afterEach(() => {
		process.env = savedEnv;
	});

	function loadConfig(env: Record<string, string>): typeof import('../config.js') {
		process.env = { ...savedEnv, ...env };
		delete process.env.API_HOST;
		delete process.env.API_PORT;
		Object.assign(process.env, env);
		let config!: typeof import('../config.js');
		jest.isolateModules(() => {
			config = jest.requireActual<typeof import('../config.js')>('../config.js');
		});
		return config;
	}

	it('should listen on loopback, on the P2P port + 1000, by default', () => {
		const config = loadConfig({ P2P_PORT: '5002' });

		expect(config.API_HOST).toBe('127.0.0.1');
		expect(config.API_PORT).toBe(6002);
	});

	it('should take the host and port from the environment', () => {
		const config = loadConfig({ API_HOST: '0.0.0.0', API_PORT: '0' });

		expect(config.API_HOST).toBe('0.0.0.0');
		expect(config.API_PORT).toBe(0);
	});
});
