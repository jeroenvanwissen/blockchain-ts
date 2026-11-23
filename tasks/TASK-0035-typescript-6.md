# TASK-0035: TypeScript 6.0; hold back TypeScript 7

Status: done
Priority: P2
Size: small
Depends on: none
Source: Dependabot PR #113 (typescript 5.9.2 → 7.0.2), which failed CI; owner decision: keep TypeScript on 6.0.x

## Why

#113 couldn't be merged: `npm ci` failed with ERESOLVE. Investigation showed this can't be fixed by updating other packages:
- TypeScript 7.0 is the native compiler and has no JavaScript compiler API. Its package's main export only returns the version; everything else is `unstable/*`.
- typescript-eslint, latest release and canary alike, requires `typescript >=4.8.4 <6.1.0`, and ts-jest 29.4.15 requires `>=4.3 <7`. Both drive TypeScript through that API.
- TypeScript 6.0.3 is the last release with the API, and it's within both ranges.

## Scope

- Move from TypeScript 5.9 to 6.0.x and adapt to its new defaults.
- Stop Dependabot from proposing TypeScript versions the toolchain can't load.

## Acceptance criteria

- [x] Build, tests (ts-jest), lint (typescript-eslint, type-aware) and smoke pass on TypeScript 6.0.3.
- [x] Dependabot keeps TypeScript on 6.0.x.

## Validation

`npm ci`, `npm run check`, `npm run smoke`.

## Outcome

**Upgrade**
- `typescript` `~6.0.3`.
- `tsconfig.json` now lists `types: ["node", "jest"]`: TypeScript 6 and 7 no longer include `@types` packages automatically, and without it every test file lost the Jest globals.
- It also sets `rootDir: "./src"`, so `dist/` keeps its layout (`dist/index.js`, `dist/blockchain/miningWorker.cjs`).

**Dependabot**
- `.github/dependabot.yml` ignores `typescript` versions >= 6.1.0, with the reason in a comment. 6.0 patch releases still come through.
- Revisit when typescript-eslint and ts-jest support TypeScript 7.

**Also tried:** running TypeScript 7 for the build alongside 6.0 for the tools, using an npm alias. Both compilers built the project cleanly, but the owner chose to stay on 6.0.x only. Removing the alias also removed the shared `node_modules/.bin/tsc` link; a clean `npm ci` restores it (CI always installs clean).

**Runs**
- After a clean `npm ci`, `tsc --version` is 6.0.3.
- `npm run check`: 28 suites, 304 tests, lint clean.
- `npm run smoke`: PASS.
