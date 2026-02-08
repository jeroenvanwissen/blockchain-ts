# Task D4: REST API for Transactions

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| **ID**           | `D4`                               |
| **Status**       | `[ ]`                              |
| **Priority**     | High                               |
| **Dependencies** | D3                                 |
| **Branch**       | `feature/d4-api-transactions`      |

**Goal:**
Implement REST API endpoints for creating, signing, and submitting transactions. Enables wallets and applications to send coins and interact with the transaction system.

**Scope:**

```
src/api/
├── TransactionAPI.ts               # CREATE — transaction route handlers
└── BlockchainAPI.ts                # MODIFY — register transaction routes
src/blockchain/
└── Blockchain.ts                   # MODIFY — add helper methods for tx lookup
src/networking/
└── P2PServer.ts                    # MODIFY — transaction broadcast integration
```

**Implementation:**

1. Create `src/api/TransactionAPI.ts` with the following endpoints:
   - `POST /api/transaction` — submit a signed transaction to the mempool
   - `GET /api/transaction/:hash` — get transaction details by hash
   - `GET /api/transactions/pending` — list pending (unconfirmed) transactions
   - `GET /api/transactions/address/:address` — get transaction history for an address
   - `POST /api/wallet/create` — create a new wallet (returns public key/address)
   - `POST /api/transaction/create` — create and sign a transaction (requires private key)
2. Validate transaction format and signatures before accepting
3. Broadcast accepted transactions to P2P network
4. Add rate limiting to transaction submission endpoints
5. Document that `POST /api/transaction/create` is unsafe for production (keys over HTTP)
6. Return descriptive error messages for invalid transactions

**Acceptance Criteria:**

- [ ] Transactions can be submitted via API and appear in pending pool
- [ ] Submitted transactions are broadcast to connected peers
- [ ] Invalid transactions are rejected with descriptive errors
- [ ] Transaction history can be queried by address
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

**Verification Commands:**

```bash
npm run build
npm test
npm run dev &
curl http://localhost:3000/api/transactions/pending
curl -X POST http://localhost:3000/api/wallet/create
curl -X POST http://localhost:3000/api/transaction -H "Content-Type: application/json" -d '{"..."}'
```
