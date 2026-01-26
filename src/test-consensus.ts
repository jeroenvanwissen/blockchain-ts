import { Blockchain } from './blockchain/Blockchain.js';
import { POW_CUTOFF_BLOCK } from './config.js';

// Test script to demonstrate PoW to PoS transition
function testConsensusTransition() {
	// This is a fast-running demo script; enable test mode to skip block-time gating.
	process.env.NODE_ENV = 'test';

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

	// Mine enough blocks to reach the PoW cutoff (difficulty is low in test mode)
	console.log(`\nMining up to PoW cutoff (${POW_CUTOFF_BLOCK})...`);
	for (let i = 0; i < POW_CUTOFF_BLOCK; i++) {
		blockchain.minePendingTransactions(miner1);
	}

	// Before mining the first PoS block, miner1 needs to stake tokens
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

	// Mine next block (PoS)
	console.log('\nMining next block (PoS)...');
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
		const consensus = block.isProofOfStake() ? 'PoS' : 'PoW';
		console.log(`Block ${index}: ${consensus}`);
	});
}

// Run the test
testConsensusTransition();
