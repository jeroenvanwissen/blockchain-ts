# Task D2: Message Relaying

| Field            | Value                          |
| ---------------- | ------------------------------ |
| **ID**           | `D2`                           |
| **Status**       | `[ ]`                          |
| **Priority**     | High                           |
| **Dependencies** | D1                             |
| **Branch**       | `feature/d2-message-relaying`  |

**Goal:**
Implement proper message relaying so that messages (blocks, transactions, stakes) propagate across the entire network, not just to directly connected peers.

**Scope:**

```
src/networking/
├── P2PServer.ts                    # MODIFY — add relay logic, message ID tracking, TTL handling
└── __tests__/P2PServer.test.ts     # MODIFY — add relay tests
```

**Implementation:**

1. Add a unique message ID (hash of content + timestamp) to each broadcast message
2. Track recently seen message IDs using a Set or LRU cache with TTL-based expiry
3. When receiving a new message (not seen before), relay it to all other connected peers
4. Do not relay messages back to the sender
5. Implement TTL (Time To Live) on messages — decrement on each hop, drop at 0
6. Add rate limiting to prevent message flooding

**Acceptance Criteria:**

- [ ] A transaction broadcast by node A reaches node C through node B (A -> B -> C)
- [ ] No message is relayed more than once by the same node
- [ ] Messages with expired TTL are dropped
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Start 3 nodes in a chain: A <-> B <-> C (B connects to both A and C)
# Submit a transaction on A, verify it appears on C
```
