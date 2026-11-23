import { getLogLevel, logger, setLogLevel } from '../logger.js';

describe('logger', () => {
	const initial = getLogLevel();
	let out: jest.SpyInstance;
	let err: jest.SpyInstance;

	beforeEach(() => {
		out = jest.spyOn(console, 'log').mockImplementation(() => {});
		err = jest.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		setLogLevel(initial);
		jest.restoreAllMocks();
	});

	it('should write timestamped, leveled, scoped lines: info to stdout, warnings to stderr', () => {
		setLogLevel('info');
		const log = logger('Test');

		log.info('hello', 42);
		log.warn('careful');

		expect(out).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z INFO {2}\[Test\] hello$/), 42);
		expect(err).toHaveBeenCalledWith(expect.stringMatching(/ WARN {2}\[Test\] careful$/));
	});

	it('should hide debug output by default and lines below the configured level', () => {
		setLogLevel('info');
		logger('Test').debug('noise');
		expect(out).not.toHaveBeenCalled();

		setLogLevel('error');
		logger('Test').warn('not shown');
		logger('Test').error('shown');
		expect(err).toHaveBeenCalledTimes(1);

		setLogLevel('debug');
		logger('Test').debug('now shown');
		expect(out).toHaveBeenCalledWith(expect.stringContaining('DEBUG [Test] now shown'));
	});
});
