# TASK-0043: Docker image and compose file

Status: pending
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

- [ ] `docker compose up` runs a node whose data survives restarts; `docker stop` saves the chainstate.
- [ ] The CLI works inside the container without extra flags.
- [ ] The image uses the native `secp256k1` addon on amd64 and arm64.
- [ ] CI builds the image and checks a running container.

## Validation

`npm run check`, `npm run smoke`, the Docker check locally and in CI.
