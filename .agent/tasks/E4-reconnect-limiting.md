# Task E4: Limit Peer Reconnection Attempts

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| **ID**           | `E4`                               |
| **Status**       | `[ ]`                              |
| **Priority**     | Medium                             |
| **Dependencies** | None                               |
| **Branch**       | `feature/e4-reconnect-limiting`    |

**Goal:**
Improve reconnection limiting for permanently unavailable peers. Basic retry logic already exists: `reconnectToPeer()` uses exponential backoff (base 1s, max 30s cap) with a hardcoded `maxAttempts = 10`. However, the implementation has gaps that need addressing.

**Scope:**

```
src/networking/
├── P2PServer.ts                    # MODIFY — add retry tracking, max attempts, unreachable marking
└── __tests__/P2PServer.test.ts     # MODIFY — add reconnection limit tests
src/
└── config.ts                       # MODIFY — add MAX_RECONNECT_ATTEMPTS, UNREACHABLE_RETRY_INTERVAL
```

**Already Implemented:**

- `reconnectToPeer()` has `maxAttempts = 10` with exponential backoff (P2PServer.ts:237-271)
- Stops retrying after max attempts with a log message

**Remaining Implementation:**

1. Move `maxAttempts` to config as `MAX_RECONNECT_ATTEMPTS` (currently hardcoded)
2. Add `UNREACHABLE_RETRY_INTERVAL` (default: 30 min) to `config.ts`
3. Track reconnection state per peer in a `Map` (current approach uses a recursive function parameter, so the counter doesn't persist or reset)
4. Reset reconnection counter when a peer successfully reconnects (currently not tracked)
5. Mark unreachable peers and periodically retry at the longer interval
6. Log unreachable peers with their last-seen timestamp

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
