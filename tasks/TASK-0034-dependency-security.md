# TASK-0034: Security updates for runtime dependencies

Status: done
Priority: P1
Size: small
Depends on: none
Source: `npm audit`; GitHub reported 58 Dependabot alerts (3 critical, 35 high) when `main` was pushed on 2026-11-23

## Why

`npm audit --omit=dev` found advisories in packages the node runs:
- **protobufjs 8.0.0** (critical): arbitrary code execution and several denial-of-service issues. It decodes every stored block, the block index and the wallet.
- **ws 8.18.3** (high): memory-exhaustion DoS from tiny fragments, and uninitialized memory disclosure. It accepts connections from untrusted peers.
- **bn.js** (moderate, infinite loop, via secp256k1's elliptic fallback) and **@protobufjs/utf8** (moderate).

Development tooling also had high and moderate advisories (`typescript-eslint` via `minimatch`, and others).

## Scope

- Update to fixed versions within the current major versions; no forced majors or downgrades.
- Re-verify storage, P2P and the wallet in the real runtime.
- Record what stays open and why.

## Acceptance criteria

- [x] No critical or high advisories remain; none in runtime dependencies except the low `elliptic` one.
- [x] check, smoke and e2e pass on the updated dependencies.

## Validation

`npm audit`, `npm run check`, `npm run smoke`, `npm run e2e`.

## Outcome

**Updates**
- protobufjs 8.0.0 → 8.8.1, ws 8.18.3 → 8.23.0, bn.js → 4.12.5 (`npm audit fix`).
- `@typescript-eslint/*` 8.39.1 → 8.73.0 and jest → 30.5.2 (latest within their majors).

**Regression found and fixed**
- protobufjs 8.8.1 no longer fills proto3 default values in from the message prototype; that prototype behavior is what its security fixes closed.
- `toObject` therefore left out zero-valued fields. Restart failed (`fileNumber` 0 of the first block file came back `undefined`), with six integration suites red and smoke failing at "node A (restart) exited".
- `BlockStore` now decodes blocks and the index with `defaults: true`, so zero values (`nonce`, `height`, file number, ...) are always present. The wallet has no zero-valued fields that matter and was unaffected.
- The unit tests mock protobufjs and would not have caught this; the persistence integration tests did.
- The newer `typescript-eslint` flagged 7 unnecessary type assertions, removed with `--fix` (type-only changes).

**Accepted, documented**
- `npm audit` still flags 20 packages (2 low, 18 moderate), all from three advisories and none critical or high:
  - **elliptic** (low): only secp256k1's pure-JS fallback uses it, and the node loads the native or prebuilt addon. The only "fix" npm offers is secp256k1 1.x.
  - **glob / minimatch** (moderate) inside Jest 30.5.2, the latest Jest: fixed versions are new majors that Jest's packages don't accept, and npm's only suggestion is downgrading Jest to 29. Test tooling only, on patterns the project writes.
- Dependabot (npm and, since TASK-0033, GitHub Actions) will raise these when upstream moves.

**Runs**
- `npm audit`: 0 critical, 0 high, 18 moderate, 2 low (was 2 critical, 8 high).
- `npm run check`: 27 suites, 299 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS in 142 s (height 27, 7 PoS blocks), including node A's restart.
