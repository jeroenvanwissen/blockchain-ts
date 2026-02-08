# Task E5: Prevent Self-Connection

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| **ID**           | `E5`                               |
| **Status**       | `[ ]`                              |
| **Priority**     | Medium                             |
| **Dependencies** | D1                                 |
| **Branch**       | `feature/e5-self-connection`       |

**Goal:**
Implement a mechanism to prevent a node from connecting to itself, which can happen when a node's own address appears in the peer list from discovery.

**Scope:**

```
src/networking/
├── P2PServer.ts                    # MODIFY — add node ID generation, handshake validation
└── __tests__/P2PServer.test.ts     # MODIFY — add self-connection tests
src/
└── config.ts                       # MODIFY — optional node ID persistence
```

**Implementation:**

1. Generate a unique node ID at startup (use wallet public key or random UUID)
2. Include node ID in the initial handshake message exchanged on connection
3. Disconnect immediately if the received node ID matches the local node ID
4. Filter out own address when processing peer lists from discovery
5. Add logging when a self-connection is detected and prevented

**Acceptance Criteria:**

- [ ] A node never maintains an active connection to itself
- [ ] Self-connection attempts are detected and logged
- [ ] Node ID is exchanged during peer handshake
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Start a node on port 5001, add ws://localhost:5001 to its own PEERS list
# Verify it detects and drops the self-connection
```
