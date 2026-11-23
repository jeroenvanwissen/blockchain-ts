# TASK-0033: CI on every push and pull request

Status: done
Priority: P2
Size: small
Depends on: TASK-0021
Source: F-030 (reassessment 2026-11-23); owner approved adding a GitHub Actions workflow

## Why

`npm run check`, smoke and e2e ran only when someone remembered to run them locally. Nothing caught a broken `main` or a pull request that breaks consensus.

## Scope

- A GitHub Actions workflow running the project's standard checks on pushes to `main` and on pull requests.
- Keep the actions themselves up to date.

## Acceptance criteria

- [x] Pushes to `main` and pull requests run `npm ci`, `npm run check` and `npm run smoke`, then `npm run e2e`.
- [x] The first run on `main` passes.

## Validation

The workflow run on GitHub after pushing `main`.

## Outcome

- `.github/workflows/check.yml`:
  - job `check` (Node 26, npm cache) runs `npm ci`, `npm run check` and `npm run smoke`
  - job `e2e` runs after it with `npm run e2e`
  - read-only `contents` permission, newer runs on the same ref cancel older ones, 20-minute timeouts
- `secp256k1` loads its bundled `linux-x64` prebuild, so the runner needs no native toolchain.
- Dependabot now also watches the `github-actions` ecosystem weekly.
- The README shows a CI badge; AGENTS.md says CI must stay green.
- Runs: see below.
