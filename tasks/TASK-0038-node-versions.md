# TASK-0038: Declare and test the supported Node versions

Status: done
Priority: P2
Size: small
Depends on: TASK-0033
Source: F-033 (reassessment 2, 2026-11-23)

## Why

The README said Node.js 18+ and npm 9+, `package.json` declared no `engines`, and CI tested only Node 26. In fact, the dev toolchain needs newer: ESLint 10 and @eslint/js require Node `^20.19.0 || ^22.13.0 || >=24`. Node 18 and 20 are past end of life.

## Scope

- Declare the supported range, document it, and test both ends in CI.

## Acceptance criteria

- [x] `package.json` declares `engines.node`, and the README matches it.
- [x] CI runs the check job (build, tests, lint, smoke) on the oldest and newest supported lines.

## Validation

CI on the pull request: the check job on Node 22 and 26, e2e on 26.

## Outcome

- `engines.node`: `^22.13.0 || >=24`. This is ESLint 10's range without the end-of-life 20.x line; Node 23 is excluded too, since it was never an LTS release.
- README prerequisites: Node.js 22.13+ or 24+ (CI tests 22 and 26), npm 10+.
- `.github/workflows/check.yml`: the check job runs as a matrix on Node 22 and 26 (`fail-fast: false`). e2e runs once on Node 26 after both pass.
- Verified through CI on the pull request before merging. Downloading a Node 22 binary locally wasn't permitted in this session, so Node 22 is covered by CI only.
