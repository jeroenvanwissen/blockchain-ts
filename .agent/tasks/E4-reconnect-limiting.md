# Task E4: Limit Peer Reconnection Attempts

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| **ID**           | `E4`                               |
| **Status**       | `[ ]`                              |
| **Priority**     | Medium                             |
| **Dependencies** | None                               |
| **Branch**       | `feature/e4-reconnect-limiting`    |

**Goal:**
Add logic to limit the maximum number of reconnection attempts to a peer. Currently, the P2P server uses exponential backoff but has no upper bound on retry count, wasting resources on permanently unavailable peers.

**Scope:**

```
src/networking/
├── P2PServer.ts                    # MODIFY — add retry tracking, max attempts, unreachable marking
└── __tests__/P2PServer.test.ts     # MODIFY — add reconnection limit tests
src/
└── config.ts                       # MODIFY — add MAX_RECONNECT_ATTEMPTS, UNREACHABLE_RETRY_INTERVAL
```

**Implementation:**

1. Add `MAX_RECONNECT_ATTEMPTS` (default: 10) and `UNREACHABLE_RETRY_INTERVAL` (default: 30 min) to `config.ts`
2. Track reconnection attempt count per peer in `P2PServer`
3. Stop reconnecting after reaching the maximum, mark peer as unreachable
4. Log when a peer is marked unreachable
5. Optionally retry unreachable peers at the longer interval
6. Reset reconnection count on successful connection

**Acceptance Criteria:**

- [ ] Peers that are down are not retried indefinitely
- [ ] Reconnection counter resets on successful connection
- [ ] Unreachable peers are logged and periodically re-checked
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
# Start a node, connect to a non-existent peer, verify retries stop after MAX_RECONNECT_ATTEMPTS
```
