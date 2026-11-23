# TASK-0021: Fix lint errors and gate changes on build, test and lint

Status: done
Priority: P2
Size: small
Depends on: none
Source: F-017

## Why

`npm run lint` failed (41 errors at assessment time, 53 before this task), so nobody could treat lint as a gate and new problems hid among the old ones.

## Scope

- Make `npm run lint` pass on the repository.
- Make build, test and lint one standard check and document it.
- CI is recommended, but adding it is the owner's call; not part of this task.

## Acceptance criteria

- [x] `npm run lint` exits 0.
- [x] One command runs build, test and lint, and AGENTS.md and the README name it as the check for every change.

## Validation

`npm run check`.

## Outcome

- After TASK-0022 removed the stale root files, 49 errors remained:
  - 42 came from `eslint .` reaching the generated `dist/` and `coverage/` folders, which aren't in the TypeScript project. `.eslintrc.cjs` now ignores both.
  - The other 6 were in tests, fixed at the source without disabling rules:
    - `Blockchain.test.ts`: an `expect` inside `if (remainingBalance > 0)`. The balance is always the 5-coin change, so the test now asserts it exactly and spends it unconditionally.
    - `Wallet.test.ts`: three unused `wallet` variables (the constructor's side effects are what's tested).
    - `P2PServer.test.ts`: typed the parsed mock write and replaced an `as any` spy target with a narrow type.
- `npm run check` runs `npm run build && npm test && npm run lint`. AGENTS.md (commands, change verification) and the README (verify step, workflow, quick reference, best practices) point to it. The README's e2e duration is now about 2 minutes.
- `npm run check` passes: 17 suites, 232 tests, 0 lint errors.
