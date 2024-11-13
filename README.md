# Blockchain TypeScript Implementation

A TypeScript implementation of a blockchain with Proof of Work mining and P2P networking capabilities.

## Features

- Proof of Work mining with adjustable difficulty
- Transaction signing and verification
- P2P networking for blockchain synchronization
- Mining rewards system
- Balance tracking for addresses
- Chain validation and consensus mechanism

## Getting Started

### Prerequisites

- Node.js
- npm

### Installation

```bash
npm install
```

### Running the Blockchain

Start a node:

```bash
npm run dev
```

To start additional nodes for P2P networking, use different P2P_PORT values:

```bash
P2P_PORT=5002 PEERS=ws://localhost:5001 npm run dev
```

## Architecture

### Components

1. **Block**

   - Contains transactions
   - Implements Proof of Work mining
   - Validates block integrity

2. **Blockchain**

   - Manages the chain of blocks
   - Handles pending transactions
   - Implements chain validation
   - Manages mining rewards
   - Tracks balances

3. **Transaction**

   - Implements digital signatures
   - Validates transaction integrity
   - Supports mining rewards

4. **P2P Server**
   - Manages peer connections
   - Synchronizes blockchain across nodes
   - Broadcasts new transactions and blocks
   - Implements consensus mechanism

## Usage Example

```typescript
// Create a new blockchain instance
const blockchain = new Blockchain();

// Create and sign a transaction
const transaction = new Transaction(fromAddress, toAddress, amount);
transaction.signTransaction(privateKey);
blockchain.addTransaction(transaction);

// Mine pending transactions
blockchain.minePendingTransactions(minerAddress);

// Check balances
const balance = blockchain.getBalance(address);
```

## Network Communication

The P2P server handles several types of messages:

- Chain synchronization
- New transaction broadcasts
- New block announcements
- Consensus management

## Security Features

- Proof of Work mining
- Digital signatures for transactions
- Chain integrity validation
- Consensus mechanism for conflict resolution

## Development

### Running Tests

```bash
npm test
```

### Building

```bash
npm run build
```

## License

This project is licensed under CC0-1.0 - see the LICENSE file for details.
