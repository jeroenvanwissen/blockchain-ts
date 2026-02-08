# Testing Conventions

## Framework

- **Test runner:** Jest 30.x (`jest --config jest.config.cjs`)
- **TypeScript integration:** ts-jest preset
- **Mocking:** Jest built-in (`jest.mock`, `jest.spyOn`, `jest.fn`)

## File Organization

- Test location: `__tests__/` directory inside each module (colocated with source)
- Test file naming: `PascalCase.test.ts` matching source file (e.g., `Blockchain.test.ts`)
- Test helpers: defined as local functions within test files (no shared test utils directory yet)

## Test Structure

```typescript
describe('ClassName', () => {
    let instance: ClassName;

    beforeEach(() => {
        // Set test environment
        process.env.NODE_ENV = 'test';
        // Setup fake timers
        jest.useFakeTimers();
        jest.setSystemTime(new Date(startTime));
        // Create fresh instance
        instance = new ClassName();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('methodName', () => {
        it('should describe expected behavior', () => {
            // Arrange
            // Act
            // Assert
            expect(result).toBe(expected);
        });
    });
});
```

## Naming

- Test suites (`describe`): class name or method name being tested
- Test cases (`it`): start with `should` — e.g., `it('should create genesis block on initialization')`
- Helper functions: descriptive camelCase — e.g., `minePowBlocks(count, miner)`

## Patterns

### Setup and Teardown

- Use `beforeEach` for per-test setup (fresh instances, fake timers, mocks)
- Use `afterEach` for cleanup (restore real timers, clear mocks)
- Set `process.env.NODE_ENV = 'test'` in `beforeEach` (note: planned for removal — see task C4)
- Create helper functions for repetitive operations (e.g., mining N blocks)

### Mocking

- **File system:** `jest.mock('fs')` with per-test mock implementations
  ```typescript
  (fs.existsSync as jest.Mock).mockReturnValue(false);
  (fs.readFileSync as jest.Mock).mockImplementation(() => { throw new Error('File not found'); });
  ```
- **WebSocket:** `jest.mock('ws')` with custom `MockWebSocket` class extending `EventEmitter`
- **Time:** `jest.useFakeTimers()` + `jest.setSystemTime()` for deterministic time control
- **Class methods:** `jest.spyOn(Class.prototype, 'method').mockImplementation(() => value)`
- **Private methods:** Access via string index `instance['privateMethod'](args)` when testing internal behavior

### What to Mock

- File system operations (`fs` module)
- Network operations (`ws` module)
- System time (`Date.now()`)
- Block difficulty (for faster test execution)

### What NOT to Mock

- Core business logic (hashing, signing, validation)
- Transaction creation and manipulation
- Chain validation logic

### Assertions

- Use `expect().toBe()` for primitives, `expect().toEqual()` for objects
- Use `expect().toHaveBeenCalledWith()` for verifying mock calls
- Use `expect().toThrow()` for error cases
- One logical assertion per test where practical, multiple related assertions are acceptable

## Coverage

- **Minimum coverage:** Not currently enforced (target >80% — see task E6)
- **Coverage command:** `npm test -- --coverage`
- **Currently tested:** Blockchain consensus, P2P server basics
- **Currently untested:** Transaction, Block, Wallet, StakingService, Miner (individual unit tests)

## Do / Don't

| Do                                                  | Don't                                                |
| --------------------------------------------------- | ---------------------------------------------------- |
| Create fresh instances in `beforeEach`               | Share mutable state between tests                    |
| Use `jest.useFakeTimers()` for time-dependent tests  | Rely on `Date.now()` or real timers                  |
| Mock file system and network at module level          | Make real file system or network calls in tests      |
| Use helper functions for repetitive test setup        | Copy-paste block mining loops across tests           |
| Test error paths and edge cases                       | Only test the happy path                             |
