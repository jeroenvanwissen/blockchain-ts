# TASK-0050: A network of nodes on separate machines

Status: done
Priority: P2
Size: medium
Depends on: TASK-0043
Source: owner request (2026-11-24)

## Why

Every check so far runs its nodes on one machine: e2e on loopback, the Docker regtest compose file on one host. A real network has nodes on separate machines. They reach each other by hostname or public IP through firewalls, NAT and published Docker ports, find each other without everyone configuring everyone, and keep their clocks close enough for proof of stake. Nothing documented how to set that up, and nothing checked it.

## Scope

- A node can announce the port peers should dial when it differs from the one it listens on (a Docker port published under another number, a router's port forward).
- A check that runs nodes as separate machines (each its own IP and hostname), where a node that knows only one peer finds the others, everyone converges, a payment crosses the network, and a restarted node rejoins from its saved peer list.
- A guide: the first node, joining nodes, ports and firewalls, clocks, Docker, and how to see that it works.

## Acceptance criteria

- [x] `P2P_EXTERNAL_PORT` is what VERSION announces, and peers learn the node's address with that port.
- [x] `npm run network:check` passes: three containers on their own network, C configured with only B, discovers and connects to A; tips agree; a payment from A confirms at C; C restarted without seed nodes reconnects from `peers.json`. CI runs it.
- [x] The README explains how to run nodes on several machines.

## Validation

`npm run check`, `npm run smoke`, `npm run e2e`, `npm run docker:check`, `npm run network:check`.

## Outcome

**Announced port**
- `P2P_EXTERNAL_PORT` (env, validated as a port number) is what `VERSION.listenPort` announces; the default is the port the node listens on. Peers record the node as its IP plus that port.
- The startup log says `P2P Server listening on 0.0.0.0:5001 (peers dial port 7001)` when the two differ.
- `ExternalPort.test.ts`: a node that announces 45678 is learned as `ws://127.0.0.1:45678`, not under the port it listens on.

**Network check (`src/networkCheck.ts`, `npm run network:check [-- --no-build]`)**
- Three regtest containers on a Docker network of their own, each with its own IP address and hostname, configured as an operator would: A mines and stakes, B has `SEED_NODES=ws://a:5001`, C has `SEED_NODES=ws://b:5001`.
- It checks that:
  - C learns A's address from B's `PEERS` and connects to it
  - the three tips agree
  - A pays 1.5 coins to a new address of C with `cli send`, and the payment confirms at C with that exact balance
  - C, recreated from its data volume without `SEED_NODES`, reconnects from `peers.json` (which held `a:5001`, `b:5001` and both IPs) and follows A's tip
  - no container logs a warning, an error or a misbehaving peer
- CI runs it in the Docker job after `docker:check`, on the same image. The Docker helpers it shares with `docker:check` moved to `src/dockerHarness.ts`.

**Guide**
- The README section "Running a Network Across Machines" covers:
  - the first node and its reachable port
  - joining nodes with `SEED_NODES` or `--peers`, and with Docker through `compose.override.yaml`
  - how addresses spread and `peers.json`
  - `P2P_EXTERNAL_PORT`
  - clock synchronization
  - the PoW and PoS phases
  - how to check the network, and what crosses it unencrypted
- The troubleshooting entry for peers that don't connect was expanded, and the configuration table gained `P2P_EXTERNAL_PORT` and `SEED_NODES`.

**Found:** a brand-new network on the main parameters pauses for about 7.5 hours after block 100, until the first PoW rewards are 8 hours old. Changing that is a consensus decision; recorded as TASK-0051 with options.

## Runs

- `npm run check`: 37 suites, 383 tests, lint clean.
- `npm run smoke`: PASS.
- `npm run e2e`: PASS (height 27, 7 PoS blocks).
- `npm run docker:check`: PASS after moving its helpers to `dockerHarness.ts`.
- `npm run network:check -- --no-build`: PASS twice (heights 13 and 14). C found A through B; C's `peers.json` held `a:5001`, `b:5001` and both container IPs.
