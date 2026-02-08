# Task D1: Peer Discovery Mechanism

| Field            | Value                          |
| ---------------- | ------------------------------ |
| **ID**           | `D1`                           |
| **Status**       | `[ ]`                          |
| **Priority**     | High                           |
| **Dependencies** | None                           |
| **Branch**       | `feature/d1-peer-discovery`    |

**Goal:**
Implement automatic peer discovery so nodes can find and connect to each other without manual configuration. Currently, peers must be specified via the `PEERS` environment variable at startup.

**Scope:**

```
src/networking/
├── P2PServer.ts                    # MODIFY — add PEERS message type, peer list exchange
└── __tests__/P2PServer.test.ts     # MODIFY — add peer discovery tests
src/
└── config.ts                       # MODIFY — add seed node configuration
```

**Implementation:**

1. Add a `PEERS` message type to the P2P protocol for sharing known peer addresses
2. On new peer connection, exchange known peer lists between nodes
3. Periodically broadcast updated peer lists to all connected peers
4. Validate peer addresses before attempting connection (format, reachability)
5. Add seed node configuration in `config.ts` for initial network bootstrapping
6. Deduplicate peer entries to avoid redundant connections

**Acceptance Criteria:**

- [ ] A new node with a single seed peer can discover all other nodes in the network
- [ ] Peer lists are persisted to `data/peers.json` and used on restart
- [ ] No duplicate connections are established
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Start 3 nodes: node A (seed), node B (connects to A), node C (connects to A)
# Verify node C discovers node B through A
```
