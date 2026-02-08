# Task D3: REST API for Blockchain

| Field            | Value                             |
| ---------------- | --------------------------------- |
| **ID**           | `D3`                              |
| **Status**       | `[ ]`                             |
| **Priority**     | High                              |
| **Dependencies** | None                              |
| **Branch**       | `feature/d3-api-blockchain`       |

**Goal:**
Implement a REST API that allows external applications to query blockchain state. Essential for building wallets, explorers, and other tools.

**Scope:**

```
src/api/
├── BlockchainAPI.ts                # CREATE — API route handlers
└── index.ts                        # CREATE — HTTP server setup
src/
├── index.ts                        # MODIFY — initialize API server on startup
└── config.ts                       # MODIFY — add API_PORT configuration
package.json                        # MODIFY — add HTTP framework dependency
```

**Implementation:**

1. Add HTTP framework dependency (Fastify or Express) to `package.json`
2. Create `src/api/index.ts` — HTTP server setup with CORS, JSON parsing
3. Create `src/api/BlockchainAPI.ts` with the following endpoints:
   - `GET /api/chain` — return the full blockchain
   - `GET /api/chain/length` — return chain length
   - `GET /api/block/:index` — return a specific block by index
   - `GET /api/block/hash/:hash` — return a specific block by hash
   - `GET /api/balance/:address` — return balance for an address
   - `GET /api/utxo/:address` — return UTXOs for an address
   - `GET /api/peers` — return connected peers
   - `GET /api/mining/info` — return mining difficulty, block height, etc.
   - `GET /api/staking/info` — return staking information
4. Add `API_PORT` (default: 3000) to `config.ts`
5. Initialize API server in `src/index.ts` alongside the P2P server
6. Add proper error handling and HTTP status codes (200, 404, 500)

**Acceptance Criteria:**

- [ ] All listed endpoints return correct JSON data
- [ ] Proper HTTP status codes for success and error cases
- [ ] API starts alongside the P2P server
- [ ] CORS headers allow browser-based clients
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
npm run dev &
curl http://localhost:3000/api/chain/length
curl http://localhost:3000/api/balance/<address>
curl http://localhost:3000/api/peers
```
