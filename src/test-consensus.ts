import { Blockchain } from './blockchain/Blockchain';
import { Transaction } from './blockchain/Transaction';

// Test script to demonstrate PoW to PoS transition
function testConsensusTransition() {
	console.log('Creating blockchain...');
	const blockchain = new Blockchain();

	// Create some test addresses (in a real scenario these would be proper key pairs)
	const miner1 = 'miner1';
	const miner2 = 'miner2';
	const user1 = 'user1';

	// Mine first block (PoW)
	console.log('\nMining first block (PoW)...');
	blockchain.minePendingTransactions(miner1);
	console.log('Chain length:', blockchain.getChain().length);
	console.log('Miner1 balance:', blockchain.getBalance(miner1));

	// Mine second block (PoW)
	console.log('\nMining second block (PoW)...');
	blockchain.minePendingTransactions(miner2);
	console.log('Chain length:', blockchain.getChain().length);
	console.log('Miner2 balance:', blockchain.getBalance(miner2));

	// Add some transactions
	console.log('\nAdding transactions...');
	const tx1 = new Transaction(miner1, user1, 50);
	tx1.signTransaction('dummy-private-key'); // In real implementation, use proper signing
	blockchain.addTransaction(tx1);

	// Before mining third block, miners need to stake tokens for PoS
	console.log('\nStaking tokens for PoS...');
	try {
		blockchain.stake(miner1, 100); // Stake 100 tokens
		console.log('Miner1 staked 100 tokens');
	} catch (err) {
		console.log(
			'Miner1 staking failed:',
			err instanceof Error ? err.message : 'Unknown error'
		);
	}

	// Try mining third block (PoS)
	console.log('\nMining third block (PoS)...');
	try {
		blockchain.minePendingTransactions(miner1);
		console.log('Block mined successfully');
		console.log('Chain length:', blockchain.getChain().length);
	} catch (err) {
		console.log(
			'Mining failed:',
			err instanceof Error ? err.message : 'Unknown error'
		);
	}

	// Print final chain state
	console.log('\nFinal chain state:');
	console.log('Chain length:', blockchain.getChain().length);
	console.log('Chain valid:', blockchain.isChainValid());
	console.log('Miner1 balance:', blockchain.getBalance(miner1));
	console.log('Miner1 stake:', blockchain.getStake(miner1));
	console.log('Miner2 balance:', blockchain.getBalance(miner2));
	console.log('User1 balance:', blockchain.getBalance(user1));

	// Print consensus type of each block
	console.log('\nConsensus type per block:');
	blockchain.getChain().forEach((block, index) => {
		console.log(`Block ${index}: ${block.consensusType}`);
	});
}

// Run the test
testConsensusTransition();
