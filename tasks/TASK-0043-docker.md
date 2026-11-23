# TASK-0043: Docker image and compose file

Status: done
Priority: P2
Size: medium
Depends on: TASK-0037
Source: owner request (2026-11-23)

## Why

Running a node needs a Node.js toolchain and a checkout. The owner asked for Docker packaging.

## Scope

- A multi-stage `Dockerfile`: build with the dev toolchain, run the compiled `dist/` as a non-root user with production dependencies only. The `secp256k1` native addon must be built for the image's architecture: there's no linux-arm64 prebuild, and the pure-JS fallback is about 40× slower.
- The data dir is a volume. The API listens on all interfaces inside the container, so the explorer and chain routes can be published. Wallet routes stay loopback-only, so the CLI runs inside the container (`docker compose exec`).
- `compose.yaml` for a node, plus a regtest example network.
- A health check, clean shutdown on `docker stop`, and CI that builds the image and runs it.

## Acceptance criteria

- [x] `docker compose up` runs a node whose data survives restarts; `docker stop` saves the chainstate.
- [x] The CLI works inside the container without extra flags.
- [x] The image uses the native `secp256k1` addon on amd64 and arm64.
- [x] CI builds the image and checks a running container.

## Validation

`npm run check`, `npm run smoke`, the Docker check locally and in CI.

## Outcome

**Image (`Dockerfile`)**
- Build stage (`node:26-slim` plus python3, make and g++): `npm ci`, then `npm run build`, then `npm prune --omit=dev`.
- `RUN node -e "require('secp256k1/bindings')"` fails the build if the native addon is missing. On arm64, which has no prebuild, the addon is compiled; on amd64 the prebuild is used.
- npm 11.20 already warns that install scripts not listed in `allowScripts` may stop running in a later version. If that happens, this check turns a silent fall back to the slow pure-JS code into a build failure.
- Runtime stage (`node:26-slim`, about 280 MB):
  - `dist/`, production `node_modules` and a `cli` wrapper in `/usr/local/bin`
  - runs as the `node` user, with the data dir on the `/data` volume
  - `ENV DATA_DIR=/data P2P_PORT=5001 API_HOST=0.0.0.0 API_PORT=6001`
  - a health check on `/status`
  - `ENTRYPOINT ["node", "dist/index.js"]`; flags go in `CMD`
- `.dockerignore` lets in only `package*.json`, `tsconfig.json`, `src/` (without tests) and `docker/`.

**Config:** `DATA_DIR` sets the data dir when `--data-dir` isn't given, so the node and the CLI in the container find `/data` without flags.

**Wallet routes:** inside the container the API binds 0.0.0.0, so the explorer and chain routes can be published. The wallet routes still check for a loopback client, so requests through a published port get 403. The CLI works through `docker exec`.

**Compose**
- `compose.yaml`: one node. P2P is published on 5001, the API on `127.0.0.1:6001`, data is in the `node-data` volume, and `stop_grace_period` is 30 s.
- `compose.regtest.yaml`: node a mines and stakes; node b syncs from `ws://a:5001` and stakes. Their explorers are on 6001 and 6002.

**Checks**
- `src/dockerCheck.ts` (`npm run docker:check`, with `--no-build` and `IMAGE=` options). It runs a regtest container and checks:
  - the explorer and `/status` from the host, and 403 for `/wallet` from the host
  - `cli balance` and `cli new-address` inside the container
  - the native addon, a non-zero uid, and the health check reaching `healthy`
  - `docker stop`: exit code 0 and the shutdown log line
  - `docker start`: `chainstate at height H; validated 0 newer block(s)` (the stop saved the chainstate), the new address still listed, and no WARN or ERROR lines
- CI: a `docker` job (after `check`) runs it on amd64. Dependabot now also updates the base image.

**Runs**
- `npm run check`: 31 suites, 331 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run docker:check` on arm64 (Docker 29.8): PASS, including the image build that compiled secp256k1.
- `compose.regtest.yaml` by hand: b synced from a by hostname, and `a cli send` paid an address from `b cli new-address`.

**Found along the way:** with hostnames, the two regtest nodes held three connections to each other. A node reachable as `ws://a:5001` and as its container IP counts as two peers, because peers are deduplicated by address string. Logged as TASK-0044.
