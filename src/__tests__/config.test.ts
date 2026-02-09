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
