# TASK-0036: ESLint 10 with a flat config

Status: done
Priority: P2
Size: small
Depends on: TASK-0021
Source: Dependabot PR #119 (eslint 8.57.1 → 10.15.0), which failed CI; owner asked for the migration

## Why

The project linted with ESLint 8.57.1, which npm marks as "no longer supported": no fixes, security ones included. #119 couldn't simply be merged:
- ESLint 10 removed the old `.eslintrc` configuration format.
- The pinned eslint-plugin-jest 29.0.1 didn't accept ESLint 10 as a peer (CI failed with ERESOLVE). #117 later raised it to 29.17.1.

## Scope

- Move to ESLint 10 and a flat config with the same rules.
- Fix what ESLint 10's recommended set newly reports.

## Acceptance criteria

- [x] `npm run lint` runs ESLint 10 from `eslint.config.js` and passes.
- [x] The enabled rules match the old configuration, apart from deliberate and upstream changes, which are listed below.

## Validation

`npm run check` (build, tests, lint), `npm run smoke`, `npm run e2e`; rule-by-rule comparison of `eslint --print-config` before and after.

## Outcome

**Packages**
- eslint 10.15.0, @eslint/js 10.0.1, globals 17.14.0.
- typescript-eslint 8.74.0 replaces the separate `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` packages, which it bundles.

**`eslint.config.js`** (replaces `.eslintrc.cjs`)
- Global ignores: `dist/` and `coverage/`.
- `@eslint/js` recommended rules for everything.
- `**/*.ts`: typescript-eslint `recommendedTypeChecked`, typed through `tsconfig.json`, Node globals, and the same three `no-unsafe-*` rules off.
- Jest `flat/recommended` for `src/**/__tests__/**/*.ts`.
- CommonJS settings for `.cjs` files.

**Rule comparison** (`eslint --print-config` on a source file and a test file, before and after)
- typescript-eslint: identical rules and severities.
- Jest rules now apply to test files only; before, they were enabled everywhere, though they only concern test code.
- ESLint core, from its own upgrade:
  - added: `no-constant-binary-expression`, `no-empty-static-block`, `no-unassigned-vars`, `no-unused-private-class-members`, `no-useless-assignment`, `preserve-caught-error`
  - removed: `no-extra-semi`, `no-inner-declarations`, `no-mixed-spaces-and-tabs` (formatting and deprecated rules ESLint dropped)
- No shared rule changed severity.
- `.cjs` files (Jest config and setup, the mining worker) are now linted with the base rules. ESLint 8 skipped them; they pass.

**Code changes for the new rules**
- `preserve-caught-error`: three places in `Blockchain.ts` that re-throw with added context now pass the original error as `cause`: a transaction inside a block, a failed branch activation, and `replaceChain`. Messages are unchanged.
- `tsconfig.json` gets `lib: ["ES2022"]` for the `cause` option's types. `target` stays ES2020, so the emitted JavaScript doesn't change; Node 26 supports `cause` natively. No code used DOM types (`fetch` and the other globals come from `@types/node`).
- `no-useless-assignment`: the block-signature check no longer initializes `isSigned` to a value both branches overwrite.

**Runs**
- `npm run check`: 28 suites, 304 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 103 s (height 27, 7 PoS blocks).
