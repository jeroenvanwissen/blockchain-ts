# Code Style

## Formatting

- Indentation: tabs
- Semicolons: required
- Quote style: single quotes for strings
- Trailing commas: use in multiline arrays, objects, and parameter lists
- Brace placement: same line (`if (x) {`)
- Line length: keep under 100 characters where practical
- Blank lines: single between methods, single between logical sections

## Naming

### Variables and Functions

- camelCase: `calculateHash()`, `addMinedBlock()`, `getTotalBalance()`
- Boolean variables: prefix with `is`, `has`, `can` (e.g., `isProofOfWork()`, `hasMinimumStake`)
- Private/protected members: underscore prefix (e.g., `_chain`, `_utxoSet`, `_pendingTransactions`)

### Types / Classes / Interfaces

- PascalCase for classes: `Blockchain`, `Transaction`, `P2PServer`, `StakingService`
- PascalCase for interfaces/types: `TxInput`, `TxOutput`, `StakeInfo`, `UTXO`, `WalletData`
- No `I` prefix on interfaces
- Serialization types: prefix with `Serialized` (e.g., `SerializedBlock`, `SerializedTransaction`)

### Constants

- UPPER_SNAKE_CASE: `POW_CUTOFF_BLOCK`, `BLOCK_REWARD`, `MIN_STAKE_AMOUNT`
- Define in `src/config.ts` only
- Export as named constants

### Enums

- PascalCase for enum name, UPPER_SNAKE_CASE for members
- Example: `enum MessageType { CHAIN, BLOCK, TRANSACTION, STAKE }`

## Imports

- Use explicit `.js` extension in all relative imports: `import { Block } from './Block.js';`
- Group imports: Node.js built-ins first, then external packages, then local files
- Use named imports, not default imports: `import { Blockchain } from './blockchain/Blockchain.js';`
- Use `import type` for type-only imports: `import type { TxInput, TxOutput } from './Transaction.js';`

## Patterns

### Error Handling

- Throw `Error` with descriptive lowercase message: `throw new Error('insufficient funds');`
- Catch at critical boundaries (file I/O, network), let others propagate
- Never use empty catch blocks — log or rethrow
- Pattern: `try { ... } catch (error) { console.error('context:', error); throw error; }`

### Logging

- Currently uses `console.log` / `console.error` (migration to winston is planned — see task F2)
- Use `console.error` for errors, `console.log` for informational output
- Never log private keys, wallet contents, or sensitive data
- Prefix debug output with context: `console.log('[Blockchain] message')`

### Async

- Use `async/await` for all asynchronous operations
- Use `async-mutex` (`Mutex`) for protecting shared mutable state
- Pattern: `const release = await this.lock.acquire(); try { ... } finally { release(); }`
- Worker threads for CPU-intensive operations (mining)

### Type Safety

- Use type guards for wire format validation: `function isSerializedBlock(obj: unknown): obj is SerializedBlock`
- Use union types for message protocols
- Enable strict TypeScript (`"strict": true` in tsconfig.json)

## Do / Don't

| Do                                              | Don't                                           |
| ----------------------------------------------- | ----------------------------------------------- |
| `import { Block } from './Block.js';`           | `import Block from './Block';`                  |
| `throw new Error('descriptive message');`        | `throw 'string error';`                         |
| `const release = await mutex.acquire();`         | Modify shared state without a lock              |
| `export const CONFIG = value;` in config.ts      | Hardcode constants in implementation files       |
| `import type { Foo } from './Foo.js';`           | Import runtime values when only types are needed |
| One class per file, matching filename             | Multiple classes in a single file                |
